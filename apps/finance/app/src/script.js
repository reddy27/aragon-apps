import Aragon from '@aragon/api'
import { first } from 'rxjs/operators'
import { of } from 'rxjs'
import { getTestTokenAddresses } from './testnet'
import {
  ETHER_TOKEN_FAKE_ADDRESS,
  isTokenVerified,
  tokenDataFallback,
  getTokenSymbol,
  getTokenName,
} from './lib/token-utils'
import { addressesEqual } from './lib/web3-utils'
import tokenDecimalsAbi from './abi/token-decimals.json'
import tokenNameAbi from './abi/token-name.json'
import tokenSymbolAbi from './abi/token-symbol.json'
import vaultBalanceAbi from './abi/vault-balance.json'
import vaultGetInitializationBlockAbi from './abi/vault-getinitializationblock.json'
import vaultEventAbi from './abi/vault-events.json'

const tokenAbi = [].concat(tokenDecimalsAbi, tokenNameAbi, tokenSymbolAbi)
const vaultAbi = [].concat(
  vaultBalanceAbi,
  vaultGetInitializationBlockAbi,
  vaultEventAbi
)

const INITIALIZATION_TRIGGER = Symbol('INITIALIZATION_TRIGGER')
const TEST_TOKEN_ADDRESSES = []
const tokenContracts = new Map() // Addr -> External contract
const tokenDecimals = new Map() // External contract -> decimals
const tokenName = new Map() // External contract -> name
const tokenSymbols = new Map() // External contract -> symbol

const ETH_CONTRACT = Symbol('ETH_CONTRACT')

const app = new Aragon()

/*
 * Calls `callback` exponentially, everytime `retry()` is called.
 *
 * Usage:
 *
 * retryEvery(retry => {
 *  // do something
 *
 *  if (condition) {
 *    // retry in 1, 2, 4, 8 seconds… as long as the condition passes.
 *    retry()
 *  }
 * }, 1000, 2)
 *
 */
const retryEvery = (callback, initialRetryTimer = 1000, increaseFactor = 5) => {
  const attempt = (retryTimer = initialRetryTimer) => {
    // eslint-disable-next-line standard/no-callback-literal
    callback(() => {
      console.error(`Retrying in ${retryTimer / 1000}s...`)

      // Exponentially backoff attempts
      setTimeout(() => attempt(retryTimer * increaseFactor), retryTimer)
    })
  }
  attempt()
}

// Get the token address to initialize ourselves
retryEvery(retry => {
  app.call('vault').subscribe(
    vaultAddress => initialize(vaultAddress, ETHER_TOKEN_FAKE_ADDRESS),
    err => {
      console.error(
        'Could not start background script execution due to the contract not loading the token:',
        err
      )
      retry()
    }
  )
})

async function initialize(vaultAddress, ethAddress) {
  const vaultContract = app.external(vaultAddress, vaultAbi)

  const network = await app
    .network()
    .pipe(first())
    .toPromise()
  TEST_TOKEN_ADDRESSES.push(...getTestTokenAddresses(network.type))

  // Set up ETH placeholders
  tokenContracts.set(ethAddress, ETH_CONTRACT)
  tokenDecimals.set(ETH_CONTRACT, '18')
  tokenName.set(ETH_CONTRACT, 'Ether')
  tokenSymbols.set(ETH_CONTRACT, 'ETH')

  return createStore({
    network,
    ethToken: {
      address: ethAddress,
    },
    vault: {
      address: vaultAddress,
      contract: vaultContract,
    },
  })
}

