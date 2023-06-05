const assert = require('assert')
const utils = require('../../test/utils')
const { config, deployToken, setupAMM, addMargin } = require('../common')

const { Exchange } = require('../market-maker/exchange')

const {
    constants: { _1e6 },
    setupContracts,
    generateConfig,
    getTxOptions,
    sleep,
    txOptions
} = utils

const gasLimit = 5e6

/**
 * After deployment
 * governance - signers[0]
 * signers[1], signers[2] have deposited 40k hUSD each
 */

async function main(setBiblioPhile) {
    signers = await ethers.getSigners()
    governance = signers[0].address
    ;([, alice, bob] = signers)

    txOptions.nonce = await signers[0].getTransactionCount()
    // this is a hack for an interesting use-case
    // when we deploy an implementation contract (tx1) and subsequently the TransparentProxy (tx2), the gas estimation for tx2 might fail because the tx1 is not yet mined
    // however, if we pass the gasLimit here, the estimation is skipped and nonce makes sure that tx1 and then tx2 is mined
    txOptions.gasLimit = gasLimit

    const { orderBook, clearingHouse, marginAccount, hubbleViewer, marginAccountHelper } =  await setupContracts({
        governance,
        restrictedVUSD: false,
        genesisProxies: true,
        mockOrderBook: false,
        testClearingHouse: false,
        setupAMM: false
    })

    // calling setGenesisAdmin again on proxy will fail
    console.log('assert that calling setGenesisAdmin again on proxy will fail')
    const contracts = [ orderBook, marginAccount, clearingHouse ]
    for (let i = 0; i < contracts.length; i++) {
        const genesisTUP = await ethers.getContractAt('GenesisTUP', contracts[i].address)
        try {
            await genesisTUP.estimateGas.setGenesisAdmin(alice.address)
        } catch (e) {
            // console.log(e, Object.keys(e))
            assert.ok(e.error.toString().includes('ProviderError: execution reverted: already initialized'))
        }
    }

    const tasks = []
    if (setBiblioPhile) {
        tasks.push(orderBook.setBibliophile(config.Bibliophile, getTxOptions()))
        tasks.push(marginAccount.setBibliophile(config.Bibliophile, getTxOptions()))
        tasks.push(clearingHouse.setBibliophile(config.Bibliophile, getTxOptions()))
    }

    // whitelist evm address for order execution transactions
    const validators = [
        '0x4Cf2eD3665F6bFA95cE6A11CFDb7A2EF5FC1C7E4'
    ]
    validators.forEach(validator => {
        tasks.push(orderBook.setValidatorStatus(ethers.utils.getAddress(validator), true, getTxOptions()))
    })

    await Promise.all(tasks)

    await sleep(3)
    await addMargin(alice, _1e6.mul(40000))
    await addMargin(bob, _1e6.mul(40000))

    console.log(JSON.stringify(await generateConfig(hubbleViewer.address), null, 0))
}

async function addMarginAgain() {
    signers = await ethers.getSigners()
    ;([, alice, bob] = signers)

    const tx = await addMargin(alice, _1e6.mul(40000))
    console.log(await tx.wait())

    await addMargin(bob, _1e6.mul(40000))
    await sleep(3)
    await getAvailableMargin()
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
    const hb = await ethers.getContractAt('IHubbleBibliophile', '0x0300000000000000000000000000000000000003')
    console.log(await hb.getNotionalPositionAndMargin(alice.address, false, 0))
    console.log(await hb.getNotionalPositionAndMargin(bob.address, false, 0))

    // bibliophile is not updated yet
    const ch = await ethers.getContractAt('ClearingHouse', '0x0300000000000000000000000000000000000002')
    console.log(await ch.getNotionalPositionAndMargin(alice.address, false, 0))
    console.log(await ch.getNotionalPositionAndMargin(bob.address, false, 0))

    console.log(await ch.estimateGas.getNotionalPositionAndMargin(alice.address, true, 0))
    await ch.setBibliophile('0x0300000000000000000000000000000000000003')
    await sleep(3)
    console.log(await ch.estimateGas.getNotionalPositionAndMargin(alice.address, true, 0))
}

async function read() {
    signers = await ethers.getSigners()
    governance = signers[0].address
    ;([, alice, bob] = signers)

    const hb = await ethers.getContractAt('IHubbleBibliophile', '0x0300000000000000000000000000000000000003')
    console.log(await hb.getNotionalPositionAndMargin(alice.address, false, 0))
    console.log(await hb.getNotionalPositionAndMargin(bob.address, false, 0))
}

