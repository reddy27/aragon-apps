const getBalance = require('@aragon/test-helpers/balance')(web3)
const getTransaction = require('@aragon/test-helpers/transaction')(web3)

const getContract = name => artifacts.require(name)
const getEvent = (receipt, event, arg) => { return receipt.logs.filter(l => l.event == event)[0].args[arg] }

contract('Payroll, partial payday,', function(accounts) {
  const USD_DECIMALS = 18
  const USD_PRECISION = 10 ** USD_DECIMALS
  const SECONDS_IN_A_YEAR = 31557600 // 365.25 days
  const ONE = 1e18
  const ETH = "0x0"
  const rateExpiryTime = 1000
  const MAX_UINT256 = new web3.BigNumber(2).pow(256).minus(1)

  const [owner, employee] = accounts
  const {
    deployErc20TokenAndDeposit,
    addAllowedTokens,
    getTimePassed,
    redistributeEth,
    getDaoFinanceVault,
    initializePayroll
  } = require("./helpers.js")(owner)

  let salary = (new web3.BigNumber(10000)).times(USD_PRECISION).dividedToIntegerBy(SECONDS_IN_A_YEAR)

  let usdToken
  let erc20Token1
  let erc20Token1ExchangeRate
  const erc20Token1Decimals = 20
  let etherExchangeRate

  let payroll
  let payrollBase
  let priceFeed
  let employeeId
  let dao
  let finance
  let vault
  const nowMock = new Date().getTime()

  before(async () => {
    payrollBase = await getContract("PayrollMock").new()

    const daoAndFinance = await getDaoFinanceVault()

    dao = daoAndFinance.dao
    finance = daoAndFinance.finance
    vault = daoAndFinance.vault

    usdToken = await deployErc20TokenAndDeposit(owner, finance, vault, "USD", USD_DECIMALS)
    priceFeed = await getContract("PriceFeedMock").new()
    priceFeed.mockSetTimestamp(nowMock)

    // Deploy ERC 20 Tokens
    erc20Token1 = await deployErc20TokenAndDeposit(owner, finance, vault, "Token 1", erc20Token1Decimals)

    // get exchange rates
    erc20Token1ExchangeRate = (await priceFeed.get(usdToken.address, erc20Token1.address))[0]
    etherExchangeRate = (await priceFeed.get(usdToken.address, ETH))[0]

    // make sure owner and Payroll have enough funds
    await redistributeEth(accounts, finance)
  })

  beforeEach(async () => {
    payroll = await initializePayroll(
      dao,
      payrollBase,
      finance,
      usdToken,
      priceFeed,
      rateExpiryTime
    )

    await payroll.mockSetTimestamp(nowMock)

    // adds allowed tokens
    await addAllowedTokens(payroll, [usdToken, erc20Token1])

    const startDate = parseInt(await payroll.getTimestampPublic.call(), 10) - 2628005 // now minus 1/12 year
    // add employee
    const receipt = await payroll.addEmployee(employee, salary, "Kakaroto", 'Saiyajin', startDate)

    employeeId = getEvent(receipt, 'AddEmployee', 'employeeId')
  })

  it("tests partial payday", async () => {
    let usdTokenAllocation = 50
    let erc20Token1Allocation = 20
    let ethAllocation = 100 - usdTokenAllocation - erc20Token1Allocation
    let initialEthPayroll
    let initialUsdTokenPayroll
    let initialErc20Token1Payroll
    let initialEthEmployee
    let initialUsdTokenEmployee
    let initialErc20Token1Employee
    let initialAccruedValue

    const setInitialBalances = async () => {
      initialEthPayroll = await getBalance(vault.address)
      initialEthEmployee = await getBalance(employee)
      // Token initial balances
      initialUsdTokenPayroll = await usdToken.balanceOf(vault.address)
      initialErc20Token1Payroll = await erc20Token1.balanceOf(vault.address)
      initialUsdTokenEmployee = await usdToken.balanceOf(employee)
      initialErc20Token1Employee = await erc20Token1.balanceOf(employee)
      initialAccruedValue = (await payroll.getEmployee(employeeId))[2]
    }

    const checkTokenBalances = async (token, payed, initialBalancePayroll, initialBalanceEmployee, exchangeRate, allocation, name='') => {
      let payedToken = payed.times(exchangeRate).times(allocation).dividedToIntegerBy(100).dividedToIntegerBy(ONE)
      let expectedPayroll = initialBalancePayroll.minus(payedToken)
      let expectedEmployee = initialBalanceEmployee.plus(payedToken)
      let newBalancePayroll
      let newBalanceEmployee
      newBalancePayroll = await token.balanceOf(vault.address)
      newBalanceEmployee = await token.balanceOf(employee)
      assert.equal(newBalancePayroll.toString(), expectedPayroll.toString(), "Payroll balance of Token " + name + " doesn't match")
      assert.equal(newBalanceEmployee.toString(), expectedEmployee.toString(), "Employee balance of Token " + name + " doesn't match")
    }

    const checkPayday = async (transaction, timePassed, amountRequested=0) => {
      // Check ETH
      const tx = await getTransaction(transaction.tx)
      const gasPrice = new web3.BigNumber(tx.gasPrice)
      const txFee = gasPrice.times(transaction.receipt.cumulativeGasUsed)
      const newEthPayroll = await getBalance(vault.address)
      const newEthEmployee = await getBalance(employee)
      const owed = salary.times(timePassed).plus(initialAccruedValue)
      let payed
      if (amountRequested > 0) {
        payed = amountRequested
      } else {
        payed = owed
      }
      const payedEth = payed.times(etherExchangeRate).times(ethAllocation).dividedToIntegerBy(100).dividedToIntegerBy(ONE)
      const expectedPayroll = initialEthPayroll.minus(payedEth)
      const expectedEmployee = initialEthEmployee.plus(payedEth).minus(txFee)
      assert.equal(newEthPayroll.toString(), expectedPayroll.toString(), "Payroll Eth Balance doesn't match")
      assert.equal(newEthEmployee.toString(), expectedEmployee.toString(), "Employee Eth Balance doesn't match")
      // Check Tokens
      await checkTokenBalances(usdToken, payed, initialUsdTokenPayroll, initialUsdTokenEmployee, ONE, usdTokenAllocation, "USD")
      await checkTokenBalances(erc20Token1, payed, initialErc20Token1Payroll, initialErc20Token1Employee, erc20Token1ExchangeRate, erc20Token1Allocation, "ERC20 1")
      // remaining accrued balance
      if (amountRequested > 0) {
        assert.equal((await payroll.getEmployee(employeeId))[2].toString(), owed.minus(amountRequested).toString())
      } else {
        assert.equal((await payroll.getEmployee(employeeId))[2].toString(), 0)
      }
    }

    // determine allocation
    await payroll.determineAllocation([ETH, usdToken.address, erc20Token1.address], [ethAllocation, usdTokenAllocation, erc20Token1Allocation], {from: employee})
    await setInitialBalances()
    const timePassed = await getTimePassed(payroll, employeeId)
    // call payday
    const amountRequested = salary.times(timePassed).dividedToIntegerBy(2)
    let transaction = await payroll.partialPayday(amountRequested, {from: employee})
    await checkPayday(transaction, timePassed, amountRequested)

    // check that we can call payday again after some time
    // set time forward, 1 month
    const timePassed2 = 2678400
    await payroll.mockAddTimestamp(timePassed2)
    // we need to forward time in price feed, or rate will be obsolete
    await priceFeed.mockAddTimestamp(timePassed2)
    await setInitialBalances()
    // call payday again
    let transaction2 = await payroll.payday({from: employee})
    await checkPayday(transaction2, timePassed2)
  })
})