// Hook up the script as an aragon.js store
async function createStore(settings) {
  let vaultInitializationBlock

  try {
    vaultInitializationBlock = await settings.vault.contract
      .getInitializationBlock()
      .toPromise()
  } catch (err) {
    console.error("Could not get attached vault's initialization block:", err)
  }

  return app.store(
    async (state, event) => {
      const { vault } = settings
      const { address: eventAddress, event: eventName } = event
      let nextState = {
        ...state,
      }

      if (eventName === INITIALIZATION_TRIGGER) {
        nextState = await initializeState(nextState, settings)
      } else if (addressesEqual(eventAddress, vault.address)) {
        // Vault event
        nextState = await vaultLoadBalance(nextState, event, settings)
      } else {
        // Finance event
        switch (eventName) {
          case 'ChangePeriodDuration':
            nextState.periodDuration = marshallDate(
              event.returnValues.newDuration
            )
            break
          case 'NewPeriod':
            // A new period is always started as part of the Finance app's initialization,
            // so this is just a handy way to get information about the app we're running
            // (e.g. its own address)
            nextState.proxyAddress = eventAddress
            nextState = await newPeriod(nextState, event, settings)
            break
          case 'NewTransaction':
            nextState = await newTransaction(nextState, event, settings)
            break
          default:
            break
        }
      }

      return nextState
    },
    [
      // Always initialize the store with our own home-made event
      of({ event: INITIALIZATION_TRIGGER }),
      // Handle Vault events in case they're not always controlled by this Finance app
      settings.vault.contract.events(vaultInitializationBlock),
    ]
  )
}

/***********************
 *                     *
 *   Event Handlers    *
 *                     *
 ***********************/

async function initializeState(state, settings) {
  const nextState = {
    ...state,
    periodDuration: marshallDate(
      await app.call('getPeriodDuration').toPromise()
    ),
    vaultAddress: settings.vault.address,
  }

  const withTestnetState = await loadTestnetState(nextState, settings)
  const withEthBalance = await loadEthBalance(withTestnetState, settings)
  return withEthBalance
}

async function vaultLoadBalance(state, { returnValues: { token } }, settings) {
  return {
    ...state,
    balances: await updateBalances(
      state,
      token || settings.ethToken.address,
      settings
    ),
  }
}

async function newPeriod(
  state,
  { returnValues: { periodId, periodStarts, periodEnds } }
) {
  return {
    ...state,
    periods: await updatePeriods(state, {
      id: periodId,
      startTime: marshallDate(periodStarts),
      endTime: marshallDate(periodEnds),
    }),
  }
}

async function newTransaction(
  state,
  { transactionHash, returnValues: { reference, transactionId } },
  settings
) {
  const transactionDetails = {
    ...(await loadTransactionDetails(transactionId)),
    reference,
    transactionHash,
    id: transactionId,
  }
  const transactions = await updateTransactions(state, transactionDetails)
  const balances = await updateBalances(
    state,
    transactionDetails.token,
    settings
  )

  return {
    ...state,
    balances,
    transactions,
  }
}

/***********************
 *                     *
 *       Helpers       *
 *                     *
 ***********************/

async function updateBalances({ balances = [] }, tokenAddress, settings) {
  const tokenContract = tokenContracts.has(tokenAddress)
    ? tokenContracts.get(tokenAddress)
    : app.external(tokenAddress, tokenAbi)
  tokenContracts.set(tokenAddress, tokenContract)

  const balancesIndex = balances.findIndex(({ address }) =>
    addressesEqual(address, tokenAddress)
  )
  if (balancesIndex === -1) {
    return balances.concat(
      await newBalanceEntry(tokenContract, tokenAddress, settings)
    )
  } else {
    const newBalances = Array.from(balances)
    newBalances[balancesIndex] = {
      ...balances[balancesIndex],
      amount: await loadTokenBalance(tokenAddress, settings),
    }
    return newBalances
  }
}

function updatePeriods({ periods = [] }, periodDetails) {
  const periodsIndex = periods.findIndex(({ id }) => id === periodDetails.id)
  if (periodsIndex === -1) {
    return periods.concat(periodDetails)
  } else {
    const newPeriods = Array.from(periods)
    newPeriods[periodsIndex] = periodDetails
    return newPeriods
  }
}

