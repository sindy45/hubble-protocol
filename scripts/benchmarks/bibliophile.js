const utils = require('../../test/utils')
const { addMargin } = require('../deploy/deployUtils')
const Exchange = require('../market-maker/exchange')

const {
    constants: { _1e6 },
    setupContracts,
    generateConfig,
    getTxOptions,
    sleep,
    txOptions
} = utils

const gasLimit = 5e6

const config = {
    Bibliophile: '0x0300000000000000000000000000000000000001',
    OrderBook: '0x0300000000000000000000000000000000000069',
    MarginAccount: '0x0300000000000000000000000000000000000070',
    ClearingHouse: '0x0300000000000000000000000000000000000071'
}

/**
 * After deployment
 * governance - signers[0]
 * signers[1], signers[2] have 1000 vUSD each
 */

async function main(setBiblioPhile) {
    signers = await ethers.getSigners()
    governance = signers[0].address
    ;([, alice, bob] = signers)

    // 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
    // console.log(signers[0].address, signers[1].address, signers[2].address)

    txOptions.nonce = await signers[0].getTransactionCount()
    // this is a hack for an interesting use-case
    // when we deploy an implementation contract (tx1) and subsequently the TransparentProxy (tx2), the gas estimation for tx2 might fail because the tx1 is not yet mined
    // however, if we pass the gasLimit here, the estimation is skipped and nonce makes sure that tx1 and then tx2 is mined
    txOptions.gasLimit = gasLimit

    const { marginAccountHelper, orderBook, oracle, clearingHouse } =  await setupContracts({
        governance,
        restrictedVUSD: false,
        genesisProxies: true,
        mockOrderBook: false,
        testClearingHouse: false,
        setupAMM: false
    })

    // whitelist evm address for order execution transactions
    await orderBook.setValidatorStatus(ethers.utils.getAddress('0x4Cf2eD3665F6bFA95cE6A11CFDb7A2EF5FC1C7E4'), true, getTxOptions())
    if (setBiblioPhile) {
        await clearingHouse.setBibliophile(config.Bibliophile, getTxOptions())
    }

    await addMargin(alice, _1e6.mul(40000), gasLimit)
    await addMargin(bob, _1e6.mul(40000), gasLimit)
    // await sleep(5)
    // console.log(JSON.stringify(await generateConfig(leaderboard.address, marginAccountHelper.address), null, 0))
}

async function setupAMM(name, initialRate, oracleAddress) {
    const ERC20Mintable = await ethers.getContractFactory('ERC20Mintable')
    const tok = await ERC20Mintable.deploy(`${name}-tok`, `${name}-tok`, 18, getTxOptions())
    governance = signers[0].address
    ;({ amm } = await _setupAmm(
        governance,
        [ name, tok.address, oracleAddress ],
        {
            initialRate,
            testAmm: false,
            whitelist: true,
            oracleAddress,
            minSize: utils.BigNumber.from(10).pow(17) // 0.1
        },
        true
    ))
    // console.log('deployed', name, amm.address)
}

async function _setupAmm(governance, args, ammOptions, slowMode) {
    const { initialRate, testAmm, whitelist, minSize, oracleAddress  } = ammOptions
    const AMM = await ethers.getContractFactory('AMM')
    const TransparentUpgradeableProxy = await ethers.getContractFactory('TransparentUpgradeableProxy')

    let admin = await ethers.provider.getStorageAt(config.OrderBook, '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103')

    const ammImpl = await AMM.deploy(config.ClearingHouse, getTxOptions())
    let constructorArguments = [
        ammImpl.address,
        ethers.utils.hexStripZeros(admin),
        ammImpl.interface.encodeFunctionData('initialize', args.concat([ minSize, governance ]))
    ]
    const ammProxy = await TransparentUpgradeableProxy.deploy(...constructorArguments, getTxOptions())
    await ammProxy.deployTransaction.wait()

    const amm = await ethers.getContractAt(testAmm ? 'TestAmm' : 'AMM', ammProxy.address)

    if (slowMode) {
        await sleep(3) // if the above txs aren't mined, read calls to amm fail
    }

    if (initialRate) {
        // amm.liftOff() needs the price for the underlying to be set
        // set index price within price spread
        const oracle = await ethers.getContractAt('TestOracle', oracleAddress)
        const underlyingAsset = await amm.underlyingAsset()
        await oracle.setUnderlyingTwapPrice(underlyingAsset, ethers.utils.parseUnits(initialRate.toString(), 6), getTxOptions())
        await oracle.setUnderlyingPrice(underlyingAsset, ethers.utils.parseUnits(initialRate.toString(), 6), getTxOptions())
    }

    if (whitelist) {
        const clearingHouse = await ethers.getContractAt('ClearingHouse', config.ClearingHouse)
        const orderBook = await ethers.getContractAt('OrderBook', config.OrderBook)
        await clearingHouse.whitelistAmm(amm.address, getTxOptions())
        await orderBook.initializeMinSize(minSize, getTxOptions())
    }

    return { amm }
}

