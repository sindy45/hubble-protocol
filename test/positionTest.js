let { BigNumber } = require('ethers')
const fs = require('fs')
const { expect } = require('chai');

const _1e6 = BigNumber.from(10).pow(6)
const _1e18 = ethers.constants.WeiPerEther
const ZERO = BigNumber.from(0)

describe('Position Tests', function() {
    before('contract factories', async function() {
        signers = await ethers.getSigners()
        alice = signers[0].address
        let abiAndBytecode = fs.readFileSync('./vyper/MoonMath.txt').toString().split('\n').filter(Boolean)
        const MoonMath = new ethers.ContractFactory(JSON.parse(abiAndBytecode[0]), abiAndBytecode[1], signers[0])

        abiAndBytecode = fs.readFileSync('./vyper/Views.txt').toString().split('\n').filter(Boolean)
        const Views = new ethers.ContractFactory(JSON.parse(abiAndBytecode[0]), abiAndBytecode[1], signers[0])

        abiAndBytecode = fs.readFileSync('./vyper/Swap.txt').toString().split('\n').filter(Boolean)
        Swap = new ethers.ContractFactory(JSON.parse(abiAndBytecode[0]), abiAndBytecode[1], signers[0])

        ;([ ClearingHouse, AMM, MarginAccount, VUSD ] = await Promise.all([
            ethers.getContractFactory('ClearingHouse'),
            ethers.getContractFactory('AMM'),
            ethers.getContractFactory('MarginAccount'),
            ethers.getContractFactory('VUSD')
        ]))
        moonMath = await MoonMath.deploy()
        views = await Views.deploy(moonMath.address)
    })

    beforeEach('contract factories', async function() {
        swap = await Swap.deploy(
            "0xbabe61887f1de2713c6f97e567623453d3c79f67",
            moonMath.address,
            views.address,
            3645,
            "69999999999999",
            0,
            0,
            "2800000000000000",
            0,
            "1500000000000000",
            0,
            600,
            [_1e18.mul(40000) /* btc initial rate */, _1e18.mul(1000) /* eth initial rate */]
        )
        await swap.add_liquidity([
            _1e6.mul(_1e6), // 1m USDT
            _1e6.mul(100).mul(25), // 25 btc
            _1e18.mul(1000) // 1000 eth
        ], 0)
        // await swap.add_liquidity([
        //     _1e6.mul(_1e6).mul(_1e6), // 1m USDT
        //     _1e6.mul(100).mul(25), // 25 btc
        //     _1e18.mul(1000).mul(1000) // 1000 eth
        // ], 0)
        // await swap.exchange(0, 2, '100000000', 0)
        const vUSD = await VUSD.deploy()
        marginAccount = await MarginAccount.deploy(vUSD.address)
        clearingHouse = await ClearingHouse.deploy(marginAccount.address, 0.03 * 1e6) // 3% maintenance margin
        await marginAccount.setClearingHouse(clearingHouse.address)

        // whitelistAmm
        amm = await AMM.deploy(clearingHouse.address, swap.address)
        await clearingHouse.whitelistAmm(amm.address)

        // addCollateral
        const USDC = await ethers.getContractFactory('USDC')
        usdc = await USDC.deploy()
        await marginAccount.addCollateral(usdc.address, usdc.address /* dummy */)

        // addMargin
        margin = _1e6.mul(1000)
        await usdc.mint(alice, margin)
        await usdc.approve(marginAccount.address, margin)
        await marginAccount.addMargin(0, margin);
        // console.log((await marginAccount.getNormalizedMargin(alice)).toString())
    })

    it("long", async () => {
        amount = _1e6.mul(5000) // 5x leverage
        const baseAssetQuantity = _1e18.mul(4)

        await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity /* long atleast */, amount /* Exact quote asset */)

        const position = await amm.positions(alice)
        const { notionalPosition, unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(alice)
        const marginFraction = await clearingHouse.getMarginFraction(alice)

        log(position, notionalPosition, unrealizedPnl, marginFraction)
        expect(position.openNotional).to.eq(amount)
        expect(position.size.gte(baseAssetQuantity)).to.be.true
        // rounding in get_dx/get_dy needs to be taken care of for assertions on unrealizedPnl, notionalPosition and margin fraction
        expect(unrealizedPnl.toString()).to.eq('-1')
        expect(notionalPosition).to.eq(position.openNotional.add(unrealizedPnl))
        expect(marginFraction).to.eq(margin.add(unrealizedPnl).mul(_1e6).div(notionalPosition))
    })

    it("two longs", async () => {
        amount = _1e6.mul(5000) // 5x leverage
        const baseAssetQuantity = _1e18.div(100).mul(499)

        await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity /* long atleast */, amount /* Exact quote asset */)
        await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity /* long atleast */, amount /* Exact quote asset */)

        const position = await amm.positions(alice)
        const { notionalPosition, unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(alice)
        const marginFraction = await clearingHouse.getMarginFraction(alice)

        log(position, notionalPosition, unrealizedPnl, marginFraction)
        expect(position.openNotional).to.eq(amount.mul(2))
        expect(position.size.gte(baseAssetQuantity.mul(2))).to.be.true
        // rounding in get_dx/get_dy needs to be taken care of for assertions on unrealizedPnl, notionalPosition and margin fraction
        expect(unrealizedPnl.toString()).to.eq('-1')
        expect(notionalPosition).to.eq(position.openNotional.add(unrealizedPnl))
        expect(marginFraction).to.eq(margin.add(unrealizedPnl).mul(_1e6).div(notionalPosition))
    })

    it("short", async () => {
        const baseAssetQuantity = _1e18.mul(5)
        amount = _1e6.mul(4999).div(1000)

        await clearingHouse.openPosition(0 /* amm index */, '-' + baseAssetQuantity /* exact base asset */, amount)

        const position = await amm.positions(alice)
        const { notionalPosition, unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(alice)
        const marginFraction = await clearingHouse.getMarginFraction(alice)

        log(position, notionalPosition, unrealizedPnl, marginFraction)
        expect(position.size).to.eq('-' + baseAssetQuantity)
        expect(position.openNotional.gte(amount)).to.be.true
        // rounding in get_dx/get_dy needs to be taken care of for assertions on unrealizedPnl, notionalPosition and margin fraction
        expect(unrealizedPnl.toString()).to.eq('0')
        expect(notionalPosition).to.eq(position.openNotional.add(unrealizedPnl))
        expect(marginFraction).to.eq(margin.add(unrealizedPnl).mul(_1e6).div(notionalPosition))
    })

    it("two shorts", async () => {
        const baseAssetQuantity = _1e18.mul(5)
        amount = _1e6.mul(4999).div(1000)
        await clearingHouse.openPosition(0 /* amm index */, '-' + baseAssetQuantity /* exact base asset */, amount)
        await clearingHouse.openPosition(0 /* amm index */, '-' + baseAssetQuantity /* exact base asset */, amount)

        const position = await amm.positions(alice)
        const { notionalPosition, unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(alice)
        const marginFraction = await clearingHouse.getMarginFraction(alice)

        log(position, notionalPosition, unrealizedPnl, marginFraction)
        expect(position.size).to.eq('-' + baseAssetQuantity.mul(2))
        expect(position.openNotional.gte(amount.mul(2))).to.be.true
        // // rounding in get_dx/get_dy needs to be taken care of for assertions on unrealizedPnl, notionalPosition and margin fraction
        // expect(unrealizedPnl.toString()).to.eq('-1') // why does this become -1?
        expect(notionalPosition).to.eq(position.openNotional.sub(unrealizedPnl))
        expect(marginFraction).to.eq(margin.add(unrealizedPnl).mul(_1e6).div(notionalPosition))
    })

    it("two equal size but opposite side positions", async () => {
        amount = _1e6.mul(5000)

        await clearingHouse.openPosition(0 /* amm index */, 0 /* long atleast */, amount /* Exact quote asset */)

        let position = await amm.positions(alice)
        await clearingHouse.openPosition(0 /* amm index */, position.size.mul(-1) /* exact base asset */, 0)

        position = await amm.positions(alice)
        const { notionalPosition, unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(alice)
        const marginFraction = await clearingHouse.getMarginFraction(alice)
        log(position, notionalPosition, unrealizedPnl, marginFraction)

        expect(position.size).to.eq(ZERO)
        expect(notionalPosition).to.eq(ZERO)
        expect(unrealizedPnl).to.eq(ZERO)
        expect(marginFraction).to.eq(ethers.constants.MaxInt256)
        // expect(position.openNotional).to.eq(ZERO) // fails because openNotional = 1. Fix the rounding mess!
    })

    it("long + bigger short", async () => {
        amount = _1e6.mul(5000)

        await clearingHouse.openPosition(0 /* amm index */, 0 /* long atleast */, amount /* Exact quote asset */)

        let position = await amm.positions(alice)
        const size = position.size
        await clearingHouse.openPosition(0 /* amm index */, size.mul(-2) /* exact base asset */, 0)

        position = await amm.positions(alice)
        const { notionalPosition, unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(alice)
        const marginFraction = await clearingHouse.getMarginFraction(alice)
        log(position, notionalPosition, unrealizedPnl, marginFraction)

        expect(position.size).to.eq(size.mul(-1))
        // expect(notionalPosition).to.eq(ZERO)
        // expect(unrealizedPnl).to.eq(ZERO)
        // expect(marginFraction).to.eq(ethers.constants.MaxInt256)
        // expect(position.openNotional).to.eq(ZERO) // fails because openNotional = 1. Fix the rounding mess!
    })

    it.skip("short + bigger long", async () => {
        // need to sort out exchange.exactOut mess
    })
})

function log(position, notionalPosition, unrealizedPnl, marginFraction) {
    console.log({
        size: position.size.toString(),
        openNotional: position.openNotional.toString(),
        notionalPosition: notionalPosition.toString(),
        unrealizedPnl: unrealizedPnl.toString(),
        marginFraction: marginFraction.toString()
    })
}
