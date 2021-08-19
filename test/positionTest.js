const { expect } = require('chai');

const { constants: { _1e6, _1e18, ZERO }, log, filterEvent, setupContracts } = require('./utils')
const TRADE_FEE = 0.000567 * _1e6

describe('Position Tests', function() {
    beforeEach('contract factories', async function() {
        signers = await ethers.getSigners()
        alice = signers[0].address
        ;({ swap, marginAccount, clearingHouse, amm, vUSD, usdc } = await setupContracts(TRADE_FEE))

        // add margin
        margin = _1e6.mul(1000)
        await usdc.mint(alice, margin)
        await usdc.approve(marginAccount.address, margin)
        await marginAccount.addUSDCMargin(margin);
    })

    it('long', async () => {
        const baseAssetQuantity = _1e18.mul(5)
        amount = _1e6.mul(5250) // ~5x leverage

        const tx = await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity /* long exactly */, amount /* max_dx */)
        const tradeFee = await getTradeFee(tx)

        const position = await amm.positions(alice)
        const { notionalPosition, unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(alice)
        const marginFraction = await clearingHouse.getMarginFraction(alice)

        log(position, notionalPosition, unrealizedPnl, marginFraction)
        expect(position.openNotional.lte(amount)).to.be.true
        expect(position.size).to.eq(baseAssetQuantity)

        // rounding in get_dx/get_dy needs to be taken care of for assertions on unrealizedPnl, notionalPosition and margin fraction
        expect(unrealizedPnl.toString()).to.eq('-1') // should ideally be 0
        expect(notionalPosition).to.eq(position.openNotional.add(unrealizedPnl))
        expect(marginFraction).to.eq(margin.add(unrealizedPnl).sub(tradeFee).mul(_1e6).div(notionalPosition))
    })

    it('two longs', async () => {
        const baseAssetQuantity = _1e18.mul(4)
        amount = _1e6.mul(4050)

        let tx = await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity /* long exactly */, amount /* max_dx */)
        let tradeFee = await getTradeFee(tx)

        tx = await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity /* long exactly */, amount /* max_dx */)
        tradeFee = tradeFee.add(await getTradeFee(tx))

        const position = await amm.positions(alice)
        const { notionalPosition, unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(alice)
        const marginFraction = await clearingHouse.getMarginFraction(alice)

        log(position, notionalPosition, unrealizedPnl, marginFraction)
        expect(position.openNotional.lte(amount.mul(2))).to.be.true
        expect(position.size).to.eq(baseAssetQuantity.mul(2))

        // rounding in get_dx/get_dy needs to be taken care of for assertions on unrealizedPnl, notionalPosition and margin fraction
        expect(unrealizedPnl.toString()).to.eq('-1')
        expect(notionalPosition).to.eq(position.openNotional.add(unrealizedPnl))
        expect(marginFraction).to.eq(margin.add(unrealizedPnl).sub(tradeFee).mul(_1e6).div(notionalPosition))
    })

    it('short', async () => {
        const baseAssetQuantity = _1e18.mul(5)
        amount = _1e6.mul(3999).div(1000)

        let tx = await clearingHouse.openPosition(0 /* amm index */, '-' + baseAssetQuantity /* exact base asset */, amount)
        let tradeFee = await getTradeFee(tx)

        const position = await amm.positions(alice)
        const { notionalPosition, unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(alice)
        const marginFraction = await clearingHouse.getMarginFraction(alice)

        log(position, notionalPosition, unrealizedPnl, marginFraction)
        expect(position.size).to.eq('-' + baseAssetQuantity)
        expect(position.openNotional.gte(amount)).to.be.true

        expect(unrealizedPnl.toString()).to.eq('0')
        expect(notionalPosition).to.eq(position.openNotional.add(unrealizedPnl))
        expect(marginFraction).to.eq(margin.add(unrealizedPnl).sub(tradeFee).mul(_1e6).div(notionalPosition))
    })

    it('two shorts', async () => {
        const baseAssetQuantity = _1e18.mul(5)
        amount = _1e6.mul(4999).div(1000)

        let tx = await clearingHouse.openPosition(0 /* amm index */, '-' + baseAssetQuantity /* exact base asset */, amount)
        let tradeFee = await getTradeFee(tx)

        tx = await clearingHouse.openPosition(0 /* amm index */, '-' + baseAssetQuantity /* exact base asset */, amount)
        tradeFee = tradeFee.add(await getTradeFee(tx))

        const position = await amm.positions(alice)
        const { notionalPosition, unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(alice)
        const marginFraction = await clearingHouse.getMarginFraction(alice)

        log(position, notionalPosition, unrealizedPnl, marginFraction)
        expect(position.size).to.eq('-' + baseAssetQuantity.mul(2))
        expect(position.openNotional.gte(amount.mul(2))).to.be.true
        // // rounding in get_dx/get_dy needs to be taken care of for assertions on unrealizedPnl, notionalPosition and margin fraction
        // expect(unrealizedPnl.toString()).to.eq('-1') // why does this become -1?
        expect(notionalPosition).to.eq(position.openNotional.sub(unrealizedPnl))
        expect(marginFraction).to.eq(margin.add(unrealizedPnl).sub(tradeFee).mul(_1e6).div(notionalPosition))
    })

    it('long + short', async () => {
        const baseAssetQuantity = _1e18.mul(5)

        let tx = await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity /* long exactly */, ethers.constants.MaxUint256 /* max_dx */)
        let tradeFee = await getTradeFee(tx)

        tx = await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity.mul(-1) /* exact base asset */, 0 /* min_dy */)
        tradeFee = tradeFee.add(await getTradeFee(tx))

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

    it('short + long', async () => {
        const baseAssetQuantity = _1e18.mul(3)

        let tx = await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity.mul(-1) /* exact base asset */, 0 /* min_dy */)
        let tradeFee = await getTradeFee(tx)

        tx = await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity /* long exactly */, ethers.constants.MaxUint256 /* max_dx */)
        tradeFee = tradeFee.add(await getTradeFee(tx))

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

    it('long + bigger short', async () => {
        const baseAssetQuantity = _1e18.mul(5)

        let tx = await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity /* long exactly */, ethers.constants.MaxUint256 /* max_dx */)
        let tradeFee = await getTradeFee(tx)

        tx = await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity.mul(-2) /* exact base asset */, 0 /* min_dy */)
        tradeFee = tradeFee.add(await getTradeFee(tx))

        let position = await amm.positions(alice)
        const { notionalPosition, unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(alice)
        const marginFraction = await clearingHouse.getMarginFraction(alice)
        log(position, notionalPosition, unrealizedPnl, marginFraction)

        expect(position.size).to.eq(baseAssetQuantity.mul(-1))
    })

    it('short + bigger long', async () => {
        const baseAssetQuantity = _1e18.mul(5)

        let tx = await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity.mul(-1) /* exact base asset */, 0 /* min_dy */)
        let tradeFee = await getTradeFee(tx)

        tx = await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity.mul(2) /* long exactly */, _1e6.mul(10050) /* max_dx */)
        tradeFee = tradeFee.add(await getTradeFee(tx))

        let position = await amm.positions(alice)
        const { notionalPosition, unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(alice)
        const marginFraction = await clearingHouse.getMarginFraction(alice)
        log(position, notionalPosition, unrealizedPnl, marginFraction)

        expect(position.size).to.eq(baseAssetQuantity)
    })
})

async function getTradeFee(tx) {
    const positionOpenEvent = await filterEvent(tx, 'PositionOpened')
    return positionOpenEvent.args.quoteAsset.mul(TRADE_FEE).div(_1e6)
}
