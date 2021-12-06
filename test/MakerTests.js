const { expect } = require('chai');
const utils = require('./utils')

const {
    constants: { _1e6, _1e12, _1e18, ZERO },
    getTradeDetails,
    setupContracts,
    addMargin,
    assertions,
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
            maker = (await ethers.getSigners())[9]
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

            feeAccumulated = (await swap.balances(0)).sub(initialVusdBalance)
            expect(feeAccumulated).gt(ZERO)
            await assertions(contracts, maker.address, {
                size: ZERO,
                notionalPosition: _1e6.mul(2e6),
                openNotional: ZERO,
                unrealizedPnl: feeAccumulated.div(_1e12)
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
            maker1 = (await ethers.getSigners())[9]
            maker2 = (await ethers.getSigners())[8]
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
            expect(notionalPosition).gt(_1e6.mul(2e6))
            expect(unrealizedPnl).gt(ZERO) // part of fee goes to maker1

            ;({ notionalPosition, unrealizedPnl, size, openNotional } = await amm.getNotionalPositionAndUnrealizedPnl(maker2.address))
            expect(size).to.eq(initialPositionSize.mul(-1).sub(1)) // round off error
            expect(openNotional).to.eq(ZERO)
            expect(notionalPosition).gt(_1e6.mul(2e6))
            expect(unrealizedPnl).lt(ZERO) // fee paid
        })

        it('makers take a short counter-position', async () => {
            const baseAssetQuantity = _1e18.mul(50) // increased to check significant effect of vamm fee
            amount = _1e6.mul(55000)

            const tx = await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity /* long exactly */, amount /* max_dx */)
            let { quoteAsset } = await getTradeDetails(tx, DEFAULT_TRADE_FEE)

            let { notionalPosition, unrealizedPnl, size, openNotional } = await amm.getNotionalPositionAndUnrealizedPnl(maker1.address)
            expect(notionalPosition).gt(_1e6.mul(2e6))
            expect(size).lt(ZERO)
            expect(size).gt(baseAssetQuantity.div(-2))
            expect(openNotional).gt(quoteAsset.div(2)) // higher openNotional, increase pnl
            expect(unrealizedPnl).lt(ZERO)

            ;({ notionalPosition, unrealizedPnl, size, openNotional } = await amm.getNotionalPositionAndUnrealizedPnl(maker2.address))
            expect(notionalPosition).gt(_1e6.mul(2e6))
            expect(size).lt(baseAssetQuantity.div(-2))
            expect(openNotional).lt(quoteAsset.div(2)) // higher openNotional, increase pnl
            expect(unrealizedPnl).lt(ZERO)

            await clearingHouse.closePosition(0, 0)

            ;({ notionalPosition, unrealizedPnl, size, openNotional } = await amm.getNotionalPositionAndUnrealizedPnl(maker1.address))
            expect(notionalPosition).gt(_1e6.mul(2e6))
            expect(size).to.eq(initialPositionSize)
            expect(openNotional).to.eq(ZERO)
            expect(unrealizedPnl).gt(ZERO) // +112.6

            ;({ notionalPosition, unrealizedPnl, size, openNotional } = await amm.getNotionalPositionAndUnrealizedPnl(maker2.address))
            expect(notionalPosition).gt(_1e6.mul(2e6))
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
            expect(notionalPosition).gt(_1e6.mul(2e6))
            expect(size).gt(baseAssetQuantity.div(-2))
            expect(openNotional).gt(ZERO)
            expect(openNotional).lt(quoteAsset.div(2)) // lower openNotional becaue of vamm fee, increase pnl
            expect(unrealizedPnl).lt(ZERO)

            ;({ notionalPosition, unrealizedPnl, size, openNotional } = await amm.getNotionalPositionAndUnrealizedPnl(maker2.address))
            expect(notionalPosition).gt(_1e6.mul(2e6))
            expect(size).gt(ZERO)
            expect(size).lt(baseAssetQuantity.div(-2))
            expect(openNotional).lt(quoteAsset.div(2)) // lower openNotional becaue of vamm fee, increase pnl
            expect(unrealizedPnl).lt(ZERO)

            await clearingHouse.closePosition(0, ethers.constants.MaxUint256)

            ;({ notionalPosition, unrealizedPnl, size, openNotional } = await amm.getNotionalPositionAndUnrealizedPnl(maker1.address))
            expect(notionalPosition).gt(_1e6.mul(2e6))
            expect(size).to.eq(initialPositionSize)
            expect(openNotional).to.eq(ZERO)
            expect(unrealizedPnl).gt(ZERO) // 214.37

            ;({ notionalPosition, unrealizedPnl, size, openNotional } = await amm.getNotionalPositionAndUnrealizedPnl(maker2.address))
            expect(notionalPosition).gt(_1e6.mul(2e6))
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
            maker1 = (await ethers.getSigners())[9]
            maker2 = (await ethers.getSigners())[8]
            // adding $2m liquidity in next step, adding $200k margin
            await addMargin(maker1, _1e6.mul(2e5))
            await clearingHouse.connect(maker1).addLiquidity(0, initialLiquidity, ethers.constants.MaxUint256)

            // maker2 adds $1m liquidity, adding $100k margin
            await addMargin(maker2, _1e6.mul(1.1e5))
            const tx = await clearingHouse.connect(maker2).addLiquidity(0, initialLiquidity.div(2), ethers.constants.MaxUint256)

            const addLiquidityEvent = (await parseRawEvent(tx, swap, 'AddLiquidity')).args
            const totalSupply = addLiquidityEvent.token_supply
            const tokenFee = addLiquidityEvent.fee
            initialPositionSize = initialLiquidity.mul(tokenFee).div(totalSupply)

            let { notionalPosition, unrealizedPnl, size, openNotional } = await amm.getNotionalPositionAndUnrealizedPnl(maker1.address)
            expect(size).to.eq(initialPositionSize)
            expect(openNotional).to.eq(ZERO)
            expect(notionalPosition).gt(_1e6.mul(2e6))
            expect(unrealizedPnl).gt(ZERO) // part of fee goes to maker1

            ;({ notionalPosition, unrealizedPnl, size, openNotional } = await amm.getNotionalPositionAndUnrealizedPnl(maker2.address))
            expect(size).to.eq(initialPositionSize.mul(-1).sub(1)) // round off error
            expect(openNotional).to.eq(ZERO)
            expect(notionalPosition).gt(_1e6.mul(1e6))
            expect(unrealizedPnl).lt(ZERO) // fee paid
        })

        it('makers take a short counter-position', async () => {
            const baseAssetQuantity = _1e18.mul(50)
            amount = _1e6.mul(55000)

            const tx = await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity /* long exactly */, amount /* max_dx */)
            let { quoteAsset } = await getTradeDetails(tx, DEFAULT_TRADE_FEE)

            let { notionalPosition, unrealizedPnl, size, openNotional } = await amm.getNotionalPositionAndUnrealizedPnl(maker1.address)
            expect(notionalPosition).gt(_1e6.mul(2e6))
            expect(size).lt(ZERO)
            expect(size).gt(baseAssetQuantity.mul(-2).div(3))
            expect(openNotional).gt(quoteAsset.mul(2).div(3)) // higher openNotional, increase pnl
            expect(unrealizedPnl).lt(ZERO)

            ;({ notionalPosition, unrealizedPnl, size, openNotional } = await amm.getNotionalPositionAndUnrealizedPnl(maker2.address))
            expect(notionalPosition).gt(_1e6.mul(1e6))
            expect(size).lt(baseAssetQuantity.div(-3))
            expect(openNotional).lt(quoteAsset.div(3)) // higher openNotional, increase pnl
            expect(unrealizedPnl).lt(ZERO)

            await clearingHouse.closePosition(0, 0)

            ;({ notionalPosition, unrealizedPnl, size, openNotional } = await amm.getNotionalPositionAndUnrealizedPnl(maker1.address))
            expect(notionalPosition).gt(_1e6.mul(2e6))
            expect(size).to.eq(initialPositionSize)
            expect(openNotional).to.eq(ZERO)
            expect(unrealizedPnl).gt(ZERO)

            ;({ notionalPosition, unrealizedPnl, size, openNotional } = await amm.getNotionalPositionAndUnrealizedPnl(maker2.address))
            expect(notionalPosition).gt(_1e6.mul(1e6))
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
            expect(notionalPosition).gt(_1e6.mul(2e6))
            expect(size).gt(baseAssetQuantity.mul(-2).div(3))
            expect(openNotional).gt(ZERO)
            expect(openNotional).lt(quoteAsset.mul(2).div(3)) // lower openNotional becaue of vamm fee, increase pnl
            expect(unrealizedPnl).lt(ZERO)

            ;({ notionalPosition, unrealizedPnl, size, openNotional } = await amm.getNotionalPositionAndUnrealizedPnl(maker2.address))
            expect(notionalPosition).gt(_1e6.mul(1e6))
            expect(size).gt(ZERO)
            expect(size).lt(baseAssetQuantity.div(-3))
            expect(openNotional).lt(quoteAsset.div(3)) // lower openNotional becaue of vamm fee, increase pnl
            expect(unrealizedPnl).lt(ZERO)

            await clearingHouse.closePosition(0, ethers.constants.MaxUint256)

            ;({ notionalPosition, unrealizedPnl, size, openNotional } = await amm.getNotionalPositionAndUnrealizedPnl(maker1.address))
            expect(notionalPosition).gt(_1e6.mul(2e6))
            expect(size).to.eq(initialPositionSize)
            expect(openNotional).to.eq(ZERO)
            expect(unrealizedPnl).gt(ZERO)

            ;({ notionalPosition, unrealizedPnl, size, openNotional } = await amm.getNotionalPositionAndUnrealizedPnl(maker2.address))
            expect(notionalPosition).gt(_1e6.mul(1e6))
            expect(size).to.eq(initialPositionSize.mul(-1).sub(1))
            expect(openNotional).gt(ZERO) // positive openNotional for short position because of fee accumulation, increase pnl
            expect(unrealizedPnl).gt(ZERO)
        })

    })

    describe('Maker Liquidation', async function() {
        before(async function() {
            signers = await ethers.getSigners()
            ;([ alice ] = signers.map(s => s.address))
            maker1 = (await ethers.getSigners())[9]
            maker2 = (await ethers.getSigners())[8]

            contracts = await setupContracts(DEFAULT_TRADE_FEE, { addLiquidity: false })
            ;({ registry, marginAccount, marginAccountHelper, clearingHouse, amm, vusd, weth, usdc, swap } = contracts)

            // add margin for alice
            margin = _1e6.mul(1000)
            await addMargin(signers[0], margin)
        })

        it('addCollateral', async () => {
            await oracle.setUnderlyingPrice(weth.address, 1e6 * 2000) // $2k
            await marginAccount.addCollateral(weth.address, 0.7 * 1e6) // weight = 0.7
            expect((await marginAccount.isLiquidatable(maker1.address))[0]).to.be.false
            expect((await marginAccount.isLiquidatable(maker2.address))[0]).to.be.false
        })

        it('addMargin and Liquidity', async () => {
            wethAmount = _1e18.mul(300)
            await weth.mint(alice, wethAmount)
            await weth.approve(marginAccount.address, wethAmount)
            // Add margin for maker1 Cw = 2000 * 100 * 0.7 = $14k
            await marginAccount.addMarginFor(1, wethAmount.div(3), maker1.address)
            await marginAccount.addMarginFor(1, wethAmount.mul(2).div(3), maker2.address)
            // Maker1 add liquidity at 10x leverage and maker2 at 5x
            const initialLiquidity = _1e18.mul(700)
            await clearingHouse.connect(maker1).addLiquidity(0, initialLiquidity, ethers.constants.MaxUint256)
            await clearingHouse.connect(maker2).addLiquidity(0, initialLiquidity, ethers.constants.MaxUint256)
            expect((await marginAccount.isLiquidatable(maker1.address))[0]).to.be.false
            expect((await marginAccount.isLiquidatable(maker2.address))[0]).to.be.false
        })

        it('maker1 falls below maintenance margin', async () => {
            const baseAssetQuantity = _1e18.mul(5)
            amount = _1e6.mul(5025) // ~5x leverage
            // alice longs, makers go short
            await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity /* long exactly */, amount /* max_dx */)
            expect(await clearingHouse.isAboveMaintenanceMargin(maker1.address)).to.be.false
            expect(await clearingHouse.isAboveMaintenanceMargin(maker2.address)).to.be.true
        })
    })
})
