const { expect } = require('chai');

const { constants: { _1e6, _1e18, ZERO }, log, filterEvent, setupContracts } = require('./utils')
const TRADE_FEE = 0.000567 * _1e6

describe('Position Tests', function() {
    beforeEach('contract factories', async function() {
        signers = await ethers.getSigners()
        ;([ alice ] = signers.map(s => s.address))
        ;({ swap, marginAccount, clearingHouse, amm, vUSD, usdc } = await setupContracts(TRADE_FEE))

        // add margin
        margin = _1e6.mul(1000)
        await addMargin(signers[0], margin)
    })

    describe('single trader', async () => {
        it('long', async () => {
            const baseAssetQuantity = _1e18.mul(5)
            amount = _1e6.mul(5025) // ~5x leverage

            const tx = await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity /* long exactly */, amount /* max_dx */)
            ;({ quoteAsset, fee } = await getTradeDetails(tx))

            // this asserts that long was executed at a price <= amount
            expect(quoteAsset.lte(amount)).to.be.true

            await assertions(alice, {
                size: baseAssetQuantity,
                openNotional: quoteAsset,
                notionalPosition: quoteAsset,
                unrealizedPnl: 0,
                marginFractionNumerator: margin.sub(fee)
            })
        })

        it('two longs', async () => {
            const baseAssetQuantity = _1e18.mul(4)
            amount = _1e6.mul(4050)

            let tx = await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity /* long exactly */, amount /* max_dx */)
            const trade1 = await getTradeDetails(tx)

            tx = await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity /* long exactly */, amount /* max_dx */)
            const trade2 = await getTradeDetails(tx)

            const quoteAsset = trade1.quoteAsset.add(trade2.quoteAsset)
            const fee = trade1.fee.add(trade2.fee)

            // this asserts that long was executed at a price <= amount
            expect(quoteAsset.lte(amount.mul(2))).to.be.true

            await assertions(alice, {
                size: baseAssetQuantity.mul(2),
                openNotional: quoteAsset,
                notionalPosition: quoteAsset,
                unrealizedPnl: 0,
                marginFractionNumerator: margin.sub(fee)
            })
        })

        it('short', async () => {
            const baseAssetQuantity = _1e18.mul(-5)
            amount = _1e6.mul(4975)

            let tx = await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity /* exact base asset */, amount /* min_dy */)
            ;({ quoteAsset, fee } = await getTradeDetails(tx))

            // this asserts that short was executed at a price >= amount
            expect(quoteAsset.gte(amount)).to.be.true

            await assertions(alice, {
                size: baseAssetQuantity,
                openNotional: quoteAsset,
                notionalPosition: quoteAsset,
                unrealizedPnl: 0,
                marginFractionNumerator: margin.sub(fee)
            })
        })

        it('two shorts', async () => {
            const baseAssetQuantity = _1e18.mul(5)
            amount = _1e6.mul(4900)

            let tx = await clearingHouse.openPosition(0 /* amm index */, '-' + baseAssetQuantity /* exact base asset */, amount)
            const trade1 = await getTradeDetails(tx)

            tx = await clearingHouse.openPosition(0 /* amm index */, '-' + baseAssetQuantity /* exact base asset */, amount)
            const trade2 = await getTradeDetails(tx)

            const quoteAsset = trade1.quoteAsset.add(trade2.quoteAsset)
            const fee = trade1.fee.add(trade2.fee)

            // this asserts that short was executed at a price >= amount
            expect(quoteAsset.gte(amount.mul(2))).to.be.true

            await assertions(alice, {
                size: baseAssetQuantity.mul(-2),
                openNotional: quoteAsset,
                notionalPosition: quoteAsset.add(1), // anomaly: 1 more than expected, which leads to unrealizedPnl = -1
                unrealizedPnl: -1, // anomaly: ideally be 0
                marginFractionNumerator: margin.sub(fee).add(-1)
            })
        })

        it('long + short', async () => {
            const baseAssetQuantity = _1e18.mul(5)

            await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity /* long exactly */, ethers.constants.MaxUint256 /* max_dx */)
            await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity.mul(-1) /* exact base asset */, 0 /* min_dy */)

            await assertions(alice, {
                size: ZERO,
                openNotional: ZERO,
                notionalPosition: ZERO,
                unrealizedPnl: ZERO,
                marginFraction: ethers.constants.MaxInt256,
            })
        })

        it('short + long', async () => {
            const baseAssetQuantity = _1e18.mul(3)

            await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity.mul(-1) /* exact base asset */, 0 /* min_dy */)
            await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity /* long exactly */, ethers.constants.MaxUint256 /* max_dx */)

            await assertions(alice, {
                size: ZERO,
                openNotional: ZERO,
                notionalPosition: ZERO,
                unrealizedPnl: ZERO,
                marginFraction: ethers.constants.MaxInt256,
            })
        })

        it('long + bigger short + bigger long', async () => {
            // Long
            let tx = await clearingHouse.openPosition(0 /* amm index */, _1e18.mul(5) /* long exactly */, ethers.constants.MaxUint256 /* long at any price */)
            const trade1 = await getTradeDetails(tx)

            // Short
            tx = await clearingHouse.openPosition(0 /* amm index */, _1e18.mul(-7) /* exact base asset */, 0 /* short at any price */)
            const trade2 = await getTradeDetails(tx)

            let fee = trade1.fee.add(trade2.fee)

            await assertions(alice, {
                size: _1e18.mul(-2), // 5 - 7
                unrealizedPnl: ZERO,
                marginFractionNumerator: margin.sub(fee)
            })

            // Long
            tx = await clearingHouse.openPosition(0 /* amm index */, _1e18.mul(10) /* long exactly */, _1e6.mul(10100)) // long at <= 10100
            const trade3 = await getTradeDetails(tx)
            fee = fee.add(trade3.fee)

            await assertions(alice, {
                size: _1e18.mul(8), // 5 - 7 + 10
                unrealizedPnl: 0, // anomaly: ideally be 0
                marginFractionNumerator: margin.sub(fee).add(-1)
            })
        })

        it('short + bigger long + bigger short', async () => {
            // Short
            let tx = await clearingHouse.openPosition(0 /* amm index */, _1e18.mul(-5) /* short exactly */, 0 /* short at any price */)
            const trade1 = await getTradeDetails(tx)

            // Long
            tx = await clearingHouse.openPosition(0 /* amm index */, _1e18.mul(7) /* exact base asset */, _1e6.mul(7100))
            const trade2 = await getTradeDetails(tx)

            let fee = trade1.fee.add(trade2.fee)

            await assertions(alice, {
                size: _1e18.mul(2), // -5 + 7
                unrealizedPnl: 0,
                marginFractionNumerator: margin.sub(fee)
            })

            // Short
            tx = await clearingHouse.openPosition(0 /* amm index */, _1e18.mul(-10) /* long exactly */, 0)
            const trade3 = await getTradeDetails(tx)
            fee = fee.add(trade3.fee)

            await assertions(alice, {
                size: _1e18.mul(-8), // -5 + 7 - 10
                unrealizedPnl: 0,
                marginFractionNumerator: margin.sub(fee)
            })
        })

        it("open an empty position", async () => {
            await expect(clearingHouse.openPosition(0, 0, 0)).to.be.revertedWith('CH: baseAssetQuantity == 0')
        })

        it.skip('settleFunding', async function() {
            const underlyingTwapPrice = await amm.getUnderlyingTwapPrice(0)
            const twapPrice = await amm.getTwapPrice(0)
            const premium = await amm.callStatic.settleFunding()
            await amm.settleFunding()
            console.log({
                premium: premium.toString(),
                underlyingTwapPrice: underlyingTwapPrice.toString(),
                twapPrice: twapPrice.toString(),
                fundingRate: (await amm.fundingRate()).toString()
            })
            const normalizedMargin = await marginAccount.getNormalizedMargin(alice)
            console.log({ normalizedMargin: normalizedMargin.toString()})
            await clearingHouse.updatePositions(alice)
            // short position so margin should increase
            expect((await marginAccount.getNormalizedMargin(alice)).gt(normalizedMargin)).to.be.true
        })
    })

    describe('two traders', async () => {
        it('close a safe position', async () => {
            // alice shorts
            let tx = await clearingHouse.openPosition(0, _1e18.mul(-5), 0)
            const trade1 = await getTradeDetails(tx)

            // bob longs
            const bob = signers[1]
            await addMargin(bob, margin)
            await clearingHouse.connect(bob).openPosition(0 /* amm index */, _1e18.mul(3) /* exact base asset */, _1e6.mul(3100))

            // console.log((await clearingHouse.getMarginFraction(alice)).toString())
            expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.true

            ;({ unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(alice))
            expect(unrealizedPnl.lt(0)).to.be.true // loss

            tx = await clearingHouse.openPosition(0, _1e18.mul(5), _1e6.mul(5100))
            const trade2 = await getTradeDetails(tx)
            let fee = trade1.fee.add(trade2.fee)

            expect(await marginAccount.getNormalizedMargin(alice)).to.eq(margin.add(unrealizedPnl).sub(fee))
            await assertions(alice, {
                size: ZERO,
                openNotional: ZERO,
                notionalPosition: ZERO,
                unrealizedPnl: ZERO,
                marginFraction: ethers.constants.MaxInt256,
            })

            // bob is profitable
            ;({ unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(bob.address))
            expect(unrealizedPnl.gt(0)).to.be.true // profit
        })

        it('close a position which is slightly over maintenanceMarginRatio', async () => {
            // alice shorts
            let tx = await clearingHouse.openPosition(0, _1e18.mul(-5), 0)
            const trade1 = await getTradeDetails(tx)

            // bob longs
            const bob = signers[1]
            await addMargin(bob, _1e6.mul(10000))
            await clearingHouse.connect(bob).openPosition(0, _1e18.mul(35), _1e6.mul(40000))

            // console.log((await clearingHouse.getMarginFraction(alice)).toString())
            expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.true

            ;({ unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(alice))
            expect(unrealizedPnl.lt(0)).to.be.true // loss

            tx = await clearingHouse.openPosition(0, _1e18.mul(5), _1e6.mul(100100))
            const trade2 = await getTradeDetails(tx)
            let fee = trade1.fee.add(trade2.fee)

            expect(await marginAccount.getNormalizedMargin(alice)).to.eq(margin.add(unrealizedPnl).sub(fee))
            await assertions(alice, {
                size: ZERO,
                openNotional: ZERO,
                notionalPosition: ZERO,
                unrealizedPnl: ZERO,
                marginFraction: ethers.constants.MaxInt256,
            })

            // bob is profitable
            ;({ unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(bob.address))
            expect(unrealizedPnl.gt(0)).to.be.true // profit
        })

        it('close an under collateral position', async () => {
            // alice shorts
            let tx = await clearingHouse.openPosition(0, _1e18.mul(-5), 0)
            const trade1 = await getTradeDetails(tx)

            // bob longs
            const bob = signers[1]
            await addMargin(bob, _1e6.mul(10000))
            await clearingHouse.connect(bob).openPosition(0, _1e18.mul(45), _1e6.mul(50000))

            // console.log((await clearingHouse.getMarginFraction(alice)).toString())
            expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.false

            ;({ unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(alice))
            expect(unrealizedPnl.lt(0)).to.be.true // loss

            tx = await clearingHouse.openPosition(0, _1e18.mul(5), _1e6.mul(100100))
            const trade2 = await getTradeDetails(tx)
            let fee = trade1.fee.add(trade2.fee)

            expect(await marginAccount.getNormalizedMargin(alice)).to.eq(margin.add(unrealizedPnl).sub(fee))
            await assertions(alice, {
                size: ZERO,
                openNotional: ZERO,
                notionalPosition: ZERO,
                unrealizedPnl: ZERO,
                marginFraction: ethers.constants.MaxInt256,
            })

            // bob is profitable
            ;({ unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(bob.address))
            expect(unrealizedPnl.gt(0)).to.be.true // profit
        })
    })

    async function addMargin(trader, margin) {
        await usdc.mint(trader.address, margin)
        await usdc.connect(trader).approve(marginAccount.address, margin)
        await marginAccount.connect(trader).addUSDCMargin(margin)
    }
})

async function getTradeDetails(tx) {
    const positionOpenEvent = await filterEvent(tx, 'PositionOpened')
    return {
        quoteAsset: positionOpenEvent.args.quoteAsset,
        fee: positionOpenEvent.args.quoteAsset.mul(TRADE_FEE).div(_1e6)
    }
}

async function assertions(trader, vals, shouldLog) {
    const position = await amm.positions(trader)
    const { notionalPosition, unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(trader)
    const marginFraction = await clearingHouse.getMarginFraction(trader)

    if (shouldLog) {
        log(position, notionalPosition, unrealizedPnl, marginFraction)
    }

    if (vals.size != null) {
        expect(position.size).to.eq(vals.size)
    }
    if (vals.openNotional != null) {
        expect(position.openNotional).to.eq(vals.openNotional)
    }
    if (vals.notionalPosition != null) {
        expect(notionalPosition).to.eq(vals.notionalPosition)
    }
    if (vals.unrealizedPnl != null) {
        expect(unrealizedPnl).to.eq(vals.unrealizedPnl)
    }
    if (vals.marginFractionNumerator != null) {
        expect(marginFraction).to.eq(vals.marginFractionNumerator.mul(_1e6).div(notionalPosition))
    }
    if (vals.marginFraction != null) {
        expect(marginFraction).to.eq(vals.marginFraction)
    }

    return { position, notionalPosition, unrealizedPnl, marginFraction }
}
