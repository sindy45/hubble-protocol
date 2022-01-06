const { expect } = require('chai');
const utils = require('./utils')

const {
    constants: { _1e6, _1e12, _1e18, ZERO },
    getTradeDetails,
    setupContracts,
    addMargin,
    assertions,
    gotoNextFundingTime,
    getTwapPrice,
    parseRawEvent
} = utils

const DEFAULT_TRADE_FEE = 0.0005 * 1e6 /* 0.05% */

describe('Maker Tests', async function() {
    describe('Single Maker', async function() {
        before(async function() {
            signers = await ethers.getSigners()
            ;([ alice ] = signers.map(s => s.address))

            contracts = await setupContracts(DEFAULT_TRADE_FEE, { addLiquidity: false })
            ;({ registry, marginAccount, marginAccountHelper, clearingHouse, amm, vusd, weth, usdc, swap } = contracts)

            // add margin
            margin = _1e6.mul(1000)
            await addMargin(signers[0], margin)
        })

        it('maker adds liquidity', async () => {
            let initialLiquidity = _1e18.mul(1000)
            maker = signers[9]
            // adding $2m liquidity in next step, adding $200k margin
            await addMargin(maker, _1e6.mul(2e5).sub(1))
            await expect(
                clearingHouse.connect(maker).addLiquidity(0, initialLiquidity, ethers.constants.MaxUint256)
            ).to.be.revertedWith('CH: Below Maintenance Margin')
            await addMargin(maker, 1)
            await clearingHouse.connect(maker).addLiquidity(0, initialLiquidity, ethers.constants.MaxUint256)
            await assertions(contracts, maker.address, {
                size: ZERO,
                notionalPosition: _1e6.mul(2e6),
                openNotional: ZERO,
                unrealizedPnl: ZERO
            })
            initialVusdBalance = await swap.balances(0)
        })

        it('maker takes a short counter-position', async () => {
            const baseAssetQuantity = _1e18.mul(5)
            amount = _1e6.mul(5025) // ~5x leverage

            const tx = await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity /* long exactly */, amount /* max_dx */)
            let { quoteAsset } = await getTradeDetails(tx, DEFAULT_TRADE_FEE)

            // after fee is enabled openNotional for short should increase (i.e. higher pnl)
            await assertions(contracts, maker.address, {
                size: baseAssetQuantity.mul(-1),
                openNotional: quoteAsset,
                // @todo These are hardcoded values for now. Might change after "insufficient liquidity" fix
                notionalPosition: _1e6.mul(2e6),
                unrealizedPnl: ZERO
            })

            await clearingHouse.closePosition(0, 0)

            feeAccumulated = (await swap.balances(0)).sub(initialVusdBalance)
            expect(feeAccumulated).gt(ZERO)
            await assertions(contracts, maker.address, {
                size: ZERO,
                notionalPosition: _1e6.mul(2e6),
                openNotional: ZERO,
                unrealizedPnl: feeAccumulated.div(_1e12) // positive pnl because of vamm fee
            })
        })

        it('maker takes a long counter-position', async () => {
            const baseAssetQuantity = _1e18.mul(-5)
            amount = _1e6.mul(4975)

            const tx = await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity /* short exactly */, amount /* min_dy */)
            let { quoteAsset } = await getTradeDetails(tx, DEFAULT_TRADE_FEE)

            await assertions(contracts, maker.address, {
                size: baseAssetQuantity.mul(-1),
                openNotional: quoteAsset.sub(feeAccumulated.div(_1e12)), // openNotional decreases, hence higher pnl
                notionalPosition: _1e6.mul(2e6),
                unrealizedPnl: ZERO
            })

            await clearingHouse.closePosition(0, ethers.constants.MaxUint256)

            feeAccumulated_2 = (await swap.balances(0)).sub(initialVusdBalance).sub(feeAccumulated)
            expect(feeAccumulated_2).gt(ZERO)
            await assertions(contracts, maker.address, {
                size: ZERO,
                notionalPosition: _1e6.mul(2e6),
                openNotional: ZERO,
                unrealizedPnl: feeAccumulated.div(_1e12).add(feeAccumulated_2.div(_1e12))
            })
        })
    })

    describe('Two Makers - equal liquidity', async function() {
        before(async function() {
            signers = await ethers.getSigners()
            ;([ alice ] = signers.map(s => s.address))

            contracts = await setupContracts(DEFAULT_TRADE_FEE, { addLiquidity: false })
            ;({ registry, marginAccount, marginAccountHelper, clearingHouse, amm, vusd, weth, usdc, swap } = contracts)

            // add margin
            margin = _1e6.mul(10000)
            await addMargin(signers[0], margin)
        })

        it('makers add equal liquidity', async () => {
            let initialLiquidity = _1e18.mul(1000)
            maker1 = signers[9]
            maker2 = signers[8]
            // adding $2m liquidity in next step, adding $200k margin
            await addMargin(maker1, _1e6.mul(2e5))
            await clearingHouse.connect(maker1).addLiquidity(0, initialLiquidity, ethers.constants.MaxUint256)

            await addMargin(maker2, _1e6.mul(2.1e5))
            const tx = await clearingHouse.connect(maker2).addLiquidity(0, initialLiquidity, ethers.constants.MaxUint256)

            const addLiquidityEvent = (await parseRawEvent(tx, swap, 'AddLiquidity')).args
            const totalSupply = addLiquidityEvent.token_supply
            const tokenFee = addLiquidityEvent.fee
            initialPositionSize = initialLiquidity.mul(tokenFee).div(totalSupply) // 0.005 due to small fee paid during addLiquidity

            let { notionalPosition, unrealizedPnl, size, openNotional } = await amm.getNotionalPositionAndUnrealizedPnl(maker1.address)
            expect(size).to.eq(initialPositionSize)
            expect(openNotional).to.eq(ZERO)
            expect(notionalPosition).eq(_1e6.mul(2e6))
            expect(unrealizedPnl).gt(ZERO) // part of fee goes to maker1

            ;({ notionalPosition, unrealizedPnl, size, openNotional } = await amm.getNotionalPositionAndUnrealizedPnl(maker2.address))
            expect(size).to.eq(initialPositionSize.mul(-1).sub(1)) // round off error
            expect(openNotional).to.eq(ZERO)
            expect(notionalPosition).eq(_1e6.mul(2e6))
            expect(unrealizedPnl).lt(ZERO) // fee paid
        })

        it('makers take a short counter-position', async () => {
            const baseAssetQuantity = _1e18.mul(50) // increased to check significant effect of vamm fee
            amount = _1e6.mul(55000)

            const tx = await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity /* long exactly */, amount /* max_dx */)
            let { quoteAsset } = await getTradeDetails(tx, DEFAULT_TRADE_FEE)

            let { notionalPosition, unrealizedPnl, size, openNotional } = await amm.getNotionalPositionAndUnrealizedPnl(maker1.address)
            expect(notionalPosition).eq(_1e6.mul(2e6))
            expect(size).lt(ZERO)
            expect(size).gt(baseAssetQuantity.div(-2))
            expect(openNotional).gt(quoteAsset.div(2)) // higher openNotional, increase pnl
            expect(unrealizedPnl).lt(ZERO)

            const [ maker1Pos ] = await clearingHouse.makerPositions(maker1.address)
            expect(maker1Pos.size).to.eq(size)
            expect(maker1Pos.openNotional).to.eq(openNotional)
            expect(maker1Pos.unrealizedPnl).to.eq(unrealizedPnl)
            expect(maker1Pos.avgOpen).to.eq(openNotional.mul(_1e18).div(size.abs()))

            ;({ notionalPosition, unrealizedPnl, size, openNotional } = await amm.getNotionalPositionAndUnrealizedPnl(maker2.address))
            expect(notionalPosition).eq(_1e6.mul(2e6))
            expect(size).lt(baseAssetQuantity.div(-2))
            expect(openNotional).lt(quoteAsset.div(2)) // higher openNotional, increase pnl
            expect(unrealizedPnl).lt(ZERO)

            await clearingHouse.closePosition(0, 0)

            ;({ notionalPosition, unrealizedPnl, size, openNotional } = await amm.getNotionalPositionAndUnrealizedPnl(maker1.address))
            expect(notionalPosition).eq(_1e6.mul(2e6))
            expect(size).to.eq(initialPositionSize)
            expect(openNotional).to.eq(ZERO)
            expect(unrealizedPnl).gt(ZERO) // +112.6

            ;({ notionalPosition, unrealizedPnl, size, openNotional } = await amm.getNotionalPositionAndUnrealizedPnl(maker2.address))
            expect(notionalPosition).eq(_1e6.mul(2e6))
            expect(size).to.eq(initialPositionSize.mul(-1).sub(1))
            expect(openNotional).gt(ZERO) // 97.6 positive openNotional for short position because of fee accumulation, increase pnl
            expect(unrealizedPnl).gt(ZERO) // 92.6
        })

        it('makers take a long counter-position', async () => {
            const baseAssetQuantity = _1e18.mul(-50)
            amount = _1e6.mul(49000)

            const tx = await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity /* short exactly */, amount /* min_dy */)
            let { quoteAsset } = await getTradeDetails(tx, DEFAULT_TRADE_FEE)

            let { notionalPosition, unrealizedPnl, size, openNotional } = await amm.getNotionalPositionAndUnrealizedPnl(maker1.address)
            expect(notionalPosition).eq(_1e6.mul(2e6))
            expect(size).gt(baseAssetQuantity.div(-2))
            expect(openNotional).gt(ZERO)
            expect(openNotional).lt(quoteAsset.div(2)) // lower openNotional becaue of vamm fee, increase pnl
            expect(unrealizedPnl).lt(ZERO)

            const [ maker1Pos ] = await clearingHouse.makerPositions(maker1.address)
            expect(maker1Pos.size).to.eq(size)
            expect(maker1Pos.openNotional).to.eq(openNotional)
            expect(maker1Pos.unrealizedPnl).to.eq(unrealizedPnl)
            expect(maker1Pos.avgOpen).to.eq(openNotional.mul(_1e18).div(size.abs()))

            ;({ notionalPosition, unrealizedPnl, size, openNotional } = await amm.getNotionalPositionAndUnrealizedPnl(maker2.address))
            expect(notionalPosition).eq(_1e6.mul(2e6))
            expect(size).gt(ZERO)
            expect(size).lt(baseAssetQuantity.div(-2))
            expect(openNotional).lt(quoteAsset.div(2)) // lower openNotional becaue of vamm fee, increase pnl
            expect(unrealizedPnl).lt(ZERO)

            await clearingHouse.closePosition(0, ethers.constants.MaxUint256)

            ;({ notionalPosition, unrealizedPnl, size, openNotional } = await amm.getNotionalPositionAndUnrealizedPnl(maker1.address))
            expect(notionalPosition).eq(_1e6.mul(2e6))
            expect(size).to.eq(initialPositionSize)
            expect(openNotional).to.eq(ZERO)
            expect(unrealizedPnl).gt(ZERO) // 214.37

            ;({ notionalPosition, unrealizedPnl, size, openNotional } = await amm.getNotionalPositionAndUnrealizedPnl(maker2.address))
            expect(notionalPosition).eq(_1e6.mul(2e6))
            expect(size).to.eq(initialPositionSize.mul(-1).sub(1))
            expect(openNotional).gt(ZERO) // 199.37 positive openNotional for short position because of fee accumulation, increase pnl
            expect(unrealizedPnl).gt(ZERO) // 194.37
        })
    })

    describe('Two Makers - unequal liquidity', async function() {
        before(async function() {
            signers = await ethers.getSigners()
            ;([ alice ] = signers.map(s => s.address))

            contracts = await setupContracts(DEFAULT_TRADE_FEE, { addLiquidity: false })
            ;({ registry, marginAccount, marginAccountHelper, clearingHouse, amm, vusd, weth, usdc, swap } = contracts)

            // add margin
            margin = _1e6.mul(10000)
            await addMargin(signers[0], margin)
        })

        it('makers add unequal liquidity', async () => {
            let initialLiquidity = _1e18.mul(1000)
            maker1 = signers[9]
            maker2 = signers[8]
            // adding $2m liquidity in next step, adding $200k margin
            await addMargin(maker1, _1e6.mul(2e5))
            await clearingHouse.connect(maker1).addLiquidity(0, initialLiquidity, ethers.constants.MaxUint256)

            // maker2 adds $1m liquidity, adding $100k margin
            await addMargin(maker2, _1e6.mul(1.1e5))
            const tx = await clearingHouse.connect(maker2).addLiquidity(0, initialLiquidity.div(2), ethers.constants.MaxUint256)

            const addLiquidityEvent = (await parseRawEvent(tx, swap, 'AddLiquidity')).args
            totalSupply = addLiquidityEvent.token_supply
            const tokenFee = addLiquidityEvent.fee
            initialPositionSize = initialLiquidity.mul(tokenFee).div(totalSupply)

            let { notionalPosition, unrealizedPnl, size, openNotional } = await amm.getNotionalPositionAndUnrealizedPnl(maker1.address)
            expect(size).to.eq(initialPositionSize)
            expect(openNotional).to.eq(ZERO)
            expect(notionalPosition).eq(_1e6.mul(2e6))
            expect(unrealizedPnl).gt(ZERO) // part of fee goes to maker1

            ;({ notionalPosition, unrealizedPnl, size, openNotional } = await amm.getNotionalPositionAndUnrealizedPnl(maker2.address))
            expect(size).to.eq(initialPositionSize.mul(-1).sub(1)) // round off error
            expect(openNotional).to.eq(ZERO)
            expect(notionalPosition).eq(_1e6.mul(1e6))
            expect(unrealizedPnl).lt(ZERO) // fee paid
        })

        it('makers take a short counter-position', async () => {
            const baseAssetQuantity = _1e18.mul(50)
            amount = _1e6.mul(55000)

            const tx = await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity /* long exactly */, amount /* max_dx */)
            let { quoteAsset } = await getTradeDetails(tx, DEFAULT_TRADE_FEE)

            const [{ vAsset, vUSD, totalDeposited }, { dToken: maker1Liquidity }, vUSDBalance] = await Promise.all([
                amm.getMakerLiquidity(maker1.address),
                amm.makers(maker1.address),
                swap.balances(0)
            ])
            expect(totalDeposited).to.eq(_1e6.mul(2e6))
            // base balance in pool = 1000 + 500 - 50 = 1450
            expect(vAsset).to.eq(_1e18.mul(1450).mul(maker1Liquidity).div(totalSupply))
            // quote balance in pool = 1m + 0.5m + quoteAsset
            expect(vUSD).to.eq(vUSDBalance.mul(maker1Liquidity).div(totalSupply).div(_1e12))

            let { notionalPosition, unrealizedPnl, size, openNotional } = await amm.getNotionalPositionAndUnrealizedPnl(maker1.address)
            expect(notionalPosition).eq(_1e6.mul(2e6))
            expect(size).lt(ZERO)
            expect(size).gt(baseAssetQuantity.mul(-2).div(3))
            expect(openNotional).gt(quoteAsset.mul(2).div(3)) // higher openNotional, increase pnl
            expect(unrealizedPnl).lt(ZERO)

            ;({ notionalPosition, unrealizedPnl, size, openNotional } = await amm.getNotionalPositionAndUnrealizedPnl(maker2.address))
            expect(notionalPosition).eq(_1e6.mul(1e6))
            expect(size).lt(baseAssetQuantity.div(-3))
            expect(openNotional).lt(quoteAsset.div(3)) // higher openNotional, increase pnl
            expect(unrealizedPnl).lt(ZERO)

            await clearingHouse.closePosition(0, 0)

            ;({ notionalPosition, unrealizedPnl, size, openNotional } = await amm.getNotionalPositionAndUnrealizedPnl(maker1.address))
            expect(notionalPosition).eq(_1e6.mul(2e6))
            expect(size).to.eq(initialPositionSize)
            expect(openNotional).to.eq(ZERO)
            expect(unrealizedPnl).gt(ZERO)

            ;({ notionalPosition, unrealizedPnl, size, openNotional } = await amm.getNotionalPositionAndUnrealizedPnl(maker2.address))
            expect(notionalPosition).eq(_1e6.mul(1e6))
            expect(size).to.eq(initialPositionSize.mul(-1).sub(1))
            expect(openNotional).gt(ZERO)
            expect(unrealizedPnl).gt(ZERO)
        })

        it('makers take a long counter-position', async () => {
            const baseAssetQuantity = _1e18.mul(-50)
            amount = _1e6.mul(49000)

            const tx = await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity /* short exactly */, amount /* min_dy */)
            let { quoteAsset } = await getTradeDetails(tx, DEFAULT_TRADE_FEE)

            let { notionalPosition, unrealizedPnl, size, openNotional } = await amm.getNotionalPositionAndUnrealizedPnl(maker1.address)
            expect(notionalPosition).eq(_1e6.mul(2e6))
            expect(size).gt(baseAssetQuantity.mul(-2).div(3))
            expect(openNotional).gt(ZERO)
            expect(openNotional).lt(quoteAsset.mul(2).div(3)) // lower openNotional becaue of vamm fee, increase pnl
            expect(unrealizedPnl).lt(ZERO)

            ;({ notionalPosition, unrealizedPnl, size, openNotional } = await amm.getNotionalPositionAndUnrealizedPnl(maker2.address))
            expect(notionalPosition).eq(_1e6.mul(1e6))
            expect(size).gt(ZERO)
            expect(size).lt(baseAssetQuantity.div(-3))
            expect(openNotional).lt(quoteAsset.div(3)) // lower openNotional becaue of vamm fee, increase pnl
            expect(unrealizedPnl).lt(ZERO)

            await clearingHouse.closePosition(0, ethers.constants.MaxUint256)

            ;({ notionalPosition, unrealizedPnl, size, openNotional } = await amm.getNotionalPositionAndUnrealizedPnl(maker1.address))
            expect(notionalPosition).eq(_1e6.mul(2e6))
            expect(size).to.eq(initialPositionSize)
            expect(openNotional).to.eq(ZERO)
            expect(unrealizedPnl).gt(ZERO)

            ;({ notionalPosition, unrealizedPnl, size, openNotional } = await amm.getNotionalPositionAndUnrealizedPnl(maker2.address))
            expect(notionalPosition).eq(_1e6.mul(1e6))
            expect(size).to.eq(initialPositionSize.mul(-1).sub(1))
            expect(openNotional).gt(ZERO) // positive openNotional for short position because of fee accumulation, increase pnl
            expect(unrealizedPnl).gt(ZERO)
        })

    })

    describe('Maker Withdraw Liquidity', async function() {
        beforeEach(async function() {
            signers = await ethers.getSigners()
            ;([ alice ] = signers.map(s => s.address))

            contracts = await setupContracts(DEFAULT_TRADE_FEE, { addLiquidity: false })
            ;({ registry, marginAccount, marginAccountHelper, clearingHouse, amm, vusd, weth, usdc, swap } = contracts)

            // add margin
            margin = _1e6.mul(1100)
            await addMargin(signers[0], margin)
            // add liquidity
            maker1 = signers[9]
            maker2 = signers[8]
            maker1Margin = _1e6.mul(2e5)
            const initialLiquidity = _1e18.mul(1000)
            await addMargin(maker1, maker1Margin)
            await addMargin(maker2, _1e6.mul(2.1e5))
            await clearingHouse.connect(maker1).addLiquidity(0, initialLiquidity, ethers.constants.MaxUint256)
            await clearingHouse.connect(maker2).addLiquidity(0, initialLiquidity, ethers.constants.MaxUint256)
            totalSupply = await swap.totalSupply()
        })

        it('remove liquidity - maker short', async function() {
            const maker1Liquidity = (await amm.makers(maker1.address)).dToken
            // alice longs
            const baseAssetQuantity = _1e18.mul(10)
            const amount = await amm.getQuote(baseAssetQuantity)
            let tx = await clearingHouse.openPosition(0, baseAssetQuantity, amount)
            let { quoteAsset } = await getTradeDetails(tx, DEFAULT_TRADE_FEE)
            // maker1 removes all liquidity
            tx = await clearingHouse.connect(maker1).removeLiquidity(0, maker1Liquidity, _1e6.mul(1e6) /* minQuote */, _1e18.mul(995) /* minBase */)
            const { realizedPnl } = (await parseRawEvent(tx, amm, 'LiquidityRemoved')).args

            expect(realizedPnl).to.eq(ZERO) // no reducePosition, fee profit is less than market loss
            const maker1Position = await amm.positions(maker1.address)
            const _maker1 = await amm.makers(maker1.address)
            expect(maker1Position.size).lt(ZERO)
            expect(maker1Position.size).gt(baseAssetQuantity.div(-2))
            expect(maker1Position.openNotional).gt(quoteAsset.div(2)) // higher openNotional, increase pnl
            expect(_maker1.dToken).eq(ZERO)
            expect(_maker1.pos).eq(ZERO)
            expect(_maker1.posAccumulator).eq(baseAssetQuantity.mul(_1e18).mul(-1).div(totalSupply))
            const { takerNotionalPosition, unrealizedPnl } = await amm.getTakerNotionalPositionAndUnrealizedPnl(maker1.address)
            expect(takerNotionalPosition).gt(quoteAsset.div(2))
            expect(unrealizedPnl).lt(ZERO)
            expect(await marginAccount.getNormalizedMargin(maker1.address)).to.eq(maker1Margin)
        })

        it('remove liquidity - maker long', async function() {
            const maker1Liquidity = (await amm.makers(maker1.address)).dToken
            // alice shorts
            const baseAssetQuantity = _1e18.mul(-10)
            const amount = await amm.getQuote(baseAssetQuantity)
            let tx = await clearingHouse.openPosition(0, baseAssetQuantity, amount)
            let { quoteAsset } = await getTradeDetails(tx, DEFAULT_TRADE_FEE)
            // maker1 removes all liquidity
            tx = await clearingHouse.connect(maker1).removeLiquidity(0, maker1Liquidity, _1e6.mul(995000) /* minQuote */, _1e18.mul(1000) /* minBase */)
            const { realizedPnl } = (await parseRawEvent(tx, amm, 'LiquidityRemoved')).args

            expect(realizedPnl).to.eq(ZERO) // no reducePosition, fee profit is less than market loss
            const maker1Position = await amm.positions(maker1.address)
            const _maker1 = await amm.makers(maker1.address)
            expect(maker1Position.size).gt(baseAssetQuantity.div(-2))
            expect(maker1Position.openNotional).gt(ZERO)
            expect(maker1Position.openNotional).lt(quoteAsset.div(2)) // lower openNotional becaue of vamm fee, increase pnl
            expect(_maker1.dToken).eq(ZERO)
            expect(_maker1.pos).eq(ZERO)
            expect(_maker1.posAccumulator).eq(baseAssetQuantity.mul(_1e18).mul(-1).div(totalSupply))
            const { takerNotionalPosition, unrealizedPnl } = await amm.getTakerNotionalPositionAndUnrealizedPnl(maker1.address)
            expect(takerNotionalPosition).lt(quoteAsset.div(2))
            expect(unrealizedPnl).lt(ZERO)
            expect(await marginAccount.getNormalizedMargin(maker1.address)).to.eq(maker1Margin)
        })
    })

    describe('Taker + Maker', async function() {
        beforeEach(async function() {
            signers = await ethers.getSigners()
            ;([ alice ] = signers.map(s => s.address))

            contracts = await setupContracts(DEFAULT_TRADE_FEE, { addLiquidity: false })
            ;({ registry, marginAccount, marginAccountHelper, clearingHouse, amm, vusd, weth, usdc, swap } = contracts)

            // add margin
            margin = _1e6.mul(1100)
            await addMargin(signers[0], margin)
            // add liquidity
            maker1 = signers[9]
            maker2 = signers[8]
            maker1Margin = _1e6.mul(2.1e5)
            const initialLiquidity = _1e18.mul(1000)
            await addMargin(maker1, maker1Margin)
            await addMargin(maker2, maker1Margin)
            await clearingHouse.connect(maker1).addLiquidity(0, initialLiquidity, ethers.constants.MaxUint256)
            await clearingHouse.connect(maker2).addLiquidity(0, initialLiquidity, ethers.constants.MaxUint256)
            totalSupply = await swap.totalSupply()
        })

        it('increase net position - short -> bigger short', async function () {
            // alice longs
            let baseAssetQuantity = _1e18.mul(10)
            let amount = await amm.getQuote(baseAssetQuantity)
            let tx = await clearingHouse.openPosition(0, baseAssetQuantity, amount)
            const { quoteAsset } = await getTradeDetails(tx, DEFAULT_TRADE_FEE)
            let positionAccumulator = baseAssetQuantity.mul(_1e18).div(totalSupply).mul(-1)

            // maker1 shorts as taker
            baseAssetQuantity = _1e18.mul(-5)
            amount = await amm.getQuote(baseAssetQuantity)
            tx = await clearingHouse.connect(maker1).openPosition(0, baseAssetQuantity, amount)
            ;({ quoteAsset: takerQuote } = await getTradeDetails(tx, DEFAULT_TRADE_FEE))
            positionAccumulator = positionAccumulator.sub(baseAssetQuantity.mul(_1e18).div(totalSupply))

            let takerPosition = await amm.positions(maker1.address)
            expect(takerPosition.size).to.eq(baseAssetQuantity)
            expect(takerPosition.openNotional).to.eq(takerQuote)

            let { notionalPosition, unrealizedPnl, size, openNotional } = await amm.getNotionalPositionAndUnrealizedPnl(maker1.address)
             // -10/2 + 5/2 - 5 + noise = -7.495. Maker takes a long position of 2.5 during trade as taker, hence reducing their position
            assertBounds(size, _1e18.mul(-75).div(10), _1e18.mul(-7))
            expect(openNotional).gt(takerQuote.add(quoteAsset.sub(takerQuote).div(2))) // makerOpenNotional = (quoteAsset - takerQuote) / 2, reducing impermanent position during trades, side remains same
            assertBounds(unrealizedPnl, _1e6.mul(-145).div(10), _1e6.mul(-14)) // -14.19

            // maker1 removes all liquidity
            const { dToken: maker1Liquidity } = await amm.makers(maker1.address)
            await clearingHouse.connect(maker1).removeLiquidity(0, maker1Liquidity, _1e6.mul(1e6), _1e18.mul(997))

            const takerNotionalPosition = await amm.getCloseQuote(baseAssetQuantity)
            expect(notionalPosition).eq(_1e6.mul(2e6).add(takerNotionalPosition))
            // all impermanent position is converted to permanent
            takerPosition = await amm.positions(maker1.address)
            expect(takerPosition.size).to.eq(size)
            expect(takerPosition.openNotional).to.eq(openNotional)

            const makerPosition = await amm.makers(maker1.address)
            expect(makerPosition.vAsset).to.eq(ZERO)
            expect(makerPosition.vUSD).to.eq(ZERO)
            expect(makerPosition.dToken).to.eq(ZERO)
            expect(makerPosition.posAccumulator).to.eq(positionAccumulator)
            expect(makerPosition.pos).to.eq(ZERO)
        })

        it('increase net position - long -> bigger long', async function () {
            // alice shorts
            let baseAssetQuantity = _1e18.mul(-10)
            let amount = await amm.getQuote(baseAssetQuantity)
            let tx = await clearingHouse.openPosition(0, baseAssetQuantity, amount)
            const { quoteAsset } = await getTradeDetails(tx, DEFAULT_TRADE_FEE)
            let positionAccumulator = baseAssetQuantity.mul(_1e18).div(totalSupply).mul(-1)

            // maker1 longs as taker
            baseAssetQuantity = _1e18.mul(5)
            amount = await amm.getQuote(baseAssetQuantity)
            tx = await clearingHouse.connect(maker1).openPosition(0, baseAssetQuantity, amount)
            ;({ quoteAsset: takerQuote } = await getTradeDetails(tx, DEFAULT_TRADE_FEE))
            positionAccumulator = positionAccumulator.sub(baseAssetQuantity.mul(_1e18).div(totalSupply))

            let takerPosition = await amm.positions(maker1.address)
            expect(takerPosition.size).to.eq(baseAssetQuantity)
            expect(takerPosition.openNotional).to.eq(takerQuote)

            let { notionalPosition, unrealizedPnl, size, openNotional } = await amm.getNotionalPositionAndUnrealizedPnl(maker1.address)
            // 10/2 - 5/2 + 5 + noise = 7.505
            assertBounds(size, _1e18.mul(75).div(10), _1e18.mul(8))
            expect(openNotional).gt(ZERO)
            expect(openNotional).lt(takerQuote.add(quoteAsset.sub(takerQuote).div(2))) // makerOpenNotional = (quoteAsset - takerQuote) / 2, reducing impermanent position during trades, side remains same
            assertBounds(unrealizedPnl, _1e6.mul(-141).div(10), _1e6.mul(-136).div(10)) // -13.9
            // maker1 removes all liquidity
            const { dToken: maker1Liquidity } = await amm.makers(maker1.address)
            await clearingHouse.connect(maker1).removeLiquidity(0, maker1Liquidity, _1e6.mul(997000), _1e18.mul(1000))

            const takerNotionalPosition = await amm.getCloseQuote(baseAssetQuantity)
            expect(notionalPosition).eq(_1e6.mul(2e6).add(takerNotionalPosition))
            // all impermanent position is converted to permanent
            takerPosition = await amm.positions(maker1.address)
            expect(takerPosition.size).to.eq(size)
            expect(takerPosition.openNotional).to.eq(openNotional)

            const makerPosition = await amm.makers(maker1.address)
            expect(makerPosition.vAsset).to.eq(ZERO)
            expect(makerPosition.vUSD).to.eq(ZERO)
            expect(makerPosition.dToken).to.eq(ZERO)
            expect(makerPosition.posAccumulator).to.eq(positionAccumulator)
            expect(makerPosition.pos).to.eq(ZERO)
        })

        it('reduce net position - short -> smaller short', async function () {
            // alice shorts
            let baseAssetQuantity = _1e18.mul(-5)
            let amount = await amm.getQuote(baseAssetQuantity)
            await clearingHouse.openPosition(0, baseAssetQuantity, amount)
            let positionAccumulator = baseAssetQuantity.mul(_1e18).div(totalSupply).mul(-1)

            // maker1 shorts as taker
            baseAssetQuantity = _1e18.mul(-10)
            amount = await amm.getQuote(baseAssetQuantity)
            let tx = await clearingHouse.connect(maker1).openPosition(0, baseAssetQuantity, amount)
            ;({ quoteAsset: takerQuote, fee } = await getTradeDetails(tx, DEFAULT_TRADE_FEE))
            positionAccumulator = positionAccumulator.sub(baseAssetQuantity.mul(_1e18).div(totalSupply))

            let takerPosition = await amm.positions(maker1.address)
            expect(takerPosition.size).to.eq(baseAssetQuantity)
            expect(takerPosition.openNotional).to.eq(takerQuote)
            const {
                position: maker1Position,
                openNotional: maker1OpenNotional
            } = await amm.getMakerPositionAndUnrealizedPnl(maker1.address) // maker1 impermanent position
            assertBounds(maker1Position, _1e18.mul(75).div(10), _1e18.mul(8)) // 5/2 + 10/2 + noise

            let { notionalPosition, unrealizedPnl, size, openNotional } = await amm.getNotionalPositionAndUnrealizedPnl(maker1.address)
            // size = 5/2 + 10/2 - 10 + noise = -2.49  Maker takes a long position of 5 during trade as taker, hence increasing their impermanent position
            assertBounds(size, _1e18.mul(-25).div(10), _1e18.mul(-2))
            expect(openNotional).eq(takerQuote.sub(maker1OpenNotional))

            // maker1 removes all liquidity
            const { dToken: maker1Liquidity } = await amm.makers(maker1.address)
            tx = await clearingHouse.connect(maker1).removeLiquidity(0, maker1Liquidity, _1e6.mul(0), _1e18.mul(0))

            const newNotional = await amm.getCloseQuote(size)
            const maker1Notional = newNotional.mul(maker1Position).div(size.abs())
            const pnlToBeRealized = takerQuote.mul(maker1Position).div(baseAssetQuantity.abs()).sub(maker1Notional)
            const { realizedPnl } = (await parseRawEvent(tx, amm, 'LiquidityRemoved')).args
            expect(realizedPnl.div(10)).to.eq(pnlToBeRealized.div(10)) // round-off error
            expect(await marginAccount.getNormalizedMargin(maker1.address)).to.eq(maker1Margin.sub(fee).add(realizedPnl))

            const takerNotionalPosition = await amm.getCloseQuote(baseAssetQuantity)
            expect(notionalPosition).eq(_1e6.mul(2e6).add(takerNotionalPosition)) // max(makerDebt, makerPosNotional) + takerNotional
            // all impermanent position is converted to permanent
            takerPosition = await amm.positions(maker1.address)
            expect(takerPosition.size).to.eq(size)
            expect(takerPosition.openNotional).to.eq(openNotional)
            const totalNotionalPosition = await amm.getCloseQuote(takerPosition.size)
            expect(unrealizedPnl).eq(openNotional.sub(totalNotionalPosition))

            const makerPosition = await amm.makers(maker1.address)
            expect(makerPosition.vAsset).to.eq(ZERO)
            expect(makerPosition.vUSD).to.eq(ZERO)
            expect(makerPosition.dToken).to.eq(ZERO)
            expect(makerPosition.posAccumulator).to.eq(positionAccumulator)
            expect(makerPosition.pos).to.eq(ZERO)
        })

        it('reduce net position - long -> smaller long', async function () {
            // alice longs
            let baseAssetQuantity = _1e18.mul(5)
            let amount = await amm.getQuote(baseAssetQuantity)
            await clearingHouse.openPosition(0, baseAssetQuantity, amount)
            let positionAccumulator = baseAssetQuantity.mul(_1e18).div(totalSupply).mul(-1)

            // maker1 longs as taker
            baseAssetQuantity = _1e18.mul(10)
            amount = await amm.getQuote(baseAssetQuantity)
            let tx = await clearingHouse.connect(maker1).openPosition(0, baseAssetQuantity, amount)
            ;({ quoteAsset: takerQuote, fee } = await getTradeDetails(tx, DEFAULT_TRADE_FEE))
            positionAccumulator = positionAccumulator.sub(baseAssetQuantity.mul(_1e18).div(totalSupply))

            let takerPosition = await amm.positions(maker1.address)
            expect(takerPosition.size).to.eq(baseAssetQuantity)
            expect(takerPosition.openNotional).to.eq(takerQuote)
            const {
                position: maker1Position,
                openNotional: maker1OpenNotional
            } = await amm.getMakerPositionAndUnrealizedPnl(maker1.address) // maker1 impermanent position
            assertBounds(maker1Position, _1e18.mul(-75).div(10), _1e18.mul(-7)) // -5/2 - 10/2 + noise

            let { notionalPosition, unrealizedPnl, size, openNotional } = await amm.getNotionalPositionAndUnrealizedPnl(maker1.address)
            // size = - 5/2 - 10/2 + 10 + noise = 2.504  Maker takes a short position of 5 during trade as taker, hence increasing their impermanent position
            assertBounds(size, _1e18.mul(25).div(10), _1e18.mul(3))
            expect(openNotional).eq(takerQuote.sub(maker1OpenNotional))

            // maker1 removes all liquidity
            const { dToken: maker1Liquidity } = await amm.makers(maker1.address)
            tx = await clearingHouse.connect(maker1).removeLiquidity(0, maker1Liquidity, _1e6.mul(0), _1e18.mul(0))

            const newNotional = await amm.getCloseQuote(size)
            const maker1Notional = newNotional.mul(maker1Position.abs()).div(size)
            const pnlToBeRealized = maker1Notional.sub(takerQuote.mul(maker1Position.abs()).div(baseAssetQuantity))
            const { realizedPnl } = (await parseRawEvent(tx, amm, 'LiquidityRemoved')).args
            expect(realizedPnl.div(100)).to.eq(pnlToBeRealized.div(100))
            expect(await marginAccount.getNormalizedMargin(maker1.address)).to.eq(maker1Margin.sub(fee).add(realizedPnl))

            const takerNotionalPosition = await amm.getCloseQuote(baseAssetQuantity)
            expect(notionalPosition).eq(_1e6.mul(2e6).add(takerNotionalPosition))
            // all impermanent position is converted to permanent
            takerPosition = await amm.positions(maker1.address)
            expect(takerPosition.size).to.eq(size)
            expect(takerPosition.openNotional).to.eq(openNotional)
            const totalNotionalPosition = await amm.getCloseQuote(takerPosition.size)
            expect(unrealizedPnl).eq(totalNotionalPosition.sub(openNotional))

            const makerPosition = await amm.makers(maker1.address)
            expect(makerPosition.vAsset).to.eq(ZERO)
            expect(makerPosition.vUSD).to.eq(ZERO)
            expect(makerPosition.dToken).to.eq(ZERO)
            expect(makerPosition.posAccumulator).to.eq(positionAccumulator)
            expect(makerPosition.pos).to.eq(ZERO)
        })

        it('reduce net position - short -> long', async function () {
            // alice shorts
            await addMargin(signers[0], _1e6.mul(500))
            let baseAssetQuantity = _1e18.mul(-15)
            let amount = await amm.getQuote(baseAssetQuantity)
            let tx = await clearingHouse.openPosition(0, baseAssetQuantity, amount)
            let { quoteAsset } = await getTradeDetails(tx, DEFAULT_TRADE_FEE)
            let positionAccumulator = baseAssetQuantity.mul(_1e18).div(totalSupply).mul(-1)

            // maker1 shorts as taker
            baseAssetQuantity = _1e18.mul(-5)
            amount = await amm.getQuote(baseAssetQuantity)
            tx = await clearingHouse.connect(maker1).openPosition(0, baseAssetQuantity, amount)
            ;({ quoteAsset: takerQuote, fee } = await getTradeDetails(tx, DEFAULT_TRADE_FEE))
            positionAccumulator = positionAccumulator.sub(baseAssetQuantity.mul(_1e18).div(totalSupply))

            let takerPosition = await amm.positions(maker1.address)
            expect(takerPosition.size).to.eq(baseAssetQuantity)
            expect(takerPosition.openNotional).to.eq(takerQuote)
            const {
                position: maker1Position,
                openNotional: maker1OpenNotional
            } = await amm.getMakerPositionAndUnrealizedPnl(maker1.address) // maker1 impermanent position
            assertBounds(maker1Position, _1e18.mul(10), _1e18.mul(105).div(10)) // 15/2 + 5/2 + noise
            expect(maker1OpenNotional).lt(quoteAsset.add(takerQuote).div(2)) // a little more than 1/2 share of maker1 in the pool, hence openNotional is less in case of long

            let { unrealizedPnl, size, openNotional } = await amm.getNotionalPositionAndUnrealizedPnl(maker1.address)
            // size = 15/2 + 5/2 - 5 + noise = 5.005
            assertBounds(size, _1e18.mul(5), _1e18.mul(55).div(10))
            expect(unrealizedPnl).lt(ZERO) // due to vamm fee
            expect(openNotional).to.eq(maker1OpenNotional.sub(takerQuote))

            // maker1 removes all liquidity
            const { dToken: maker1Liquidity } = await amm.makers(maker1.address)
            tx = await clearingHouse.connect(maker1).removeLiquidity(0, maker1Liquidity, _1e6.mul(0), _1e18.mul(0))

            const newNotional = await amm.getCloseQuote(size)
            const closedNotional = newNotional.mul(baseAssetQuantity.abs()).div(size)
            const pnlToBeRealized = takerQuote.sub(closedNotional)
            const { realizedPnl } = (await parseRawEvent(tx, amm, 'LiquidityRemoved')).args
            expect(realizedPnl.div(10)).to.eq(pnlToBeRealized.div(10))
            expect(await marginAccount.getNormalizedMargin(maker1.address)).to.eq(maker1Margin.sub(fee).add(realizedPnl))

            // all impermanent position is converted to permanent
            takerPosition = await amm.positions(maker1.address)
            expect(takerPosition.size).to.eq(size)
            expect(takerPosition.openNotional).to.eq(openNotional)

            const makerPosition = await amm.makers(maker1.address)
            expect(makerPosition.vAsset).to.eq(ZERO)
            expect(makerPosition.vUSD).to.eq(ZERO)
            expect(makerPosition.dToken).to.eq(ZERO)
            expect(makerPosition.posAccumulator).to.eq(positionAccumulator)
            expect(makerPosition.pos).to.eq(ZERO)
        })

        it('reduce net position - long -> short', async function () {
            // alice longs
            await addMargin(signers[0], _1e6.mul(500))
            let baseAssetQuantity = _1e18.mul(15)
            let amount = await amm.getQuote(baseAssetQuantity)
            let tx = await clearingHouse.openPosition(0, baseAssetQuantity, amount)
            let { quoteAsset } = await getTradeDetails(tx, DEFAULT_TRADE_FEE)
            let positionAccumulator = baseAssetQuantity.mul(_1e18).div(totalSupply).mul(-1)

            // maker1 longs as taker
            baseAssetQuantity = _1e18.mul(5)
            amount = await amm.getQuote(baseAssetQuantity)
            tx = await clearingHouse.connect(maker1).openPosition(0, baseAssetQuantity, amount)
            ;({ quoteAsset: takerQuote, fee } = await getTradeDetails(tx, DEFAULT_TRADE_FEE))
            positionAccumulator = positionAccumulator.sub(baseAssetQuantity.mul(_1e18).div(totalSupply))

            let takerPosition = await amm.positions(maker1.address)
            expect(takerPosition.size).to.eq(baseAssetQuantity)
            expect(takerPosition.openNotional).to.eq(takerQuote)
            const {
                position: maker1Position,
                openNotional: maker1OpenNotional
            } = await amm.getMakerPositionAndUnrealizedPnl(maker1.address) // maker1 impermanent position
            assertBounds(maker1Position, _1e18.mul(-10), _1e18.mul(-95).div(10)) // -15/2 - 5/2 + noise
            expect(maker1OpenNotional).gt(quoteAsset.add(takerQuote).div(2)) // a little more than 1/2 share of maker1 in the pool, hence openNotional is more in case of short

            let { unrealizedPnl, size, openNotional } = await amm.getNotionalPositionAndUnrealizedPnl(maker1.address)
            // sizr = -15/2 - 5/2 + 5 + noise = -4.995
            assertBounds(size, _1e18.mul(-5), _1e18.mul(-45).div(10))
            expect(unrealizedPnl).lt(ZERO) // due to vamm fee
            expect(openNotional).to.eq(maker1OpenNotional.sub(takerQuote))

            // maker1 removes all liquidity
            const { dToken: maker1Liquidity } = await amm.makers(maker1.address)
            tx = await clearingHouse.connect(maker1).removeLiquidity(0, maker1Liquidity, _1e6.mul(0), _1e18.mul(0))

            const newNotional = await amm.getCloseQuote(size)
            const closedNotional = newNotional.mul(baseAssetQuantity).div(size.abs())
            const pnlToBeRealized = closedNotional.sub(takerQuote)
            const { realizedPnl } = (await parseRawEvent(tx, amm, 'LiquidityRemoved')).args
            expect(realizedPnl.div(10)).to.eq(pnlToBeRealized.div(10))
            expect(await marginAccount.getNormalizedMargin(maker1.address)).to.eq(maker1Margin.sub(fee).add(realizedPnl))

            // all impermanent position is converted to permanent
            takerPosition = await amm.positions(maker1.address)
            expect(takerPosition.size).to.eq(size)
            expect(takerPosition.openNotional).to.eq(openNotional)

            const makerPosition = await amm.makers(maker1.address)
            expect(makerPosition.vAsset).to.eq(ZERO)
            expect(makerPosition.vUSD).to.eq(ZERO)
            expect(makerPosition.dToken).to.eq(ZERO)
            expect(makerPosition.posAccumulator).to.eq(positionAccumulator)
            expect(makerPosition.pos).to.eq(ZERO)
        })
    })

    describe('Position Liquidation', async function() {
        beforeEach(async function() {
            signers = await ethers.getSigners()
            ;([ alice ] = signers.map(s => s.address))

            contracts = await setupContracts(DEFAULT_TRADE_FEE, { addLiquidity: false })
            ;({ registry, marginAccount, marginAccountHelper, clearingHouse, amm, vusd, weth, usdc, swap } = contracts)

            // add margin
            margin = _1e6.mul(22000)
            await addMargin(signers[0], margin)
            // add liquidity
            ;([ maker3, maker2, maker1 ] = signers.slice(7))
            maker1Margin = _1e6.mul(2.1e5)
            const initialLiquidity = _1e18.mul(1000)
            await addMargin(maker1, maker1Margin)
            await addMargin(maker2, maker1Margin)
            await clearingHouse.connect(maker1).addLiquidity(0, initialLiquidity, ethers.constants.MaxUint256)
            await clearingHouse.connect(maker2).addLiquidity(0, initialLiquidity, ethers.constants.MaxUint256)
            maintenanceMargin = await clearingHouse.maintenanceMargin()
        })

        it('taker-notLiquidable, maker-Liquidable', async function() {
            // maker3 adds Liquidity
            await addMargin(maker3, _1e6.mul(2520))
            await clearingHouse.connect(maker3).addLiquidity(0, _1e18.mul(10), ethers.constants.MaxUint256)
            // maker3 longs
            const baseAssetQuantity = _1e18.mul(5)
            await clearingHouse.connect(maker3).openPosition(0, baseAssetQuantity, ethers.constants.MaxUint256)
            expect(await clearingHouse.isAboveMaintenanceMargin(maker3.address)).to.be.true // taker+maker marginFraction > MM
            await expect(clearingHouse.liquidateMaker(maker3.address)).to.be.revertedWith('CH: Above Maintenance Margin')
            // alice shorts
            await clearingHouse.openPosition(0, _1e18.mul(-10), 0)

            expect(await clearingHouse.isAboveMaintenanceMargin(maker3.address)).to.be.false // taker+maker marginFraction < MM

            // liquidate maker position
            await expect(clearingHouse.liquidate(maker3.address)).to.be.revertedWith('CH: Remove Liquidity First')
            const { position: maker3Pos } = await amm.getMakerPositionAndUnrealizedPnl(maker3.address)
            await clearingHouse.liquidateMaker(maker3.address)

            const makerPosition = await amm.makers(maker3.address)
            expect(makerPosition.vAsset).to.eq(ZERO)
            expect(makerPosition.vUSD).to.eq(ZERO)
            expect(makerPosition.dToken).to.eq(ZERO)
            expect(makerPosition.pos).to.eq(ZERO)
            // impermanent position converted into permanent
            expect((await amm.positions(maker3.address)).size).to.eq(maker3Pos.add(baseAssetQuantity))
            await expect(clearingHouse.liquidate(maker3.address)).to.be.revertedWith('Above Maintenance Margin')
        })

        it('taker-Liquidable, maker-notLiquidable', async function() {
            // maker3 adds Liquidity
            await addMargin(maker3, _1e6.mul(1250))
            await clearingHouse.connect(maker3).addLiquidity(0, _1e18.mul(1), ethers.constants.MaxUint256)
            // maker3 longs
            const baseAssetQuantity = _1e18.mul(10)
            await clearingHouse.connect(maker3).openPosition(0, baseAssetQuantity, ethers.constants.MaxUint256)
            expect(await clearingHouse.isAboveMaintenanceMargin(maker3.address)).to.be.true // taker+maker marginFraction > MM
            // alice shorts
            await clearingHouse.openPosition(0, _1e18.mul(-60), 0)

            expect(await clearingHouse.isAboveMaintenanceMargin(maker3.address)).to.be.false // taker+maker marginFraction < MM

            await expect(clearingHouse.liquidate(maker3.address)).to.be.revertedWith('CH: Remove Liquidity First')
            const { position: maker3Pos } = await amm.getMakerPositionAndUnrealizedPnl(maker3.address)
            await clearingHouse.liquidateMaker(maker3.address)

            const makerPosition = await amm.makers(maker3.address)
            expect(makerPosition.vAsset).to.eq(ZERO)
            expect(makerPosition.vUSD).to.eq(ZERO)
            expect(makerPosition.dToken).to.eq(ZERO)
            expect(makerPosition.pos).to.eq(ZERO)
            // impermanent position converted into permanent
            expect((await amm.positions(maker3.address)).size).to.eq(maker3Pos.add(baseAssetQuantity))

            const { notionalPosition } = await amm.getNotionalPositionAndUnrealizedPnl(maker3.address)
            // liquidate taker
            await clearingHouse.connect(signers[2]).liquidate(maker3.address)

            const liquidationPenalty = notionalPosition.mul(5e4).div(_1e6)
            const toInsurance = liquidationPenalty.div(2)
            expect(await vusd.balanceOf(signers[2].address)).to.eq(liquidationPenalty.sub(toInsurance)) // liquidation penalty
            expect((await amm.positions(maker3.address)).size).to.eq(ZERO)
        })
    })

    describe('Funding', async function() {
        beforeEach(async function() {
            signers = await ethers.getSigners()
            ;([ alice ] = signers.map(s => s.address))

            contracts = await setupContracts(DEFAULT_TRADE_FEE, { addLiquidity: false })
            ;({ registry, marginAccount, marginAccountHelper, clearingHouse, amm, vusd, weth, usdc, swap } = contracts)

            // add margin
            margin = _1e6.mul(1000)
            await addMargin(signers[0], margin)
            // add liquidity
            maker1 = signers[9]
            maker2 = signers[8]
            makerMargin = _1e6.mul(2.1e5)
            const initialLiquidity = _1e18.mul(1000)
            await addMargin(maker1, makerMargin)
            await addMargin(maker2, makerMargin)
            // epoch = 1
            await clearingHouse.connect(maker1).addLiquidity(0, initialLiquidity, ethers.constants.MaxUint256)
            await clearingHouse.connect(maker2).addLiquidity(0, initialLiquidity, ethers.constants.MaxUint256)
            await gotoNextFundingTime(amm)
            ;([{ dToken: maker1Liquidity }, { dToken: maker2Liquidity }] = await Promise.all([
                amm.makers(maker1.address),
                amm.makers(maker2.address)
            ]))
            totalSupply = await swap.totalSupply()
        })

        it('makers pay and alice receive funding', async function() {
            const baseAssetQuantity = _1e18.mul(-5)
            let tx = await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity, _1e6.mul(4975))
            ;({ quoteAsset, fee } = await getTradeDetails(tx))

            // underlying
            const oracleTwap = _1e6.mul(900)
            await oracle.setUnderlyingTwapPrice(weth.address, oracleTwap)

            tx = await clearingHouse.settleFunding() // epoch = 1
            let fundingTimestamp = (await ethers.provider.getBlock(tx.blockNumber)).timestamp;
            let markTwap = await getTwapPrice(amm, 3600, fundingTimestamp)
            let premium = markTwap.sub(oracleTwap).div(24)
            await gotoNextFundingTime(amm)

            tx = await clearingHouse.settleFunding() // epoch = 2
            fundingTimestamp = (await ethers.provider.getBlock(tx.blockNumber)).timestamp;
            markTwap = await getTwapPrice(amm, 3600, fundingTimestamp)
            premium = premium.add(markTwap.sub(oracleTwap).div(24))

            const premiumFraction = await amm.cumulativePremiumFraction()
            expect(premiumFraction).to.eq(premium)

            await Promise.all([
                clearingHouse.updatePositions(maker1.address),
                clearingHouse.updatePositions(maker2.address),
                clearingHouse.updatePositions(alice)
            ])

            const fundingPaid = premiumFraction.mul(baseAssetQuantity.mul(-1)).div(_1e18)
            expect(await marginAccount.getNormalizedMargin(alice)).to.eq(margin.add(fundingPaid).sub(fee))
            expect(await marginAccount.getNormalizedMargin(maker1.address)).to.lt(makerMargin.sub(fundingPaid.mul(maker1Liquidity).div(totalSupply)))
            expect(await marginAccount.getNormalizedMargin(maker2.address)).to.lt(makerMargin.sub(fundingPaid.mul(maker2Liquidity).div(totalSupply)))
        })

        it('two makers pos against one another', async function() {
            // alice longs
            await clearingHouse.openPosition(0, _1e18.mul(5), ethers.constants.MaxUint256)
            // maker2 adds liquidity
            await addMargin(maker2, _1e6.mul(1e6))
            await clearingHouse.connect(maker2).addLiquidity(0, _1e18.mul(500), ethers.constants.MaxUint256)
            // alice closes position
            await clearingHouse.openPosition(0, _1e18.mul(-5), 0)
            const { size: maker1Position } = await amm.getNotionalPositionAndUnrealizedPnl(maker1.address)
            const { size: maker2Position } = await amm.getNotionalPositionAndUnrealizedPnl(maker2.address)
            expect(maker1Position).lt(ZERO)
            expect(maker2Position).gt(ZERO)
            expect(maker1Position).to.eq(maker2Position.mul(-1).sub(1)) // round-off

            // underlying: longs will pay shorts
            const oracleTwap = _1e6.mul(900)
            await oracle.setUnderlyingTwapPrice(weth.address, oracleTwap)

            // settle funding
            await clearingHouse.settleFunding()
            await gotoNextFundingTime(amm)
            await clearingHouse.settleFunding()

            const [{ makerFundingPayment: fundingReceived }, { makerFundingPayment: fundingPaid }] = await Promise.all([
                amm.getPendingFundingPayment(maker1.address),
                amm.getPendingFundingPayment(maker2.address)
            ])
            const maker1Funding = (await amm.cumulativePremiumPerDtoken()).mul(maker1Liquidity).div(_1e18)

            await Promise.all([
                clearingHouse.updatePositions(maker1.address),
                clearingHouse.updatePositions(maker2.address),
            ])

            expect(fundingReceived).lt(ZERO)
            expect(fundingReceived).to.eq(maker1Funding)
            // maker2 pays slightly more to account for rouding-off
            expect(fundingPaid).to.gt(maker1Funding.mul(-1))
            expect(await marginAccount.getNormalizedMargin(maker1.address)).to.eq(makerMargin.sub(maker1Funding))
            expect(await marginAccount.getNormalizedMargin(maker2.address)).to.lt(makerMargin.add(_1e6.mul(1e6)).add(maker1Funding))
        })
    })
})

async function assertBounds(v, lowerBound, upperBound) {
    if (lowerBound) expect(v).gt(lowerBound)
    if (upperBound) expect(v).lt(upperBound)
}
