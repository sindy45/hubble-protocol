const utils = require('./utils')
const { expect } = require('chai');

const {
    constants: { _1e6, _1e18, ZERO, feeSink },
    assertions,
    getTradeDetails,
    assertBounds,
    setupContracts,
    addMargin,
    setupRestrictedTestToken
} = utils

const TRADE_FEE = 0.000567 * _1e6

describe('Position Tests', async function() {
    beforeEach(async function() {
        signers = await ethers.getSigners()
        ;([ alice ] = signers.map(s => s.address))

        contracts = await setupContracts({ tradeFee: TRADE_FEE })
        ;({ registry, marginAccount, marginAccountHelper, clearingHouse, amm, vusd, weth, usdc, swap, hubbleViewer, oracle } = contracts)

        // add margin
        margin = _1e6.mul(2000)
        await addMargin(signers[0], margin)
        // add another collateral for liquidation price calculation
        await marginAccount.whitelistCollateral(weth.address, 0.8 * 1e6) // weight = 0.8
    })

    describe('single trader', async () => {
        it('long', async () => {
            const baseAssetQuantity = _1e18.mul(5)
            amount = _1e6.mul(5025) // ~2.5x leverage

            await expect(
                clearingHouse.openPosition2(0, _1e18.mul(11), ethers.constants.MaxUint256)
            ).to.be.revertedWith('CH: Below Minimum Allowable Margin') // max 5x leverage allowed
            const tx = await clearingHouse.openPosition2(0 /* amm index */, baseAssetQuantity /* long exactly */, amount /* max_dx */)
            ;({ quoteAsset, fee } = await getTradeDetails(tx, TRADE_FEE))
            // this asserts that long was executed at a price = amount
            expect(quoteAsset.eq(amount)).to.be.true

            await assertions(contracts, alice, {
                size: baseAssetQuantity,
                openNotional: quoteAsset,
                notionalPosition: quoteAsset,
                unrealizedPnl: ZERO,
                margin: margin.sub(fee)
            })
            expect(await vusd.balanceOf(feeSink)).to.eq(fee)
            expect(await amm.longOpenInterestNotional()).to.eq(baseAssetQuantity)
            expect(await amm.shortOpenInterestNotional()).to.eq(ZERO)
            expect(await amm.lastPrice()).to.eq(amount.mul(_1e18).div(baseAssetQuantity).abs())

            const [ pos ] = await hubbleViewer.userPositions(alice)
            expect(pos.size).to.eq(baseAssetQuantity)
            expect(pos.openNotional).to.eq(quoteAsset)
            expect(pos.unrealizedPnl).eq(ZERO)
            expect(pos.avgOpen).to.eq(quoteAsset.mul(_1e18).div(baseAssetQuantity))

            expect(await amm.getSnapshotLen()).to.eq(1)
            const latestSnapshot = await amm.reserveSnapshots(0)
            expect(latestSnapshot.lastPrice).to.eq(await amm.lastPrice())
        })

        it('two longs', async () => {
            const baseAssetQuantity = _1e18.mul(4)
            amount = _1e6.mul(4050)

            let tx = await clearingHouse.openPosition2(0 /* amm index */, baseAssetQuantity /* long exactly */, amount /* max_dx */)
            const trade1 = await getTradeDetails(tx, TRADE_FEE)

            const quote = await hubbleViewer.getQuote(baseAssetQuantity, 0)
            tx = await clearingHouse.openPosition2(0 /* amm index */, baseAssetQuantity /* long exactly */, quote /* max_dx */)
            const trade2 = await getTradeDetails(tx, TRADE_FEE)

            const quoteAsset = trade1.quoteAsset.add(trade2.quoteAsset)
            const fee = trade1.fee.add(trade2.fee)

            // this asserts that long was executed at a price = amount
            expect(quoteAsset.eq(amount.mul(2))).to.be.true

            await assertions(contracts, alice, {
                size: baseAssetQuantity.mul(2),
                openNotional: quoteAsset,
                margin: margin.sub(fee),
                notionalPosition: quoteAsset,
                unrealizedPnl: ZERO
            })
            expect(await vusd.balanceOf(feeSink)).to.eq(fee)
            expect(await amm.longOpenInterestNotional()).to.eq(baseAssetQuantity.mul(2))
            expect(await amm.shortOpenInterestNotional()).to.eq(ZERO)
        })

        it('short', async () => {
            const baseAssetQuantity = _1e18.mul(-5)
            amount = _1e6.mul(4975)

            await expect(
                clearingHouse.openPosition2(0, _1e18.mul(-11), 0)
            ).to.be.revertedWith('CH: Below Minimum Allowable Margin') // max 5x leverage allowed
            let tx = await clearingHouse.openPosition2(0 /* amm index */, baseAssetQuantity /* exact base asset */, amount /* min_dy */)
            ;({ quoteAsset, fee } = await getTradeDetails(tx, TRADE_FEE))

            // this asserts that short was executed at a price >= amount
            expect(quoteAsset.gte(amount)).to.be.true

            await assertions(contracts, alice, {
                size: baseAssetQuantity,
                openNotional: quoteAsset,
                margin: margin.sub(fee),
                notionalPosition: quoteAsset,
                unrealizedPnl: ZERO
            })
            expect(await vusd.balanceOf(feeSink)).to.eq(fee)
            expect(await amm.longOpenInterestNotional()).to.eq(ZERO)
            expect(await amm.shortOpenInterestNotional()).to.eq(baseAssetQuantity.abs())
            expect(await amm.lastPrice()).to.eq(amount.mul(_1e18).div(baseAssetQuantity).abs())

            const [ pos ] = await hubbleViewer.userPositions(alice)
            expect(pos.size).to.eq(baseAssetQuantity)
            expect(pos.openNotional).to.eq(quoteAsset)
            expect(pos.unrealizedPnl).eq(ZERO)
            expect(pos.avgOpen).to.eq(quoteAsset.mul(_1e18).div(baseAssetQuantity.mul(-1)))

            expect(await amm.getSnapshotLen()).to.eq(1)
            const latestSnapshot = await amm.reserveSnapshots(0)
            expect(latestSnapshot.lastPrice).to.eq(await amm.lastPrice())
        })

        it('two shorts', async () => {
            const baseAssetQuantity = _1e18.mul(-4)
            amount = _1e6.mul(3900)

            let tx = await clearingHouse.openPosition2(0, baseAssetQuantity, amount)
            const trade1 = await getTradeDetails(tx, TRADE_FEE)

            const quote = await hubbleViewer.getQuote(baseAssetQuantity, 0)
            tx = await clearingHouse.openPosition2(0, baseAssetQuantity, quote)
            const trade2 = await getTradeDetails(tx, TRADE_FEE)

            const quoteAsset = trade1.quoteAsset.add(trade2.quoteAsset)
            const fee = trade1.fee.add(trade2.fee)

            // this asserts that short was executed at a price = amount
            expect(quoteAsset.eq(amount.mul(2))).to.be.true
            expect(trade2.quoteAsset).to.eq(quote)

            await assertions(contracts, alice, {
                size: baseAssetQuantity.mul(2),
                openNotional: quoteAsset,
                notionalPosition: quoteAsset,
                unrealizedPnl: ZERO,
                margin: margin.sub(fee)
            })
            expect(await vusd.balanceOf(feeSink)).to.eq(fee)
            expect(await amm.longOpenInterestNotional()).to.eq(ZERO)
            expect(await amm.shortOpenInterestNotional()).to.eq(baseAssetQuantity.mul(2).abs())
        })

        it('long + short', async () => {
            let baseAssetQuantity = _1e18.mul(5)

            let quote = await hubbleViewer.getQuote(baseAssetQuantity, 0)
            await clearingHouse.openPosition2(0 /* amm index */, baseAssetQuantity /* long exactly */, quote /* max_dx */)

            baseAssetQuantity = baseAssetQuantity.mul(-1)

            await clearingHouse.openPosition2(0 /* amm index */, baseAssetQuantity, 0)

            await assertions(contracts, alice, {
                size: ZERO,
                openNotional: ZERO,
                notionalPosition: ZERO,
                unrealizedPnl: ZERO,
                marginFraction: ethers.constants.MaxInt256,
            })
            expect(await amm.longOpenInterestNotional()).to.eq(ZERO)
            expect(await amm.shortOpenInterestNotional()).to.eq(ZERO)
        })

        it('short + long', async () => {
            let baseAssetQuantity = _1e18.mul(-3)

            let quote = await hubbleViewer.getQuote(baseAssetQuantity, 0)
            await clearingHouse.openPosition2(0 /* amm index */, baseAssetQuantity /* exact base asset */, quote /* min_dy */)

            baseAssetQuantity = baseAssetQuantity.mul(-1)

            await clearingHouse.openPosition2(0 /* amm index */, baseAssetQuantity /* long exactly */, 0)

            await assertions(contracts, alice, {
                size: ZERO,
                openNotional: ZERO,
                notionalPosition: ZERO,
                unrealizedPnl: ZERO,
            })
            expect(await amm.longOpenInterestNotional()).to.eq(ZERO)
            expect(await amm.shortOpenInterestNotional()).to.eq(ZERO)
        })

        it('long + bigger short + bigger long', async () => {
            // Long
            let baseAssetQuantity = _1e18.mul(5)
            let tx = await clearingHouse.openPosition2(0, baseAssetQuantity, await hubbleViewer.getQuote(baseAssetQuantity, 0))

            const trade1 = await getTradeDetails(tx, TRADE_FEE)
            expect(await amm.longOpenInterestNotional()).to.eq(_1e18.mul(5))
            expect(await amm.shortOpenInterestNotional()).to.eq(ZERO)

            // Short
            baseAssetQuantity = _1e18.mul(-7)
            tx = await clearingHouse.openPosition2(0, baseAssetQuantity, await hubbleViewer.getQuote(baseAssetQuantity, 0))

            const trade2 = await getTradeDetails(tx, TRADE_FEE)
            expect(await amm.longOpenInterestNotional()).to.eq(ZERO)
            expect(await amm.shortOpenInterestNotional()).to.eq(_1e18.mul(2))

            let fee = trade1.fee.add(trade2.fee)
            await assertions(contracts, alice, {
                size: _1e18.mul(-2), // 5 - 7
                margin: margin.sub(fee),
                openNotional: trade2.quoteAsset.mul(2).div(7),
                notionalPosition: trade2.quoteAsset.mul(2).div(7),
                unrealizedPnl: ZERO
            })

            // Long
            baseAssetQuantity = _1e18.mul(10)

            const quote = await hubbleViewer.getQuote(baseAssetQuantity, 0)
            tx = await clearingHouse.openPosition2(0 /* amm index */, baseAssetQuantity /* long exactly */, quote)
            const trade3 = await getTradeDetails(tx, TRADE_FEE)
            fee = fee.add(trade3.fee)

            await assertions(contracts, alice, {
                size: _1e18.mul(8), // 5 - 7 + 10
                unrealizedPnl: ZERO,
                openNotional: trade3.quoteAsset.mul(8).div(10),
                notionalPosition: trade3.quoteAsset.mul(8).div(10),
                margin: margin.sub(fee)
            })
            expect(await vusd.balanceOf(feeSink)).to.eq(fee)
            expect(await amm.longOpenInterestNotional()).to.eq(_1e18.mul(8))
            expect(await amm.shortOpenInterestNotional()).to.eq(ZERO)
        })

        it('short + bigger long + bigger short', async () => {
            // Short
            let tx = await clearingHouse.openPosition2(0 /* amm index */, _1e18.mul(-5) /* short exactly */, 0 /* short at any price */)
            const trade1 = await getTradeDetails(tx, TRADE_FEE)
            expect(await amm.longOpenInterestNotional()).to.eq(ZERO)
            expect(await amm.shortOpenInterestNotional()).to.eq(_1e18.mul(5))

            // Long
            tx = await clearingHouse.openPosition2(0 /* amm index */, _1e18.mul(7) /* exact base asset */, _1e6.mul(7100))
            const trade2 = await getTradeDetails(tx, TRADE_FEE)
            expect(await amm.longOpenInterestNotional()).to.eq(_1e18.mul(2))
            expect(await amm.shortOpenInterestNotional()).to.eq(ZERO)

            let fee = trade1.fee.add(trade2.fee)

            await assertions(contracts, alice, {
                size: _1e18.mul(2), // -5 + 7
                unrealizedPnl: ZERO,
                openNotional: trade2.quoteAsset.mul(2).div(7),
                notionalPosition: trade2.quoteAsset.mul(2).div(7),
                margin: margin.sub(fee)
            })

            // Short
            tx = await clearingHouse.openPosition2(0 /* amm index */, _1e18.mul(-10) /* long exactly */, 0)
            const trade3 = await getTradeDetails(tx, TRADE_FEE)
            fee = fee.add(trade3.fee)

            await assertions(contracts, alice, {
                size: _1e18.mul(-8), // -5 + 7 - 10
                unrealizedPnl: ZERO,
                openNotional: trade3.quoteAsset.mul(8).div(10),
                notionalPosition: trade3.quoteAsset.mul(8).div(10),
                margin: margin.sub(fee)
            })
            expect(await vusd.balanceOf(feeSink)).to.eq(fee)
            expect(await amm.longOpenInterestNotional()).to.eq(ZERO)
            expect(await amm.shortOpenInterestNotional()).to.eq(_1e18.mul(8))
        })

        it("open an empty position", async () => {
            await expect(clearingHouse.openPosition2(0, 0, 0)).to.be.revertedWith('CH: baseAssetQuantity == 0')
            expect(await amm.longOpenInterestNotional()).to.eq(ZERO)
            expect(await amm.shortOpenInterestNotional()).to.eq(ZERO)
        })

        it('long + smaller short', async () => {
            const longBaseAssetQuantity = _1e18.mul(5)

            let quote = await hubbleViewer.getQuote(longBaseAssetQuantity, 0)
            let tx = await clearingHouse.openPosition2(0 /* amm index */, longBaseAssetQuantity /* long exactly */, quote /* max_dx */)
            const trade1 = await getTradeDetails(tx, TRADE_FEE)
            let fee = trade1.fee

            const shortBaseAssetQuantity = _1e18.mul(-1)

            quote = await hubbleViewer.getQuote(shortBaseAssetQuantity, 0)
            tx = await clearingHouse.openPosition2(0 /* amm index */, shortBaseAssetQuantity, quote /* min_dy */)
            const trade2 = await getTradeDetails(tx, TRADE_FEE)
            fee = fee.add(trade2.fee)
            quote = trade1.quoteAsset.sub(trade2.quoteAsset)

            await assertions(contracts, alice, {
                size: longBaseAssetQuantity.add(shortBaseAssetQuantity),
                openNotional: quote,
                notionalPosition: quote,
                unrealizedPnl: ZERO,
                margin: margin.sub(fee)
            })
            expect(await vusd.balanceOf(feeSink)).to.eq(fee)
            expect(await amm.longOpenInterestNotional()).to.eq(longBaseAssetQuantity.add(shortBaseAssetQuantity))
            expect(await amm.shortOpenInterestNotional()).to.eq(ZERO)
        })

        it('short + smaller long', async () => {
            const shortBaseAssetQuantity = _1e18.mul(-5)

            let quote = await hubbleViewer.getQuote(shortBaseAssetQuantity, 0)
            let tx = await clearingHouse.openPosition2(0, shortBaseAssetQuantity, quote)
            const trade1 = await getTradeDetails(tx, TRADE_FEE)
            let fee = trade1.fee

            const longBaseAssetQuantity = _1e18.mul(1)

            quote = await hubbleViewer.getQuote(longBaseAssetQuantity, 0)
            tx = await clearingHouse.openPosition2(0 /* amm index */, longBaseAssetQuantity, quote /* min_dy */)
            const trade2 = await getTradeDetails(tx, TRADE_FEE)
            fee = fee.add(trade2.fee)
            quote = trade1.quoteAsset.sub(trade2.quoteAsset)

            await assertions(contracts, alice, {
                size: longBaseAssetQuantity.add(shortBaseAssetQuantity),
                openNotional: quote,
                notionalPosition: quote,
                unrealizedPnl: ZERO,
                margin: margin.sub(fee)
            })
            expect(await vusd.balanceOf(feeSink)).to.eq(fee)
            expect(await amm.longOpenInterestNotional()).to.eq(ZERO)
            expect(await amm.shortOpenInterestNotional()).to.eq(longBaseAssetQuantity.add(shortBaseAssetQuantity).abs())
        })
    })

    describe('two traders', async () => {
        it('close a safe position', async () => {
            // alice shorts
            let tx = await clearingHouse.openPosition2(0, _1e18.mul(-5), 0)
            const trade1 = await getTradeDetails(tx, TRADE_FEE)

            // bob longs
            const bob = signers[1]
            const base = _1e18.mul(15)
            const price = _1e6.mul(1100)
            await addMargin(bob, base.mul(price).div(_1e18))
            await clearingHouse.connect(bob).openPosition2(0, base, base.mul(price).div(_1e18))

            expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.true

            ;({ unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(alice))
            expect(unrealizedPnl.lt(0)).to.be.true // loss

            tx = await clearingHouse.openPosition2(0, _1e18.mul(5), ethers.constants.MaxUint256)
            const trade2 = await getTradeDetails(tx, TRADE_FEE)

            let fee = trade1.fee.add(trade2.fee)

            expect(await marginAccount.getNormalizedMargin(alice)).to.eq(margin.add(unrealizedPnl).sub(fee))
            await assertions(contracts, alice, {
                size: ZERO,
                openNotional: ZERO,
                notionalPosition: ZERO,
                unrealizedPnl: ZERO,
                marginFraction: ethers.constants.MaxInt256,
            })
        })

        it('close a position which is slightly over maintenanceMarginRatio', async () => {
            // alice shorts
            let tx = await clearingHouse.openPosition2(0, _1e18.mul(-5), 0)
            const trade1 = await getTradeDetails(tx, TRADE_FEE)

            // bob longs
            const bob = signers[1]
            const base = _1e18.mul(15)
            const price = _1e6.mul(1250)
            await oracle.setUnderlyingPrice(weth.address, price)
            await addMargin(bob, base.mul(price).div(_1e18))
            await clearingHouse.connect(bob).openPosition2(0, base, base.mul(price).div(_1e18))

            // console.log((await clearingHouse.getMarginFraction(alice)).toString())
            expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.true

            ;({ unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(alice))
            expect(unrealizedPnl.lt(0)).to.be.true // loss

            tx = await clearingHouse.openPosition2(0, _1e18.mul(5), 0)
            const trade2 = await getTradeDetails(tx, TRADE_FEE)

            let fee = trade1.fee.add(trade2.fee)

            expect(await marginAccount.getNormalizedMargin(alice)).to.eq(margin.add(unrealizedPnl).sub(fee))
            await assertions(contracts, alice, {
                size: ZERO,
                openNotional: ZERO,
                notionalPosition: ZERO,
                unrealizedPnl: ZERO,
                marginFraction: ethers.constants.MaxInt256,
            })
        })

        it('close an under collateral position', async () => {
            // alice shorts
            let tx = await clearingHouse.openPosition2(0, _1e18.mul(-5), 0)
            const trade1 = await getTradeDetails(tx, TRADE_FEE)

            // bob longs
            const bob = signers[1]
            const base = _1e18.mul(15)
            const price = _1e6.mul(1300)
            await oracle.setUnderlyingPrice(weth.address, price)
            await addMargin(bob, base.mul(price).div(_1e18))
            await clearingHouse.connect(bob).openPosition2(0, base, base.mul(price).div(_1e18))

            // console.log((await clearingHouse.getMarginFraction(alice)).toString())
            expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.false

            ;({ unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(alice))
            expect(unrealizedPnl.lt(0)).to.be.true // loss

            tx = await clearingHouse.openPosition2(0, _1e18.mul(5), 0)
            const trade2 = await getTradeDetails(tx, TRADE_FEE)
            let fee = trade1.fee.add(trade2.fee)

            expect(await marginAccount.getNormalizedMargin(alice)).to.eq(margin.add(unrealizedPnl).sub(fee))
            await assertions(contracts, alice, {
                size: ZERO,
                openNotional: ZERO,
                notionalPosition: ZERO,
                unrealizedPnl: ZERO,
                marginFraction: ethers.constants.MaxInt256,
            })
        })

        it('liquidation', async () => {
            await amm.setLiquidationParams(1e6, 1e6)
            // alice shorts
            await clearingHouse.openPosition2(0, _1e18.mul(-5), 0)

            // bob longs
            const bob = signers[1]
            const base = _1e18.mul(15)
            const price = _1e6.mul(1300)
            await oracle.setUnderlyingPrice(weth.address, price)
            await addMargin(bob, base.mul(price).div(_1e18))
            await clearingHouse.connect(bob).openPosition2(0, base, base.mul(price).div(_1e18))

            expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.false

            ;({ notionalPosition, unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(alice))
            expect(unrealizedPnl.lt(0)).to.be.true // loss

            const feeSinkBalance = await vusd.balanceOf(feeSink)
            await clearingHouse.connect(signers[2]).liquidate2(alice)

            const liquidationPenalty = notionalPosition.mul(5e4).div(_1e6)
            expect(await vusd.balanceOf(feeSink)).to.eq(liquidationPenalty.add(feeSinkBalance)) // liquidation penalty
        })
    })

    describe('two amms', async function() {
        beforeEach(async function() {
            const avax = await setupRestrictedTestToken('avax', 'avax', 6)
            const secondAmm = await utils.setupAmm(
                alice,
                [ 'AVAX-PERP', avax.address, oracle.address, _1e18 ],
                {
                    index: 1,
                    initialRate: 65,
                    initialLiquidity: 1e4
                }
            )
            const markets = await hubbleViewer.markets()
            expect(markets[0].amm).to.eq(amm.address)
            expect(markets[0].underlying).to.eq(weth.address)
            expect(markets[1].amm).to.eq(secondAmm.amm.address)
            expect(markets[1].underlying).to.eq(avax.address)

            amm = secondAmm.amm
            contracts.amm = amm
        })

        it('long', async () => {
            const baseAssetQuantity = _1e18.mul(100) // 100 * 65 = 6500
            amount = _1e6.mul(1e4)

            const quote = await hubbleViewer.getQuote(baseAssetQuantity, 1)
            expect(quote.lte(amount)).to.be.true // this asserts that long was executed at a price <= amount

            // console.log({ quote: quote.toString() })
            const tx = await clearingHouse.openPosition2(1 /* amm index */, baseAssetQuantity, quote /* max_dx */)
            ;({ quoteAsset, fee } = await getTradeDetails(tx, TRADE_FEE))

            await assertions(contracts, alice, {
                size: baseAssetQuantity,
                openNotional: quoteAsset,
                notionalPosition: quoteAsset,
                unrealizedPnl: ZERO,
                margin: margin.sub(fee)
            })
            expect(await amm.longOpenInterestNotional()).to.eq(baseAssetQuantity)
            expect(await amm.shortOpenInterestNotional()).to.eq(ZERO)

            const [ _, pos ] = await hubbleViewer.userPositions(alice)
            expect(pos.size).to.eq(baseAssetQuantity)
            expect(pos.openNotional).to.eq(quoteAsset)
            expect(pos.unrealizedPnl).to.eq(ZERO)
            expect(pos.avgOpen).to.eq(quoteAsset.mul(_1e18).div(baseAssetQuantity))
        })
    })
})