async function amms() {
    const ch = await ethers.getContractAt('ClearingHouse', config.ClearingHouse)
    const ma = await ethers.getContractAt('MarginAccount', config.MarginAccount)
    console.log(await ma.oracle(), await ch.getAmmsLength(), await ch.getAMMs())
}

async function getAvailableMargin() {
    signers = await ethers.getSigners()
    ;([, alice, bob] = signers)
    const ma = await ethers.getContractAt('MarginAccount', config.MarginAccount)

    console.log({
        alice: await ma.getAvailableMargin(alice.address),
        bob: await ma.getAvailableMargin(bob.address),
    })
}

async function runAnalytics() {
    signers = await ethers.getSigners()
    governance = signers[0].address
    ;([, alice, bob] = signers)

    txOptions.nonce = await signers[0].getTransactionCount()
    txOptions.gasLimit = gasLimit

    const ch = await ethers.getContractAt('ClearingHouse', config.ClearingHouse)
    const ma = await ethers.getContractAt('MarginAccount', config.MarginAccount)
    const orderBook = await ethers.getContractAt('OrderBook', config.OrderBook)
    const oracleAddress = await ma.oracle()

    // await ch.setBibliophile('0x0300000000000000000000000000000000000003', getTxOptions())
    // const b4events = await orderBook.queryFilter(orderBook.filters.OrdersMatched())
    // console.log('b4events', b4events.length)

    const amms = await ch.getAmmsLength()
    const exchange = new Exchange(ethers.provider)
    for (let i = 0; i < 10; i++) {
        // marketId = i
        marketId = amms.toNumber() + i
        // console.log('deploying new amm')
        const underlying = await deployToken(`tok-${marketId}`, `tok-${marketId}`, 18)
        const ammOptions = {
            governance,
            name: `Market-${marketId}-Perp`,
            underlyingAddress: underlying.address,
            initialRate: (marketId+1) * 10,
            oracleAddress,
            minSize: utils.BigNumber.from(10).pow(17), // 0.1
            testAmm: false,
            whitelist: true,
        }
        await setupAMM(ammOptions)

        // const amms = await ch.getAmmsLength()
        // let marketId = amms.sub(1).toNumber()

        console.log('sending orders in market-id', marketId)
        // alice and bob place an order in each market
        const tx1 = await (await exchange.createLimitOrder(alice, false, marketId, marketId+1, (marketId+1)*10)).wait()
        // console.log(tx1)
        const tx2 = await (await exchange.createLimitOrder(bob, false, marketId, -(marketId+1), (marketId+1)*10)).wait()
        // console.log('orders sent')

        await sleep(3)
        // get the matched order tx
        // get all OrdersMatched events from orderbook contract
        const events = (await orderBook.queryFilter(orderBook.filters.OrdersMatched())).sort((a, b) => a.blockNumber - b.blockNumber)
        // console.log('events', events.length)
        const lastMatched = events[events.length - 1]
        // console.log('lastMatched', lastMatched)
        const r = await lastMatched.getTransactionReceipt()
        console.log({
            markets: marketId+1,
            blockNumber: r.blockNumber,
            orderPlaced: Math.floor((tx1.gasUsed.toNumber() + tx2.gasUsed.toNumber())/2),
            orderMatchedGas: r.gasUsed.toNumber()
        })
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
    const ma = await ethers.getContractAt('MarginAccount', config.MarginAccount)
    // await ch.setBibliophile(config.Bibliophile) // not needed with vanilla calls
    // await ch.setBibliophile('0x0000000000000000000000000000000000000000') // not needed with vanilla calls
    // console.log(await ch.bibliophile())

    console.log('alice-getNotionalPositionAndMargin', await ch.getNotionalPositionAndMargin(alice.address, false, 0))
    console.log('bob-getNotionalPositionAndMargin', await ch.getNotionalPositionAndMargin(bob.address, false, 0))

    // estimate gas
    // console.log(await ch.estimateGas.getNotionalPositionAndMargin(alice.address, false, 0))
    // console.log(await ch.estimateGas.getNotionalPositionAndMarginVanilla(alice.address, false, 0))
    // console.log(await ch.estimateGas.getNotionalPositionAndMarginVanilla(bob.address, false, 0))
}

// main(true /* setBiblioPhile */)
runAnalytics()
// compareValues()
// addMarginAgain()
// getAvailableMargin()
.then(() => process.exit(0))
.catch(error => {
    console.error(error);
    process.exit(1);
});