async function execute(alice, bob) {
    if (!alice || !bob) {
        signers = await ethers.getSigners()
        ;([, alice, bob] = signers)
    }
    const exchange = new Exchange(ethers.provider)
    await exchange.createLimitOrder(alice, 0, 6, 2000)
    await exchange.createLimitOrder(bob, 0, -3, 1999)

    await sleep(5)
    const hb = await ethers.getContractAt('IHubbleBibliophile', '0x0300000000000000000000000000000000000001')
    console.log(await hb.getNotionalPositionAndMargin(alice.address, false, 0))
    console.log(await hb.getNotionalPositionAndMargin(bob.address, false, 0))

    // bibliophile is not updated yet
    const ch = await ethers.getContractAt('ClearingHouse', '0x0300000000000000000000000000000000000071')
    console.log(await ch.getNotionalPositionAndMargin(alice.address, false, 0))
    console.log(await ch.getNotionalPositionAndMargin(bob.address, false, 0))

    console.log(await ch.estimateGas.getNotionalPositionAndMargin(alice.address, true, 0))
    await ch.setBibliophile('0x0300000000000000000000000000000000000001')
    await sleep(3)
    console.log(await ch.estimateGas.getNotionalPositionAndMargin(alice.address, true, 0))
}

async function read() {
    signers = await ethers.getSigners()
    governance = signers[0].address
    ;([, alice, bob] = signers)

    const hb = await ethers.getContractAt('IHubbleBibliophile', '0x0300000000000000000000000000000000000001')
    console.log(await hb.getNotionalPositionAndMargin(alice.address, false, 0))
    console.log(await hb.getNotionalPositionAndMargin(bob.address, false, 0))
}

async function amms() {
    const ch = await ethers.getContractAt('ClearingHouse', config.ClearingHouse)
    const ma = await ethers.getContractAt('MarginAccount', config.MarginAccount)
    console.log(await ma.oracle(), await ch.getAmmsLength(), await ch.getAMMs())
}

async function runAnalytics() {
    signers = await ethers.getSigners()
    ;([, alice, bob] = signers)

    txOptions.nonce = await signers[0].getTransactionCount()
    txOptions.gasLimit = gasLimit

    const ch = await ethers.getContractAt('ClearingHouse', config.ClearingHouse)
    const ma = await ethers.getContractAt('MarginAccount', config.MarginAccount)
    const orderBook = await ethers.getContractAt('OrderBook', config.OrderBook)
    const oracle = await ma.oracle()

    // await ch.setBibliophile('0x0300000000000000000000000000000000000001', getTxOptions())
    // const b4events = await orderBook.queryFilter(orderBook.filters.OrdersMatched())
    // console.log('b4events', b4events.length)

    const amms = await ch.getAmmsLength()
    const exchange = new Exchange(ethers.provider)
    for (let i = 0; i < 10; i++) {
        // marketId = i
        marketId = amms.toNumber() + i
        console.log('deploying new amm')
        await setupAMM(`Market-${marketId}-Perp`, (marketId+1) * 10, oracle)
        await sleep(5)

        // const amms = await ch.getAmmsLength()
        // let marketId = amms.sub(1).toNumber()

        // console.log('sending orders in market-id', marketId)
        // alice and bob place an order in each market
        await exchange.createLimitOrder(alice, marketId, marketId+1, (marketId+1)*10)
        await exchange.createLimitOrder(bob, marketId, -(marketId+1), (marketId+1)*10)
        // console.log('orders sent')

        await sleep(3)
        // get the matched order tx
        // get all OrdersMatched events from orderbook contract
        const events = (await orderBook.queryFilter(orderBook.filters.OrdersMatched())).sort((a, b) => a.blockNumber - b.blockNumber)
        // console.log('events', events.length)
        const lastMatched = events[events.length - 1]
        // console.log('lastMatched', lastMatched)
        const r = await lastMatched.getTransactionReceipt()
        console.log({ markets: marketId+1, orderMatchedGas: r.gasUsed.toNumber() })
    }


}

async function compareValues(alice, bob) {
    if (!alice || !bob) {
        signers = await ethers.getSigners()
        ;([, alice, bob] = signers)
    }
    const hb = await ethers.getContractAt('IHubbleBibliophile', config.Bibliophile)
    console.log(await hb.getNotionalPositionAndMargin(alice.address, false, 0))
    console.log(await hb.getNotionalPositionAndMargin(bob.address, false, 0))

    const ch = await ethers.getContractAt('ClearingHouse', config.ClearingHouse)
    // await ch.setBibliophile('0x0300000000000000000000000000000000000001') // not needed with vanilla calls

    console.log(await ch.estimateGas.getNotionalPositionAndMarginVanilla(alice.address, false, 0))
    console.log(await ch.estimateGas.getNotionalPositionAndMarginVanilla(bob.address, false, 0))
}

main(false /* setBiblioPhile */)
// runAnalytics()
// compareValues()
.then(() => process.exit(0))
.catch(error => {
    console.error(error);
    process.exit(1);
});
