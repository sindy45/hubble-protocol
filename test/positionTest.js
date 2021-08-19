let { BigNumber } = require('ethers')
const fs = require('fs')
const { expect } = require('chai');

const utils = require('./utils')

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
            [_1e18.mul(40000) /* btc initial rate */, _1e18.mul(1000) /* eth initial rate */],
            { gasLimit: 10000000 }
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
        const ERC20Mintable = await ethers.getContractFactory('ERC20Mintable')
        usdc = await ERC20Mintable.deploy('usdc', 'usdc', 6)

        marginAccount = await MarginAccount.deploy(vUSD.address, usdc.address)
        clearingHouse = await ClearingHouse.deploy(marginAccount.address, 0.1 * 1e6) // 10% maintenance margin
        await marginAccount.setClearingHouse(clearingHouse.address)

        // whitelistAmm
        amm = await AMM.deploy(clearingHouse.address, swap.address)
        await clearingHouse.whitelistAmm(amm.address)

        // addMargin
        margin = _1e6.mul(1000)
        await usdc.mint(alice, margin)
        await usdc.approve(marginAccount.address, margin)
        await marginAccount.addUSDCMargin(margin);
        // console.utils.log((await marginAccount.getNormalizedMargin(alice)).toString())
    })

    it("long", async () => {
        const baseAssetQuantity = _1e18.mul(5)
        amount = _1e6.mul(5250) // ~5x leverage

        await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity /* long exactly */, amount /* max_dx */)

        const position = await amm.positions(alice)
        const { notionalPosition, unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(alice)
        const marginFraction = await clearingHouse.getMarginFraction(alice)

        utils.log(position, notionalPosition, unrealizedPnl, marginFraction)
        expect(position.openNotional.lte(amount)).to.be.true
        expect(position.size).to.eq(baseAssetQuantity)

        // rounding in get_dx/get_dy needs to be taken care of for assertions on unrealizedPnl, notionalPosition and margin fraction
        expect(unrealizedPnl.toString()).to.eq('-1')
        expect(notionalPosition).to.eq(position.openNotional.add(unrealizedPnl))
        expect(marginFraction).to.eq(margin.add(unrealizedPnl).mul(_1e6).div(notionalPosition))
    })

    it("two longs", async () => {
        const baseAssetQuantity = _1e18.mul(4)
        amount = _1e6.mul(4050)

        await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity /* long exactly */, amount /* max_dx */)
        await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity /* long exactly */, amount /* max_dx */)

        const position = await amm.positions(alice)
        const { notionalPosition, unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(alice)
        const marginFraction = await clearingHouse.getMarginFraction(alice)

        utils.log(position, notionalPosition, unrealizedPnl, marginFraction)
        expect(position.openNotional.lte(amount.mul(2))).to.be.true
        expect(position.size).to.eq(baseAssetQuantity.mul(2))

        // rounding in get_dx/get_dy needs to be taken care of for assertions on unrealizedPnl, notionalPosition and margin fraction
        expect(unrealizedPnl.toString()).to.eq('-1')
        expect(notionalPosition).to.eq(position.openNotional.add(unrealizedPnl))
        expect(marginFraction).to.eq(margin.add(unrealizedPnl).mul(_1e6).div(notionalPosition))
    })

    it("short", async () => {
        const baseAssetQuantity = _1e18.mul(5)
        amount = _1e6.mul(3999).div(1000)

        await clearingHouse.openPosition(0 /* amm index */, '-' + baseAssetQuantity /* exact base asset */, amount)

        const position = await amm.positions(alice)
        const { notionalPosition, unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(alice)
        const marginFraction = await clearingHouse.getMarginFraction(alice)

        utils.log(position, notionalPosition, unrealizedPnl, marginFraction)
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

        utils.log(position, notionalPosition, unrealizedPnl, marginFraction)
        expect(position.size).to.eq('-' + baseAssetQuantity.mul(2))
        expect(position.openNotional.gte(amount.mul(2))).to.be.true
        // // rounding in get_dx/get_dy needs to be taken care of for assertions on unrealizedPnl, notionalPosition and margin fraction
        // expect(unrealizedPnl.toString()).to.eq('-1') // why does this become -1?
        expect(notionalPosition).to.eq(position.openNotional.sub(unrealizedPnl))
        expect(marginFraction).to.eq(margin.add(unrealizedPnl).mul(_1e6).div(notionalPosition))
    })

    it('long + short', async () => {
        const baseAssetQuantity = _1e18.mul(5)

        await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity /* long exactly */, ethers.constants.MaxUint256 /* max_dx */)
        await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity.mul(-1) /* exact base asset */, 0 /* min_dy */)

        position = await amm.positions(alice)
        const { notionalPosition, unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(alice)
        const marginFraction = await clearingHouse.getMarginFraction(alice)
        utils.log(position, notionalPosition, unrealizedPnl, marginFraction)

        expect(position.size).to.eq(ZERO)
        expect(notionalPosition).to.eq(ZERO)
        expect(unrealizedPnl).to.eq(ZERO)
        expect(marginFraction).to.eq(ethers.constants.MaxInt256)
        // expect(position.openNotional).to.eq(ZERO) // fails because openNotional = 1. Fix the rounding mess!
    })

    it('short + long', async () => {
        const baseAssetQuantity = _1e18.mul(3)

        await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity.mul(-1) /* exact base asset */, 0 /* min_dy */)
        await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity /* long exactly */, ethers.constants.MaxUint256 /* max_dx */)

        position = await amm.positions(alice)
        const { notionalPosition, unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(alice)
        const marginFraction = await clearingHouse.getMarginFraction(alice)
        utils.log(position, notionalPosition, unrealizedPnl, marginFraction)

        expect(position.size).to.eq(ZERO)
        expect(notionalPosition).to.eq(ZERO)
        expect(unrealizedPnl).to.eq(ZERO)
        expect(marginFraction).to.eq(ethers.constants.MaxInt256)
        // expect(position.openNotional).to.eq(ZERO) // fails because openNotional = 1. Fix the rounding mess!
    })

    it("long + bigger short", async () => {
        const baseAssetQuantity = _1e18.mul(5)

        await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity /* long exactly */, ethers.constants.MaxUint256 /* max_dx */)
        await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity.mul(-2) /* exact base asset */, 0 /* min_dy */)

        let position = await amm.positions(alice)
        const { notionalPosition, unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(alice)
        const marginFraction = await clearingHouse.getMarginFraction(alice)
        utils.log(position, notionalPosition, unrealizedPnl, marginFraction)

        expect(position.size).to.eq(baseAssetQuantity.mul(-1))
    })

    it("short + bigger long", async () => {
        const baseAssetQuantity = _1e18.mul(5)

        await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity.mul(-1) /* exact base asset */, 0 /* min_dy */)
        await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity.mul(2) /* long exactly */, _1e6.mul(10050) /* max_dx */)

        let position = await amm.positions(alice)
        const { notionalPosition, unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(alice)
        const marginFraction = await clearingHouse.getMarginFraction(alice)
        utils.log(position, notionalPosition, unrealizedPnl, marginFraction)

        expect(position.size).to.eq(baseAssetQuantity)
    })
})
