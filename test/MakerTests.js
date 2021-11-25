const { expect } = require('chai');
const utils = require('./utils')

const {
    constants: { _1e6, _1e18, ZERO },
    getTradeDetails,
    setupContracts,
    addMargin,
    assertions
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
        })

        it('maker takes a short counter-position', async () => {
            const baseAssetQuantity = _1e18.mul(5)
            amount = _1e6.mul(5025) // ~5x leverage

            const tx = await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity /* long exactly */, amount /* max_dx */)
            let { quoteAsset } = await getTradeDetails(tx, DEFAULT_TRADE_FEE)

            // after fee is enabled openNotional for short should increase (i.e. higher pnl)
            await assertions(contracts, maker.address, {
                size: baseAssetQuantity.mul(-1),
                // @todo These are hardcoded values for now. Might change after "insufficient liquidity" fix
                notionalPosition: _1e6.mul(2e6),
                openNotional: quoteAsset,
                unrealizedPnl: ZERO
            })

            await clearingHouse.closePosition(0, 0)

            await assertions(contracts, maker.address, {
                size: ZERO,
                notionalPosition: _1e6.mul(2e6),
                openNotional: ZERO,
                unrealizedPnl: ZERO // should fail when fee is enabled, +ve pnl, but position size will be 0??
            })
        })

        it('maker takes a long counter-position', async () => {
            const baseAssetQuantity = _1e18.mul(-5)
            amount = _1e6.mul(4975)

            const tx = await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity /* short exactly */, amount /* min_dy */)
            let { quoteAsset } = await getTradeDetails(tx, DEFAULT_TRADE_FEE)

            await assertions(contracts, maker.address, {
                size: baseAssetQuantity.mul(-1),
                notionalPosition: _1e6.mul(2e6),
                openNotional: quoteAsset,
                unrealizedPnl: ZERO
            })

            await clearingHouse.closePosition(0, ethers.constants.MaxUint256)

            await assertions(contracts, maker.address, {
                size: ZERO,
                notionalPosition: _1e6.mul(2e6),
                openNotional: ZERO,
                unrealizedPnl: ZERO
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
            margin = _1e6.mul(1000)
            await addMargin(signers[0], margin)
        })

        it('makers add equal liquidity', async () => {
            let initialLiquidity = _1e18.mul(1000)
            maker1 = (await ethers.getSigners())[9]
            maker2 = (await ethers.getSigners())[8]
            // adding $2m liquidity in next step, adding $200k margin
            await addMargin(maker1, _1e6.mul(2e5))
            await clearingHouse.connect(maker1).addLiquidity(0, initialLiquidity, ethers.constants.MaxUint256)

            await addMargin(maker2, _1e6.mul(2e5))
            await clearingHouse.connect(maker2).addLiquidity(0, initialLiquidity, ethers.constants.MaxUint256)

            await assertions(contracts, maker1.address, {
                size: ZERO,
                notionalPosition: _1e6.mul(2e6),
                openNotional: ZERO,
                unrealizedPnl: ZERO
            })

            await assertions(contracts, maker2.address, {
                size: ZERO,
                notionalPosition: _1e6.mul(2e6),
                openNotional: ZERO,
                unrealizedPnl: ZERO
            })
        })

        it('makers take a short counter-position', async () => {
            const baseAssetQuantity = _1e18.mul(5)
            amount = _1e6.mul(5025) // ~5x leverage

            const tx = await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity /* long exactly */, amount /* max_dx */)
            let { quoteAsset } = await getTradeDetails(tx, DEFAULT_TRADE_FEE)

            await assertions(contracts, maker1.address, {
                size: baseAssetQuantity.div(-2),
                openNotional: quoteAsset.div(2)
            })
            let { notionalPosition, unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(maker1.address)
            expect(notionalPosition).gt(_1e6.mul(2e6))
            expect(unrealizedPnl).lt(ZERO)

            await assertions(contracts, maker2.address, {
                size: baseAssetQuantity.div(-2),
                openNotional: quoteAsset.div(2)
            })
            ;({ notionalPosition, unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(maker2.address))
            expect(notionalPosition).gt(_1e6.mul(2e6))
            expect(unrealizedPnl).lt(ZERO)

            await clearingHouse.closePosition(0, 0)

            await assertions(contracts, maker1.address, {
                size: ZERO,
                notionalPosition: _1e6.mul(2e6),
                openNotional: ZERO,
                unrealizedPnl: ZERO
            })

            await assertions(contracts, maker2.address, {
                size: ZERO,
                notionalPosition: _1e6.mul(2e6),
                openNotional: ZERO,
                unrealizedPnl: ZERO
            })
        })

        it('makers take a long counter-position', async () => {
            const baseAssetQuantity = _1e18.mul(-5)
            amount = _1e6.mul(4975)

            const tx = await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity /* short exactly */, amount /* min_dy */)
            let { quoteAsset } = await getTradeDetails(tx, DEFAULT_TRADE_FEE)

            await assertions(contracts, maker1.address, {
                size: baseAssetQuantity.div(-2),
                openNotional: quoteAsset.div(2)
            })
            let { notionalPosition, unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(maker1.address)
            expect(notionalPosition).gt(_1e6.mul(2e6))
            expect(unrealizedPnl).lt(ZERO)

            await assertions(contracts, maker2.address, {
                size: baseAssetQuantity.div(-2),
                openNotional: quoteAsset.div(2)
            })
            ;({ notionalPosition, unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(maker2.address))
            expect(notionalPosition).gt(_1e6.mul(2e6))
            expect(unrealizedPnl).lt(ZERO)

            await clearingHouse.closePosition(0, ethers.constants.MaxUint256)

            await assertions(contracts, maker1.address, {
                size: ZERO,
                notionalPosition: _1e6.mul(2e6),
                openNotional: ZERO,
                unrealizedPnl: ZERO
            })

            await assertions(contracts, maker2.address, {
                size: ZERO,
                notionalPosition: _1e6.mul(2e6),
                openNotional: ZERO,
                unrealizedPnl: ZERO
            })
        })
    })

    describe('Two Makers - unequal liquidity', async function() {
        before(async function() {
            signers = await ethers.getSigners()
            ;([ alice ] = signers.map(s => s.address))

            contracts = await setupContracts(DEFAULT_TRADE_FEE, { addLiquidity: false })
            ;({ registry, marginAccount, marginAccountHelper, clearingHouse, amm, vusd, weth, usdc, swap } = contracts)

            // add margin
            margin = _1e6.mul(1000)
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
            await addMargin(maker2, _1e6.mul(1e5))
            await clearingHouse.connect(maker2).addLiquidity(0, initialLiquidity.div(2), ethers.constants.MaxUint256)

            await assertions(contracts, maker1.address, {
                size: ZERO,
                notionalPosition: _1e6.mul(2e6),
                openNotional: ZERO,
                unrealizedPnl: ZERO
            })

            await assertions(contracts, maker2.address, {
                size: ZERO,
                notionalPosition: _1e6.mul(1e6),
                openNotional: ZERO,
                unrealizedPnl: ZERO
            })
        })

        it('makers take a long counter-position', async () => {
            const baseAssetQuantity = _1e18.mul(-5)
            amount = _1e6.mul(4975)

            const tx = await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity /* short exactly */, amount /* min_dy */)
            let { quoteAsset } = await getTradeDetails(tx, DEFAULT_TRADE_FEE)

            await assertions(contracts, maker1.address, {
                size: baseAssetQuantity.mul(-2).div(3),
                openNotional: quoteAsset.mul(2).div(3)
            })
            let { notionalPosition, unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(maker1.address)
            expect(notionalPosition).gt(_1e6.mul(2e6))
            expect(unrealizedPnl).lt(ZERO)

            await assertions(contracts, maker2.address, {
                size: baseAssetQuantity.div(-3),
                openNotional: quoteAsset.div(3)
            })
            ;({ notionalPosition, unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(maker2.address))
            expect(notionalPosition).gt(_1e6.mul(1e6))
            expect(unrealizedPnl).lt(ZERO)

            await clearingHouse.closePosition(0, ethers.constants.MaxUint256)

            await assertions(contracts, maker1.address, {
                size: ZERO,
                notionalPosition: _1e6.mul(2e6),
                openNotional: ZERO,
                unrealizedPnl: ZERO
            })

            await assertions(contracts, maker2.address, {
                size: ZERO,
                notionalPosition: _1e6.mul(1e6),
                openNotional: ZERO,
                unrealizedPnl: ZERO
            })
        })

        it('makers take a short counter-position', async () => {
            const baseAssetQuantity = _1e18.mul(5)
            amount = _1e6.mul(5025) // ~5x leverage

            const tx = await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity /* long exactly */, amount /* max_dx */)
            let { quoteAsset } = await getTradeDetails(tx, DEFAULT_TRADE_FEE)

            await assertions(contracts, maker1.address, {
                size: baseAssetQuantity.mul(-2).div(3).sub(1), // one due to roud-off error during division
                openNotional: quoteAsset.mul(2).div(3).add(1) // one due to roud-off error during division
            })
            let { notionalPosition, unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(maker1.address)
            expect(notionalPosition).gt(_1e6.mul(2e6))
            expect(unrealizedPnl).lt(ZERO)

            await assertions(contracts, maker2.address, {
                size: baseAssetQuantity.div(-3).sub(1), // one due to roud-off error during division
                openNotional: quoteAsset.div(3)
            })
            ;({ notionalPosition, unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(maker2.address))
            expect(notionalPosition).gt(_1e6.mul(1e6))
            expect(unrealizedPnl).lt(ZERO)

            await clearingHouse.closePosition(0, 0)

            await assertions(contracts, maker1.address, {
                size: ZERO,
                notionalPosition: _1e6.mul(2e6),
                openNotional: ZERO,
                unrealizedPnl: ZERO
            })

            await assertions(contracts, maker2.address, {
                size: ZERO,
                notionalPosition: _1e6.mul(1e6),
                openNotional: ZERO,
                unrealizedPnl: ZERO
            })
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
