const getBalance = require('@aragon/test-helpers/balance')(web3)
const getTransaction = require('@aragon/test-helpers/transaction')(web3)

const getContract = name => artifacts.require(name)
const getEvent = (receipt, event, arg) => { return receipt.logs.filter(l => l.event == event)[0].args[arg] }

contract('Payroll, overflow attack payday,', function(accounts) {
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

  it("tests partial payday with overflowing owed amount", async () => {
    let initialEthEmployee
    let initialAccruedValue

    const checkPayday = async (transaction, timePassed, amountRequested) => {
      // Check ETH
      const tx = await getTransaction(transaction.tx)
      const gasPrice = new web3.BigNumber(tx.gasPrice)
      const txFee = gasPrice.times(transaction.receipt.cumulativeGasUsed)
      const newEthEmployee = await getBalance(employee)
      const payedEth = amountRequested.times(etherExchangeRate).dividedToIntegerBy(ONE)
      const expectedEmployee = initialEthEmployee.plus(payedEth).minus(txFee)
      assert.equal(newEthEmployee.toString(), expectedEmployee.toString(), "Employee Eth Balance doesn't match")
    }

    // set max accrued value to max, so any salary addition would overflow
    const accruedValue = MAX_UINT256
    await payroll.addAccruedValue(employeeId, accruedValue)

    // determine allocation
    await payroll.determineAllocation([ETH], [100], {from: employee})

    initialEthEmployee = await getBalance(employee)
    const timePassed = await getTimePassed(payroll, employeeId)
    // call payday
    // request only up to actually owed salary, to avoid overflow
    const amountRequested = salary.times(timePassed)
    let transaction = await payroll.partialPayday(amountRequested, {from: employee})
    await checkPayday(transaction, timePassed, amountRequested)
  })
})