function updateTransactions({ transactions = [] }, transactionDetails) {
  const transactionsIndex = transactions.findIndex(
    ({ id }) => id === transactionDetails.id
  )
  if (transactionsIndex === -1) {
    return transactions.concat(transactionDetails)
  } else {
    const newTransactions = Array.from(transactions)
    newTransactions[transactionsIndex] = transactionDetails
    return newTransactions
  }
}

async function newBalanceEntry(tokenContract, tokenAddress, settings) {
  const [balance, decimals, name, symbol] = await Promise.all([
    loadTokenBalance(tokenAddress, settings),
    loadTokenDecimals(tokenContract, tokenAddress, settings),
    loadTokenName(tokenContract, tokenAddress, settings),
    loadTokenSymbol(tokenContract, tokenAddress, settings),
  ])

  return {
    decimals,
    name,
    symbol,
    address: tokenAddress,
    amount: balance,
    verified:
      isTokenVerified(tokenAddress, settings.network.type) ||
      addressesEqual(tokenAddress, settings.ethToken.address),
  }
}

async function loadEthBalance(state, settings) {
  return {
    ...state,
    balances: await updateBalances(state, settings.ethToken.address, settings),
  }
}

function loadTokenBalance(tokenAddress, { vault }) {
  return vault.contract.balance(tokenAddress).toPromise()
}

function loadTokenDecimals(tokenContract, tokenAddress, { network }) {
  return new Promise((resolve, reject) => {
    if (tokenDecimals.has(tokenContract)) {
      resolve(tokenDecimals.get(tokenContract))
    } else {
      const fallback =
        tokenDataFallback(tokenAddress, 'decimals', network.type) || '0'

      tokenContract.decimals().subscribe(
        (decimals = fallback) => {
          tokenDecimals.set(tokenContract, decimals)
          resolve(decimals)
        },
        () => {
          // Decimals is optional
          resolve(fallback)
        }
      )
    }
  })
}

function loadTokenName(tokenContract, tokenAddress, { network }) {
  return new Promise((resolve, reject) => {
    if (tokenName.has(tokenContract)) {
      resolve(tokenName.get(tokenContract))
    } else {
      const fallback =
        tokenDataFallback(tokenAddress, 'name', network.type) || ''
      const name = getTokenName(app, tokenAddress)
      resolve(name || fallback)
    }
  })
}

function loadTokenSymbol(tokenContract, tokenAddress, { network }) {
  return new Promise((resolve, reject) => {
    if (tokenSymbols.has(tokenContract)) {
      resolve(tokenSymbols.get(tokenContract))
    } else {
      const fallback =
        tokenDataFallback(tokenAddress, 'symbol', network.type) || ''
      const tokenSymbol = getTokenSymbol(app, tokenAddress)
      resolve(tokenSymbol || fallback)
    }
  })
}

function loadTransactionDetails(id) {
  return new Promise((resolve, reject) =>
    app
      .call('getTransaction', id)
      .subscribe(
        transaction => resolve(marshallTransactionDetails(transaction)),
        reject
      )
  )
}

function marshallTransactionDetails({
  amount,
  date,
  entity,
  isIncoming,
  paymentId,
  periodId,
  token,
}) {
  return {
    amount,
    entity,
    isIncoming,
    paymentId,
    periodId,
    token,
    date: marshallDate(date),
  }
}

function marshallDate(date) {
  // Represent dates as real numbers, as it's very unlikely they'll hit the limit...
  // Adjust for js time (in ms vs s)
  return parseInt(date, 10) * 1000
}

/**********************
 *                    *
 * RINKEBY TEST STATE *
 *                    *
 **********************/

function loadTestnetState(nextState, settings) {
  // Reload all the test tokens' balances for this DAO's vault
  return loadTestnetTokenBalances(nextState, settings)
}

async function loadTestnetTokenBalances(nextState, settings) {
  let reducedState = nextState
  for (const tokenAddress of TEST_TOKEN_ADDRESSES) {
    reducedState = {
      ...reducedState,
      balances: await updateBalances(reducedState, tokenAddress, settings),
    }
  }
  return reducedState
}
