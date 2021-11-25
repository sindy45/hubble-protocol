const { expect } = require('chai');
const utils = require('./utils')

const {
    constants: { _1e6, _1e18, ZERO },
    assertions,
    getTradeDetails,
    setupContracts
} = utils

const TRADE_FEE = 0.000567 * _1e6

describe('Position Tests', async function() {
    beforeEach(async function() {
        signers = await ethers.getSigners()
        ;([ alice ] = signers.map(s => s.address))

        contracts = await setupContracts(TRADE_FEE)
        ;({ registry, marginAccount, marginAccountHelper, clearingHouse, amm, vusd, weth, usdc, swap } = contracts)

        // add margin
        margin = _1e6.mul(1000)
        await addMargin(signers[0], margin)
    })

    describe('single trader', async () => {
        it('long', async () => {
            const baseAssetQuantity = _1e18.mul(5)
            amount = _1e6.mul(5025) // ~5x leverage

            const tx = await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity /* long exactly */, amount /* max_dx */)
            ;({ quoteAsset, fee } = await getTradeDetails(tx, TRADE_FEE))
            // this asserts that long was executed at a price <= amount
            expect(quoteAsset.lte(amount)).to.be.true

            await assertions(contracts, alice, {
                size: baseAssetQuantity,
                openNotional: quoteAsset,
                notionalPosition: quoteAsset,
                unrealizedPnl: 0,
                margin: margin.sub(fee)
            })
            expect(await amm.longOpenInterestNotional()).to.eq(baseAssetQuantity)
            expect(await amm.shortOpenInterestNotional()).to.eq(ZERO)
            expect((await amm.lastPrice()).gt(_1e6.mul(1000))).to.be.true // rate increases after long

            const [ pos ] = await clearingHouse.userPositions(alice)
            expect(pos.size).to.eq(baseAssetQuantity)
            expect(pos.openNotional).to.eq(quoteAsset)
            expect(pos.unrealizedPnl).to.eq(0)
            expect(pos.avgOpen).to.eq(quoteAsset.mul(_1e18).div(baseAssetQuantity))
        })

        it('two longs', async () => {
            const baseAssetQuantity = _1e18.mul(4)
            amount = _1e6.mul(4050)

            let tx = await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity /* long exactly */, amount /* max_dx */)
            const trade1 = await getTradeDetails(tx, TRADE_FEE)

            const {
                marginFraction : expectedMarginFraction,
                quoteAssetQuantity
            } = await clearingHouse.expectedMarginFraction(alice, 0, baseAssetQuantity)

            const quote = await amm.getQuote(baseAssetQuantity)
            tx = await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity /* long exactly */, quote /* max_dx */)
            // tx = await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity /* long exactly */, amount /* max_dx */)
            const trade2 = await getTradeDetails(tx, TRADE_FEE)

            const quoteAsset = trade1.quoteAsset.add(trade2.quoteAsset)
            const fee = trade1.fee.add(trade2.fee)

            // this asserts that long was executed at a price <= amount
            expect(quoteAsset.lte(amount.mul(2))).to.be.true
            expect(await clearingHouse.getMarginFraction(alice)).to.eq(expectedMarginFraction)

            await assertions(contracts, alice, {
                size: baseAssetQuantity.mul(2),
                openNotional: quoteAsset,
                notionalPosition: quoteAsset.add(1), // due to rounding off error
                unrealizedPnl: 1, // due to rounding off error
                margin: margin.sub(fee)
            })
            expect(await amm.longOpenInterestNotional()).to.eq(baseAssetQuantity.mul(2))
            expect(await amm.shortOpenInterestNotional()).to.eq(ZERO)
        })

        it('short', async () => {
            const baseAssetQuantity = _1e18.mul(-5)
            amount = _1e6.mul(4975)

            let tx = await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity /* exact base asset */, amount /* min_dy */)
            ;({ quoteAsset, fee } = await getTradeDetails(tx, TRADE_FEE))

            // this asserts that short was executed at a price >= amount
            expect(quoteAsset.gte(amount)).to.be.true

            await assertions(contracts, alice, {
                size: baseAssetQuantity,
                openNotional: quoteAsset,
                notionalPosition: quoteAsset,
                unrealizedPnl: 0,
                margin: margin.sub(fee)
            })
            expect(await amm.longOpenInterestNotional()).to.eq(ZERO)
            expect(await amm.shortOpenInterestNotional()).to.eq(baseAssetQuantity.abs())
            expect((await amm.lastPrice()).lt(_1e6.mul(1000))).to.be.true // rate decreases after short

            const [ pos ] = await clearingHouse.userPositions(alice)
            expect(pos.size).to.eq(baseAssetQuantity)
            expect(pos.openNotional).to.eq(quoteAsset)
            expect(pos.unrealizedPnl).to.eq(0)
            expect(pos.avgOpen).to.eq(quoteAsset.mul(_1e18).div(baseAssetQuantity.mul(-1)))
        })

        it('two shorts', async () => {
            const baseAssetQuantity = _1e18.mul(-4)
            amount = _1e6.mul(3900)

            let tx = await clearingHouse.openPosition(0, baseAssetQuantity, amount)
            const trade1 = await getTradeDetails(tx, TRADE_FEE)

            const {
                marginFraction : expectedMarginFraction,
                quoteAssetQuantity
            } = await clearingHouse.expectedMarginFraction(alice, 0, baseAssetQuantity)

            const quote = await amm.getQuote(baseAssetQuantity)
            tx = await clearingHouse.openPosition(0, baseAssetQuantity, quote)
            const trade2 = await getTradeDetails(tx, TRADE_FEE)

            const quoteAsset = trade1.quoteAsset.add(trade2.quoteAsset)
            const fee = trade1.fee.add(trade2.fee)

            // this asserts that short was executed at a price >= amount
            expect(quoteAsset.gte(amount.mul(2))).to.be.true
            expect(trade2.quoteAsset).to.eq(quoteAssetQuantity)
            expect(await clearingHouse.getMarginFraction(alice)).to.eq(expectedMarginFraction)

            await assertions(contracts, alice, {
                size: baseAssetQuantity.mul(2),
                openNotional: quoteAsset,
                notionalPosition: quoteAsset,
                unrealizedPnl: 0,
                margin: margin.sub(fee)
            })
            expect(await amm.longOpenInterestNotional()).to.eq(ZERO)
            expect(await amm.shortOpenInterestNotional()).to.eq(baseAssetQuantity.mul(2).abs())
        })

        it('long + short', async () => {
            let baseAssetQuantity = _1e18.mul(5)

            let quote = await amm.getQuote(baseAssetQuantity)
            await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity /* long exactly */, quote /* max_dx */)

            baseAssetQuantity = baseAssetQuantity.mul(-1)
            quote = await amm.getQuote(baseAssetQuantity)
            await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity, quote /* min_dy */)

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

            let quote = await amm.getQuote(baseAssetQuantity)
            await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity /* exact base asset */, quote /* min_dy */)

            baseAssetQuantity = baseAssetQuantity.mul(-1)
            quote = await amm.getQuote(baseAssetQuantity)
            await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity /* long exactly */, quote /* max_dx */)

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

        it('long + bigger short + bigger long', async () => {
            // Long
            let baseAssetQuantity = _1e18.mul(5)
            let tx = await clearingHouse.openPosition(0, baseAssetQuantity, await amm.getQuote(baseAssetQuantity))

            const trade1 = await getTradeDetails(tx, TRADE_FEE)
            expect(await amm.longOpenInterestNotional()).to.eq(_1e18.mul(5))
            expect(await amm.shortOpenInterestNotional()).to.eq(ZERO)

            // Short
            baseAssetQuantity = _1e18.mul(-7)

            var {
                marginFraction : expectedMarginFraction,
                quoteAssetQuantity
            } = await clearingHouse.expectedMarginFraction(alice, 0, baseAssetQuantity)

            // tx = await clearingHouse.openPosition(0, baseAssetQuantity, 0)
            tx = await clearingHouse.openPosition(0, baseAssetQuantity, await amm.getQuote(baseAssetQuantity))

            const trade2 = await getTradeDetails(tx, TRADE_FEE)
            expect(await amm.longOpenInterestNotional()).to.eq(ZERO)
            expect(await amm.shortOpenInterestNotional()).to.eq(_1e18.mul(2))
            expect(await clearingHouse.getMarginFraction(alice)).to.eq(expectedMarginFraction)
            expect(trade2.quoteAsset).to.eq(quoteAssetQuantity)

            let fee = trade1.fee.add(trade2.fee)
            await assertions(contracts, alice, {
                size: _1e18.mul(-2), // 5 - 7
                unrealizedPnl: ZERO,
                margin: margin.sub(fee)
            })

            // Long
            baseAssetQuantity = _1e18.mul(10)
            ;({marginFraction : expectedMarginFraction, } = await clearingHouse.expectedMarginFraction(alice, 0, baseAssetQuantity))

            const quote = await amm.getQuote(baseAssetQuantity)
            tx = await clearingHouse.openPosition(0 /* amm index */, _1e18.mul(10) /* long exactly */, quote)
            // tx = await clearingHouse.openPosition(0 /* amm index */, _1e18.mul(10) /* long exactly */, _1e6.mul(10100))
            const trade3 = await getTradeDetails(tx, TRADE_FEE)
            fee = fee.add(trade3.fee)

            await assertions(contracts, alice, {
                size: _1e18.mul(8), // 5 - 7 + 10
                unrealizedPnl: 0,
                margin: margin.sub(fee)
            })
            expect(await amm.longOpenInterestNotional()).to.eq(_1e18.mul(8))
            expect(await amm.shortOpenInterestNotional()).to.eq(ZERO)
            expect(await clearingHouse.getMarginFraction(alice)).to.eq(expectedMarginFraction)
        })

        it('short + bigger long + bigger short', async () => {
            // Short
            let tx = await clearingHouse.openPosition(0 /* amm index */, _1e18.mul(-5) /* short exactly */, 0 /* short at any price */)
            const trade1 = await getTradeDetails(tx, TRADE_FEE)
            expect(await amm.longOpenInterestNotional()).to.eq(ZERO)
            expect(await amm.shortOpenInterestNotional()).to.eq(_1e18.mul(5))

            // Long
            tx = await clearingHouse.openPosition(0 /* amm index */, _1e18.mul(7) /* exact base asset */, _1e6.mul(7100))
            const trade2 = await getTradeDetails(tx, TRADE_FEE)
            expect(await amm.longOpenInterestNotional()).to.eq(_1e18.mul(2))
            expect(await amm.shortOpenInterestNotional()).to.eq(ZERO)

            let fee = trade1.fee.add(trade2.fee)

            await assertions(contracts, alice, {
                size: _1e18.mul(2), // -5 + 7
                unrealizedPnl: 0,
                margin: margin.sub(fee)
            })

            // Short
            tx = await clearingHouse.openPosition(0 /* amm index */, _1e18.mul(-10) /* long exactly */, 0)
            const trade3 = await getTradeDetails(tx, TRADE_FEE)
            fee = fee.add(trade3.fee)

            await assertions(contracts, alice, {
                size: _1e18.mul(-8), // -5 + 7 - 10
                unrealizedPnl: 0,
                margin: margin.sub(fee)
            })
            expect(await amm.longOpenInterestNotional()).to.eq(ZERO)
            expect(await amm.shortOpenInterestNotional()).to.eq(_1e18.mul(8))
        })

        it("open an empty position", async () => {
            await expect(clearingHouse.openPosition(0, 0, 0)).to.be.revertedWith('CH: baseAssetQuantity == 0')
            expect(await amm.longOpenInterestNotional()).to.eq(ZERO)
            expect(await amm.shortOpenInterestNotional()).to.eq(ZERO)
        })
    })

    describe('two traders', async () => {
        it('close a safe position', async () => {
            // alice shorts
            let tx = await clearingHouse.openPosition(0, _1e18.mul(-5), 0)
            const trade1 = await getTradeDetails(tx, TRADE_FEE)

            // bob longs
            const bob = signers[1]
            await addMargin(bob, margin)
            await clearingHouse.connect(bob).openPosition(0 /* amm index */, _1e18.mul(3) /* exact base asset */, ethers.constants.MaxUint256)

            expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.true

            ;({ unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(alice))
            expect(unrealizedPnl.lt(0)).to.be.true // loss

            tx = await clearingHouse.openPosition(0, _1e18.mul(5), _1e6.mul(5100))
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

            // bob is profitable
            ;({ unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(bob.address))
            expect(unrealizedPnl.gt(0)).to.be.true // profit
        })

        it('close a position which is slightly over maintenanceMarginRatio', async () => {
            // alice shorts
            let tx = await clearingHouse.openPosition(0, _1e18.mul(-5), 0)
            const trade1 = await getTradeDetails(tx, TRADE_FEE)

            // bob longs
            const bob = signers[1]
            await addMargin(bob, _1e6.mul(10000))
            await clearingHouse.connect(bob).openPosition(0, _1e18.mul(35), _1e6.mul(40000))

            // console.log((await clearingHouse.getMarginFraction(alice)).toString())
            expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.true

            ;({ unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(alice))
            expect(unrealizedPnl.lt(0)).to.be.true // loss

            tx = await clearingHouse.openPosition(0, _1e18.mul(5), _1e6.mul(100100))
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

            // bob is profitable
            ;({ unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(bob.address))
            expect(unrealizedPnl.gt(0)).to.be.true // profit
        })

        it('close an under collateral position', async () => {
            // alice shorts
            let tx = await clearingHouse.openPosition(0, _1e18.mul(-5), 0)
            const trade1 = await getTradeDetails(tx, TRADE_FEE)

            // bob longs
            const bob = signers[1]
            await addMargin(bob, _1e6.mul(20000))
            await clearingHouse.connect(bob).openPosition(0, _1e18.mul(70), _1e6.mul(73000))

            // console.log((await clearingHouse.getMarginFraction(alice)).toString())
            expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.false

            ;({ unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(alice))
            expect(unrealizedPnl.lt(0)).to.be.true // loss

            tx = await clearingHouse.openPosition(0, _1e18.mul(5), _1e6.mul(100100))
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

            // bob is profitable
            ;({ unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(bob.address))
            expect(unrealizedPnl.gt(0)).to.be.true // profit
        })

        it('liquidation', async () => {
            // alice shorts
            let tx = await clearingHouse.openPosition(0, _1e18.mul(-5), 0)
            const trade1 = await getTradeDetails(tx, TRADE_FEE)

            // bob longs
            const bob = signers[1]
            await addMargin(bob, _1e6.mul(20000))
            await clearingHouse.connect(bob).openPosition(0, _1e18.mul(70), _1e6.mul(73000))

            // console.log((await clearingHouse.getMarginFraction(alice)).toString())
            expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.false

            ;({ notionalPosition, unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(alice))
            expect(unrealizedPnl.lt(0)).to.be.true // loss

            // console.log(notionalPosition.toString())
            await clearingHouse.connect(signers[2]).liquidate(alice)

            const liquidationPenalty = notionalPosition.mul(5e4).div(_1e6)
            const toInsurance = liquidationPenalty.div(2)
            // console.log((await vusd.balanceOf(signers[2].address)).toString())
            expect(await vusd.balanceOf(signers[2].address)).to.eq(liquidationPenalty.sub(toInsurance)) // liquidation penalty
        })
    })

    describe('two amms', async function() {
        beforeEach(async function() {
            const ERC20Mintable = await ethers.getContractFactory('ERC20Mintable')
            const avax = await ERC20Mintable.deploy('avax', 'avax', 6)
            const secondAmm = await utils.setupAmm(
                alice,
                [ registry.address, avax.address, 'AVAX-Perp' ],
                65, // initialRate => avax = $65
                10000, // initialLiquidity = 10k avax
                false,
                1 // amm index
            )
            const markets = await clearingHouse.markets()
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

            const quote = await amm.getQuote(baseAssetQuantity)
            expect(quote.lte(amount)).to.be.true // this asserts that long was executed at a price <= amount

            // console.log({ quote: quote.toString() })
            const tx = await clearingHouse.openPosition(1 /* amm index */, baseAssetQuantity, quote /* max_dx */)
            ;({ quoteAsset, fee } = await getTradeDetails(tx, TRADE_FEE))

            await assertions(contracts, alice, {
                size: baseAssetQuantity,
                openNotional: quoteAsset,
                notionalPosition: quoteAsset,
                unrealizedPnl: 0,
                margin: margin.sub(fee)
            })
            expect(await amm.longOpenInterestNotional()).to.eq(baseAssetQuantity)
            expect(await amm.shortOpenInterestNotional()).to.eq(ZERO)
            expect((await amm.lastPrice()).gt(_1e6.mul(65))).to.be.true // rate increases after long

            const [ _, pos ] = await clearingHouse.userPositions(alice)
            expect(pos.size).to.eq(baseAssetQuantity)
            expect(pos.openNotional).to.eq(quoteAsset)
            expect(pos.unrealizedPnl).to.eq(0)
            expect(pos.avgOpen).to.eq(quoteAsset.mul(_1e18).div(baseAssetQuantity))
        })
    })

    async function addMargin(trader, margin) {
        await usdc.mint(trader.address, margin)
        await usdc.connect(trader).approve(marginAccountHelper.address, margin)
        await marginAccountHelper.connect(trader).addVUSDMarginWithReserve(margin)
    }
})
