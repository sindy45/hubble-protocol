const { expect } = require('chai');
const utils = require('./utils')

const {
    constants: { _1e6, _1e12, _1e18, ZERO },
    getTradeDetails,
    setupContracts,
    addMargin,
    assertions,
    gotoNextFundingTime,
    parseRawEvent,
    assertBounds,
    BigNumber
} = utils

describe('Maker Tests', async function() {
    describe('Single Maker', async function() {
        before(async function() {
            signers = await ethers.getSigners()
            ;([ alice ] = signers.map(s => s.address))

            contracts = await setupContracts({ amm: { initialLiquidity: 0 } })
            ;({ registry, marginAccount, marginAccountHelper, clearingHouse, amm, vusd, weth, usdc, swap } = contracts)

            // add margin
            margin = _1e6.mul(2000)
            await addMargin(signers[0], margin)
        })

        it('maker adds liquidity', async () => {
            let initialLiquidity = _1e18.mul(1000)
            maker = signers[9]
            // adding $2m liquidity in next step, adding $200k margin
            const amount = _1e6.mul(4e5)
            await addMargin(maker, amount.sub(1))
            await expect(
                clearingHouse.connect(maker).addLiquidity(0, initialLiquidity, 0)
            ).to.be.revertedWith('CH: Below Minimum Allowable Margin')

            await addMargin(maker, 1)
            await clearingHouse.connect(maker).addLiquidity(0, initialLiquidity, 0)
            await assertions(contracts, maker.address, {
                size: ZERO,
                notionalPosition: _1e6.mul(2e6),
                openNotional: ZERO,
                unrealizedPnl: ZERO
            })
            initialVusdBalance = await swap.balances(0, {gasLimit: 100000})
        })

        it('maker takes a short counter-position', async () => {
            const baseAssetQuantity = _1e18.mul(5)
            amount = _1e6.mul(5025)

            const tx = await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity /* long exactly */, amount /* max_dx */)
            let { quoteAsset } = await getTradeDetails(tx)

            // after fee is enabled openNotional for short should increase (i.e. higher pnl)
            await assertions(contracts, maker.address, {
                size: baseAssetQuantity.mul(-1),
                openNotional: quoteAsset,
                // @todo These are hardcoded values for now. Might change after "insufficient liquidity" fix
                notionalPosition: _1e6.mul(2e6),
                unrealizedPnl: ZERO
            })

            await clearingHouse.closePosition(0, 0)

            feeAccumulated = (await swap.balances(0, {gasLimit: 100000})).sub(initialVusdBalance)
            expect(feeAccumulated).gt(ZERO)
            await assertions(contracts, maker.address, {
                size: ZERO,
                notionalPosition: _1e6.mul(2e6),
                openNotional: ZERO,
                unrealizedPnl: feeAccumulated // positive pnl because of vamm fee
            })
        })

        it('maker takes a long counter-position', async () => {
            const baseAssetQuantity = _1e18.mul(-5)
            amount = _1e6.mul(4975)

            const tx = await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity /* short exactly */, amount /* min_dy */)
            let { quoteAsset } = await getTradeDetails(tx)

            await assertions(contracts, maker.address, {
                size: baseAssetQuantity.mul(-1),
                openNotional: quoteAsset.sub(feeAccumulated), // openNotional decreases, hence higher pnl
                notionalPosition: _1e6.mul(2e6),
                unrealizedPnl: ZERO
            })

            await clearingHouse.closePosition(0, ethers.constants.MaxUint256)

            feeAccumulated_2 = (await swap.balances(0, {gasLimit: 100000})).sub(initialVusdBalance).sub(feeAccumulated)
            expect(feeAccumulated_2).gt(ZERO)
            await assertions(contracts, maker.address, {
                size: ZERO,
                notionalPosition: _1e6.mul(2e6),
                openNotional: ZERO,
                unrealizedPnl: feeAccumulated.add(feeAccumulated_2)
            })
        })
    })

    describe('Two Makers - equal liquidity', async function() {
        before(async function() {
            signers = await ethers.getSigners()
            ;([ alice ] = signers.map(s => s.address))

            contracts = await setupContracts({ amm: { initialLiquidity: 0 } })
            ;({ registry, marginAccount, marginAccountHelper, clearingHouse, amm, vusd, weth, usdc, swap, hubbleViewer } = contracts)

            // add margin
            margin = _1e6.mul(20000)
            await addMargin(signers[0], margin)
        })

        it('makers add equal liquidity', async () => {
            let initialLiquidity = _1e18.mul(1000)
            maker1 = signers[9]
            maker2 = signers[8]
            // adding $2m liquidity in next step, adding $200k margin
            await addMargin(maker1, _1e6.mul(4e5))
            await clearingHouse.connect(maker1).addLiquidity(0, initialLiquidity, 0)

            const { dToken } = await hubbleViewer.getMakerQuote(0, initialLiquidity, true, true)
            await addMargin(maker2, _1e6.mul(4.1e5))
            const tx = await clearingHouse.connect(maker2).addLiquidity(0, initialLiquidity, dToken)

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
            let { quoteAsset } = await getTradeDetails(tx)

            let { notionalPosition, unrealizedPnl, size, openNotional } = await amm.getNotionalPositionAndUnrealizedPnl(maker1.address)
            expect(notionalPosition).eq(_1e6.mul(2e6))
            expect(size).lt(ZERO)
            expect(size).gt(baseAssetQuantity.div(-2))
            expect(openNotional).gt(quoteAsset.div(2)) // higher openNotional, increase pnl
            expect(unrealizedPnl).lt(ZERO)

            const [ maker1Pos ] = await hubbleViewer.makerPositions(maker1.address)
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
            let { quoteAsset } = await getTradeDetails(tx)

            let { notionalPosition, unrealizedPnl, size, openNotional } = await amm.getNotionalPositionAndUnrealizedPnl(maker1.address)
            expect(notionalPosition).eq(_1e6.mul(2e6))
            expect(size).gt(baseAssetQuantity.div(-2))
            expect(openNotional).gt(ZERO)
            expect(openNotional).lt(quoteAsset.div(2)) // lower openNotional becaue of vamm fee, increase pnl
            expect(unrealizedPnl).lt(ZERO)

            const [ maker1Pos ] = await hubbleViewer.makerPositions(maker1.address)
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

            contracts = await setupContracts({ amm: { initialLiquidity: 0 } })
            ;({ registry, marginAccount, marginAccountHelper, clearingHouse, amm, vusd, weth, usdc, swap, hubbleViewer } = contracts)

            // add margin
            margin = _1e6.mul(20000)
            await addMargin(signers[0], margin)
        })

        it('makers add unequal liquidity', async () => {
            let initialLiquidity = _1e18.mul(1000)
            maker1 = signers[9]
            maker2 = signers[8]
            // adding $2m liquidity in next step, adding $200k margin
            await addMargin(maker1, _1e6.mul(4e5))
            await clearingHouse.connect(maker1).addLiquidity(0, initialLiquidity, 0)

            // maker2 adds $1m liquidity, adding $100k margin
            const { dToken } = await hubbleViewer.getMakerQuote(0, initialLiquidity.div(2), true, true)
            await addMargin(maker2, _1e6.mul(2.1e5))
            const tx = await clearingHouse.connect(maker2).addLiquidity(0, initialLiquidity.div(2), dToken)

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
            let { quoteAsset } = await getTradeDetails(tx)

            const [{ vAsset, vUSD, totalDeposited, dToken: maker1Liquidity }, vUSDBalance] = await Promise.all([
                hubbleViewer.getMakerLiquidity(maker1.address, 0),
                swap.balances(0, {gasLimit: 100000})
            ])
            expect(totalDeposited).to.eq(_1e6.mul(2e6))
            // base balance in pool = 1000 + 500 - 50 = 1450
            expect(vAsset).to.eq(_1e18.mul(1450).mul(maker1Liquidity).div(totalSupply))
            // quote balance in pool = 1m + 0.5m + quoteAsset
            expect(vUSD).to.eq(vUSDBalance.mul(maker1Liquidity).div(totalSupply))

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
            let { quoteAsset } = await getTradeDetails(tx)

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

            contracts = await setupContracts({ amm: { initialLiquidity: 0 } })
            ;({ registry, marginAccount, marginAccountHelper, clearingHouse, amm, vusd, weth, usdc, swap, hubbleViewer } = contracts)

            // add margin
            margin = _1e6.mul(2100)
            await addMargin(signers[0], margin)
            // add liquidity
            maker1 = signers[9]
            maker2 = signers[8]
            maker1Margin = _1e6.mul(4e5)
            const initialLiquidity = _1e18.mul(1000)
            await addMargin(maker1, maker1Margin)
            await addMargin(maker2, _1e6.mul(4.1e5))
            await clearingHouse.connect(maker1).addLiquidity(0, initialLiquidity, 0)
            await clearingHouse.connect(maker2).addLiquidity(0, initialLiquidity, 0)
            totalSupply = await swap.totalSupply({gasLimit: 100000})
        })

        it('remove liquidity - maker short', async function() {
            const maker1Liquidity = (await amm.makers(maker1.address)).dToken
            // alice longs
            const baseAssetQuantity = _1e18.mul(10)
            const amount = await hubbleViewer.getQuote(baseAssetQuantity, 0)
            let tx = await clearingHouse.openPosition(0, baseAssetQuantity, amount)
            let { quoteAsset } = await getTradeDetails(tx)
            // maker1 removes all liquidity
            const { baseAsset: minBase, quoteAsset: minQuote } = await hubbleViewer.calcWithdrawAmounts(maker1Liquidity, 0)
            tx = await clearingHouse.connect(maker1).removeLiquidity(0, maker1Liquidity, minQuote, minBase)
            const { realizedPnl } = (await parseRawEvent(tx, amm, 'LiquidityRemoved')).args

            expect(realizedPnl).to.eq(ZERO) // no reducePosition, fee profit is less than market loss
            const maker1Position = await amm.positions(maker1.address)
            const _maker1 = await amm.makers(maker1.address)

            let lowerBound = baseAssetQuantity.div(-2)
            let upperBound = lowerBound.sub(lowerBound.div(1e3))
            await assertBounds(maker1Position.size, lowerBound, upperBound)

            lowerBound = quoteAsset.div(2)
            upperBound = lowerBound.add(lowerBound.mul(2).div(1e3))
            await assertBounds(maker1Position.openNotional, lowerBound, upperBound) // higher openNotional, increase pnl

            expect(_maker1.dToken).eq(ZERO)
            expect(_maker1.pos).eq(ZERO)
            expect(_maker1.posAccumulator).eq(baseAssetQuantity.mul(_1e18).mul(-1).div(totalSupply))

            const { takerNotionalPosition, unrealizedPnl } = await amm.getTakerNotionalPositionAndUnrealizedPnl(maker1.address)
            lowerBound = quoteAsset.div(2)
            upperBound = lowerBound.add(lowerBound.div(1e3))

            await assertBounds(takerNotionalPosition, lowerBound, upperBound)
            await assertBounds(unrealizedPnl, ZERO, _1e6.mul(10))

            expect(await marginAccount.getNormalizedMargin(maker1.address)).to.eq(maker1Margin)
        })

        it('remove liquidity - maker long', async function() {
            const maker1Liquidity = (await amm.makers(maker1.address)).dToken
            // alice shorts
            const baseAssetQuantity = _1e18.mul(-10)
            const amount = await hubbleViewer.getQuote(baseAssetQuantity, 0)
            let tx = await clearingHouse.openPosition(0, baseAssetQuantity, amount)
            let { quoteAsset } = await getTradeDetails(tx)
            // maker1 removes all liquidity
            const { baseAsset: minBase, quoteAsset: minQuote } = await hubbleViewer.calcWithdrawAmounts(maker1Liquidity, 0)
            tx = await clearingHouse.connect(maker1).removeLiquidity(0, maker1Liquidity, minQuote, minBase)
            const { realizedPnl } = (await parseRawEvent(tx, amm, 'LiquidityRemoved')).args

            expect(realizedPnl).to.eq(ZERO) // no reducePosition, fee profit is less than market loss
            const maker1Position = await amm.positions(maker1.address)
            const _maker1 = await amm.makers(maker1.address)

            let lowerBound = baseAssetQuantity.div(-2)
            let upperBound = lowerBound.add(lowerBound.mul(2).div(1e3))
            await assertBounds(maker1Position.size, lowerBound, upperBound)

            upperBound = quoteAsset.div(2)
            lowerBound = upperBound.sub(upperBound.div(1e3))
            await assertBounds(maker1Position.openNotional, lowerBound, upperBound) // lower openNotional becaue of vamm fee, increase pnl

            expect(_maker1.dToken).eq(ZERO)
            expect(_maker1.pos).eq(ZERO)
            expect(_maker1.posAccumulator).eq(baseAssetQuantity.mul(_1e18).mul(-1).div(totalSupply))

            const { takerNotionalPosition, unrealizedPnl } = await amm.getTakerNotionalPositionAndUnrealizedPnl(maker1.address)
            upperBound = quoteAsset.div(2)
            lowerBound = upperBound.sub(upperBound.div(1e3))

            await assertBounds(takerNotionalPosition, lowerBound, upperBound)
            await assertBounds(unrealizedPnl, ZERO, _1e6.mul(10))

            expect(await marginAccount.getNormalizedMargin(maker1.address)).to.eq(maker1Margin)
        })
    })

    describe('Taker + Maker', async function() {
        beforeEach(async function() {
            signers = await ethers.getSigners()
            ;([ alice ] = signers.map(s => s.address))

            contracts = await setupContracts({ amm: { initialLiquidity: 0 } })
            ;({ registry, marginAccount, marginAccountHelper, clearingHouse, amm, vusd, weth, usdc, swap, hubbleViewer } = contracts)

            // add margin
            margin = _1e6.mul(2200)
            await addMargin(signers[0], margin)
            // add liquidity
            maker1 = signers[9]
            maker2 = signers[8]
            maker1Margin = _1e6.mul(4.1e5)
            const initialLiquidity = _1e18.mul(1000)
            await addMargin(maker1, maker1Margin)
            await addMargin(maker2, maker1Margin)
            await clearingHouse.connect(maker1).addLiquidity(0, initialLiquidity, 0)
            await clearingHouse.connect(maker2).addLiquidity(0, initialLiquidity, 0)
            totalSupply = await swap.totalSupply({gasLimit: 100000})
        })

        it('increase net position - short -> bigger short', async function () {
            // alice longs
            let baseAssetQuantity = _1e18.mul(10)
            let amount = await hubbleViewer.getQuote(baseAssetQuantity, 0)
            let tx = await clearingHouse.openPosition(0, baseAssetQuantity, amount)
            const { quoteAsset } = await getTradeDetails(tx)
            let positionAccumulator = baseAssetQuantity.mul(_1e18).div(totalSupply).mul(-1)

            // maker1 shorts as taker
            baseAssetQuantity = _1e18.mul(-5)
            amount = await hubbleViewer.getQuote(baseAssetQuantity, 0)
            tx = await clearingHouse.connect(maker1).openPosition(0, baseAssetQuantity, amount)
            ;({ quoteAsset: takerQuote } = await getTradeDetails(tx))
            positionAccumulator = positionAccumulator.sub(baseAssetQuantity.mul(_1e18).div(totalSupply))

            let takerPosition = await amm.positions(maker1.address)
            expect(takerPosition.size).to.eq(baseAssetQuantity)
            expect(takerPosition.openNotional).to.eq(takerQuote)

            let { notionalPosition, unrealizedPnl, size, openNotional } = await amm.getNotionalPositionAndUnrealizedPnl(maker1.address)
             // -10/2 + 5/2 - 5 + noise = -7.495. Maker takes a long position of 2.5 during trade as taker, hence reducing their position
            assertBounds(size, _1e18.mul(-75).div(10), _1e18.mul(-7))
            expect(openNotional).gt(takerQuote.add(quoteAsset.sub(takerQuote).div(2))) // makerOpenNotional = (quoteAsset - takerQuote) / 2, reducing impermanent position during trades, side remains same
            //  maker +pnl < taker -pnl after removing maker1 liquidity
            assertBounds(unrealizedPnl, _1e6.mul(-5), ZERO) // -3.33

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
            let amount = await hubbleViewer.getQuote(baseAssetQuantity, 0)
            let tx = await clearingHouse.openPosition(0, baseAssetQuantity, amount)
            const { quoteAsset } = await getTradeDetails(tx)
            let positionAccumulator = baseAssetQuantity.mul(_1e18).div(totalSupply).mul(-1)

            // maker1 longs as taker
            baseAssetQuantity = _1e18.mul(5)
            amount = await hubbleViewer.getQuote(baseAssetQuantity, 0)
            tx = await clearingHouse.connect(maker1).openPosition(0, baseAssetQuantity, amount)
            ;({ quoteAsset: takerQuote } = await getTradeDetails(tx))
            positionAccumulator = positionAccumulator.sub(baseAssetQuantity.mul(_1e18).div(totalSupply))

            let takerPosition = await amm.positions(maker1.address)
            expect(takerPosition.size).to.eq(baseAssetQuantity)
            expect(takerPosition.openNotional).to.eq(takerQuote)

            let { notionalPosition, unrealizedPnl, size, openNotional } = await amm.getNotionalPositionAndUnrealizedPnl(maker1.address)
            // 10/2 - 5/2 + 5 + noise = 7.505
            assertBounds(size, _1e18.mul(75).div(10), _1e18.mul(8))
            expect(openNotional).gt(ZERO)
            expect(openNotional).lt(takerQuote.add(quoteAsset.sub(takerQuote).div(2))) // makerOpenNotional = (quoteAsset - takerQuote) / 2, reducing impermanent position during trades, side remains same
            //  maker +pnl < taker -pnl after removing maker1 liquidity
            assertBounds(unrealizedPnl, _1e6.mul(-5), ZERO) // -3.30
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
            let amount = await hubbleViewer.getQuote(baseAssetQuantity, 0)
            await clearingHouse.openPosition(0, baseAssetQuantity, amount)
            let positionAccumulator = baseAssetQuantity.mul(_1e18).div(totalSupply).mul(-1)

            // maker1 shorts as taker
            baseAssetQuantity = _1e18.mul(-10)
            amount = await hubbleViewer.getQuote(baseAssetQuantity, 0)
            let tx = await clearingHouse.connect(maker1).openPosition(0, baseAssetQuantity, amount)
            ;({ quoteAsset: takerQuote, fee } = await getTradeDetails(tx))
            positionAccumulator = positionAccumulator.sub(baseAssetQuantity.mul(_1e18).div(totalSupply))

            let takerPosition = await amm.positions(maker1.address)
            expect(takerPosition.size).to.eq(baseAssetQuantity)
            expect(takerPosition.openNotional).to.eq(takerQuote)
            const {
                position: maker1Position,
                openNotional: maker1OpenNotional
            } = await hubbleViewer.getMakerPositionAndUnrealizedPnl(maker1.address, 0) // maker1 impermanent position
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
            let amount = await hubbleViewer.getQuote(baseAssetQuantity, 0)
            await clearingHouse.openPosition(0, baseAssetQuantity, amount)
            let positionAccumulator = baseAssetQuantity.mul(_1e18).div(totalSupply).mul(-1)

            // maker1 longs as taker
            baseAssetQuantity = _1e18.mul(10)
            amount = await hubbleViewer.getQuote(baseAssetQuantity, 0)
            let tx = await clearingHouse.connect(maker1).openPosition(0, baseAssetQuantity, amount)
            ;({ quoteAsset: takerQuote, fee } = await getTradeDetails(tx))
            positionAccumulator = positionAccumulator.sub(baseAssetQuantity.mul(_1e18).div(totalSupply))

            let takerPosition = await amm.positions(maker1.address)
            expect(takerPosition.size).to.eq(baseAssetQuantity)
            expect(takerPosition.openNotional).to.eq(takerQuote)
            const {
                position: maker1Position,
                openNotional: maker1OpenNotional
            } = await hubbleViewer.getMakerPositionAndUnrealizedPnl(maker1.address, 0) // maker1 impermanent position
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
            await addMargin(signers[0], _1e6.mul(1000))
            let baseAssetQuantity = _1e18.mul(-15)
            let amount = await hubbleViewer.getQuote(baseAssetQuantity, 0)
            let tx = await clearingHouse.openPosition(0, baseAssetQuantity, amount)
            let { quoteAsset } = await getTradeDetails(tx)
            let positionAccumulator = baseAssetQuantity.mul(_1e18).div(totalSupply).mul(-1)

            // maker1 shorts as taker
            baseAssetQuantity = _1e18.mul(-5)
            amount = await hubbleViewer.getQuote(baseAssetQuantity, 0)
            tx = await clearingHouse.connect(maker1).openPosition(0, baseAssetQuantity, amount)
            ;({ quoteAsset: takerQuote, fee } = await getTradeDetails(tx))
            positionAccumulator = positionAccumulator.sub(baseAssetQuantity.mul(_1e18).div(totalSupply))

            let takerPosition = await amm.positions(maker1.address)
            expect(takerPosition.size).to.eq(baseAssetQuantity)
            expect(takerPosition.openNotional).to.eq(takerQuote)
            const {
                position: maker1Position,
                openNotional: maker1OpenNotional
            } = await hubbleViewer.getMakerPositionAndUnrealizedPnl(maker1.address, 0) // maker1 impermanent position
            assertBounds(maker1Position, _1e18.mul(10), _1e18.mul(105).div(10)) // 15/2 + 5/2 + noise
            expect(maker1OpenNotional).lt(quoteAsset.add(takerQuote).div(2)) // a little more than 1/2 share of maker1 in the pool, hence openNotional is less in case of long

            let { unrealizedPnl, size, openNotional } = await amm.getNotionalPositionAndUnrealizedPnl(maker1.address)
            // size = 15/2 + 5/2 - 5 + noise = 5.005
            assertBounds(size, _1e18.mul(5), _1e18.mul(55).div(10))
            assertBounds(unrealizedPnl, _1e6.mul(-30), _1e6.mul(-20)) // -25.43, due to vamm fee
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
            await addMargin(signers[0], _1e6.mul(1000))
            let baseAssetQuantity = _1e18.mul(15)
            let amount = await hubbleViewer.getQuote(baseAssetQuantity, 0)
            let tx = await clearingHouse.openPosition(0, baseAssetQuantity, amount)
            let { quoteAsset } = await getTradeDetails(tx)
            let positionAccumulator = baseAssetQuantity.mul(_1e18).div(totalSupply).mul(-1)

            // maker1 longs as taker
            baseAssetQuantity = _1e18.mul(5)
            amount = await hubbleViewer.getQuote(baseAssetQuantity, 0)
            tx = await clearingHouse.connect(maker1).openPosition(0, baseAssetQuantity, amount)
            ;({ quoteAsset: takerQuote, fee } = await getTradeDetails(tx))
            positionAccumulator = positionAccumulator.sub(baseAssetQuantity.mul(_1e18).div(totalSupply))

            let takerPosition = await amm.positions(maker1.address)
            expect(takerPosition.size).to.eq(baseAssetQuantity)
            expect(takerPosition.openNotional).to.eq(takerQuote)
            const {
                position: maker1Position,
                openNotional: maker1OpenNotional
            } = await hubbleViewer.getMakerPositionAndUnrealizedPnl(maker1.address, 0) // maker1 impermanent position
            assertBounds(maker1Position, _1e18.mul(-10), _1e18.mul(-95).div(10)) // -15/2 - 5/2 + noise
            expect(maker1OpenNotional).gt(quoteAsset.add(takerQuote).div(2)) // a little more than 1/2 share of maker1 in the pool, hence openNotional is more in case of short

            let { unrealizedPnl, size, openNotional } = await amm.getNotionalPositionAndUnrealizedPnl(maker1.address)
            // sizr = -15/2 - 5/2 + 5 + noise = -4.995
            assertBounds(size, _1e18.mul(-5), _1e18.mul(-45).div(10))
            assertBounds(unrealizedPnl, _1e6.mul(-30), _1e6.mul(-20)) // -25.43, due to vamm fee
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

            contracts = await setupContracts({ amm: { initialLiquidity: 0 } })
            ;({ registry, marginAccount, marginAccountHelper, clearingHouse, amm, vusd, insuranceFund, usdc, swap, hubbleViewer } = contracts)

            // add margin
            margin = _1e6.mul(42000)
            await addMargin(signers[0], margin)
            // add liquidity
            ;([ maker3, maker2, maker1 ] = signers.slice(7))
            maker1Margin = _1e6.mul(4.1e5)
            const initialLiquidity = _1e18.mul(1000)
            await addMargin(maker1, maker1Margin)
            await addMargin(maker2, maker1Margin)
            await clearingHouse.connect(maker1).addLiquidity(0, initialLiquidity, 0)
            await clearingHouse.connect(maker2).addLiquidity(0, initialLiquidity, 0)
            maintenanceMargin = await clearingHouse.maintenanceMargin()
        })

        it('taker-notLiquidable, maker-Liquidable', async function() {
            // maker3 adds Liquidity
            const maker3Margin = _1e6.mul(8150)
            await addMargin(maker3, maker3Margin)
            const amount = _1e18.mul(5)
            const { dToken } = await hubbleViewer.getMakerQuote(0, amount, true, true)
            await clearingHouse.connect(maker3).addLiquidity(0, amount, dToken)
            // maker3 longs
            const baseAssetQuantity = _1e18.mul(30)
            let tx = await clearingHouse.connect(maker3).openPosition(0, baseAssetQuantity, ethers.constants.MaxUint256)
            const { fee } = await getTradeDetails(tx)

            expect(await clearingHouse.isAboveMaintenanceMargin(maker3.address)).to.be.true // taker+maker marginFraction > MM
            await expect(clearingHouse.liquidateMaker(maker3.address)).to.be.revertedWith('CH: Above Maintenance Margin')
            // alice shorts
            await clearingHouse.openPosition(0, _1e18.mul(-200), 0)

            expect(await clearingHouse.isAboveMaintenanceMargin(maker3.address)).to.be.false // taker+maker marginFraction < MM
            const initialIFBalance = await vusd.balanceOf(insuranceFund.address)

            // liquidate maker position
            await expect(clearingHouse.liquidateTaker(maker3.address)).to.be.revertedWith('CH: Remove Liquidity First')
            const { position: maker3Pos } = await hubbleViewer.getMakerPositionAndUnrealizedPnl(maker3.address, 0)
            tx = await clearingHouse.connect(signers[2]).liquidateMaker(maker3.address)
            const { realizedPnl, quoteAsset } = (await parseRawEvent(tx, amm, 'LiquidityRemoved')).args

            const liquidationPenalty = quoteAsset.mul(2).mul(5e4).div(_1e6)
            const toInsurance = liquidationPenalty.div(2)
            expect(await vusd.balanceOf(signers[2].address)).to.eq(liquidationPenalty.sub(toInsurance)) // liquidation penalty
            expect(await vusd.balanceOf(insuranceFund.address)).to.eq(toInsurance.add(initialIFBalance))
            expect(await marginAccount.margin(0, maker3.address)).eq(maker3Margin.sub(fee).add(realizedPnl).sub(liquidationPenalty))

            const makerPosition = await amm.makers(maker3.address)
            expect(makerPosition.vAsset).to.eq(ZERO)
            expect(makerPosition.vUSD).to.eq(ZERO)
            expect(makerPosition.dToken).to.eq(ZERO)
            expect(makerPosition.pos).to.eq(ZERO)
            // impermanent position converted into permanent
            expect((await amm.positions(maker3.address)).size).to.eq(maker3Pos.add(baseAssetQuantity))
            await expect(clearingHouse.liquidateTaker(maker3.address)).to.be.revertedWith('Above Maintenance Margin')
        })

        it('taker-Liquidable, maker-notLiquidable', async function() {
            // maker3 adds Liquidity
            const maker3Margin = _1e6.mul(4500)
            await addMargin(maker3, maker3Margin)
            const { dToken } = await hubbleViewer.getMakerQuote(0, _1e18, true, true)
            await clearingHouse.connect(maker3).addLiquidity(0, _1e18, dToken)
            // maker3 longs
            const baseAssetQuantity = _1e18.mul(20)
            let tx = await clearingHouse.connect(maker3).openPosition(0, baseAssetQuantity, ethers.constants.MaxUint256)
            const { fee } = await getTradeDetails(tx)

            expect(await clearingHouse.isAboveMaintenanceMargin(maker3.address)).to.be.true // taker+maker marginFraction > MM
            // alice shorts
            await clearingHouse.openPosition(0, _1e18.mul(-200), 0)

            expect(await clearingHouse.isAboveMaintenanceMargin(maker3.address)).to.be.false // taker+maker marginFraction < MM
            const initialIFBalance = await vusd.balanceOf(insuranceFund.address)

            await expect(clearingHouse.liquidateTaker(maker3.address)).to.be.revertedWith('CH: Remove Liquidity First')
            const { position: maker3Pos } = await hubbleViewer.getMakerPositionAndUnrealizedPnl(maker3.address, 0)
            tx = await clearingHouse.connect(signers[3]).liquidateMaker(maker3.address)
            const { realizedPnl, quoteAsset } = (await parseRawEvent(tx, amm, 'LiquidityRemoved')).args

            let liquidationPenalty = quoteAsset.mul(2).mul(5e4).div(_1e6)
            let toInsurance = liquidationPenalty.div(2)
            expect(await vusd.balanceOf(signers[3].address)).to.eq(liquidationPenalty.sub(toInsurance)) // liquidation penalty
            expect(await vusd.balanceOf(insuranceFund.address)).to.eq(toInsurance.add(initialIFBalance))
            expect(await marginAccount.margin(0, maker3.address)).eq(maker3Margin.sub(fee).add(realizedPnl).sub(liquidationPenalty))

            const makerPosition = await amm.makers(maker3.address)
            expect(makerPosition.vAsset).to.eq(ZERO)
            expect(makerPosition.vUSD).to.eq(ZERO)
            expect(makerPosition.dToken).to.eq(ZERO)
            expect(makerPosition.pos).to.eq(ZERO)
            // impermanent position converted into permanent
            expect((await amm.positions(maker3.address)).size).to.eq(maker3Pos.add(baseAssetQuantity))

            const { notionalPosition } = await amm.getNotionalPositionAndUnrealizedPnl(maker3.address)
            // liquidate taker
            await clearingHouse.connect(signers[2]).liquidateTaker(maker3.address)

            liquidationPenalty = notionalPosition.mul(5e4).div(_1e6)
            toInsurance = liquidationPenalty.div(2)
            expect(await vusd.balanceOf(signers[2].address)).to.eq(liquidationPenalty.sub(toInsurance)) // liquidation penalty
            expect((await amm.positions(maker3.address)).size).to.eq(ZERO)
        })
    })

    describe('Funding', async function() {
        beforeEach(async function() {
            signers = await ethers.getSigners()
            ;([ alice ] = signers.map(s => s.address))

            contracts = await setupContracts({ amm: { initialLiquidity: 0 } })
            ;({ registry, marginAccount, marginAccountHelper, clearingHouse, amm, vusd, weth, usdc, swap, hubbleViewer } = contracts)

            // add margin
            margin = _1e6.mul(2000)
            await addMargin(signers[0], margin)
            // add liquidity
            maker1 = signers[9]
            maker2 = signers[8]
            makerMargin = _1e6.mul(4.1e5)
            const initialLiquidity = _1e18.mul(1000)
            await addMargin(maker1, makerMargin)
            await addMargin(maker2, makerMargin)

            await clearingHouse.connect(maker1).addLiquidity(0, initialLiquidity, 0)
            await clearingHouse.connect(maker2).addLiquidity(0, initialLiquidity, 0)
            await gotoNextFundingTime(amm)
            ;([{ dToken: maker1Liquidity }, { dToken: maker2Liquidity }] = await Promise.all([
                amm.makers(maker1.address),
                amm.makers(maker2.address)
            ]))
            totalSupply = await swap.totalSupply({gasLimit: 100000})
        })

        it('makers pay and alice receive funding', async function() {
            const baseAssetQuantity = _1e18.mul(-5)
            let tx = await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity, _1e6.mul(4975))
            ;({ quoteAsset, fee } = await getTradeDetails(tx))

            // underlying
            const oracleTwap = _1e6.mul(900)
            await oracle.setUnderlyingTwapPrice(weth.address, oracleTwap)

            await clearingHouse.settleFunding() // funding event - 1
            await gotoNextFundingTime(amm)

            await clearingHouse.settleFunding() // funding event - 2
            const premium = await amm.cumulativePremiumFraction()

            await Promise.all([
                clearingHouse.updatePositions(maker1.address),
                clearingHouse.updatePositions(maker2.address),
                clearingHouse.updatePositions(alice)
            ])

            const fundingPaid = premium.mul(baseAssetQuantity.mul(-1)).div(_1e18)
            const fundingReceived = getAdjustedFunding(fundingPaid)

            expect(await marginAccount.getNormalizedMargin(alice)).to.eq(margin.add(fundingReceived).sub(fee))

            let upperBound = makerMargin.sub(fundingPaid.mul(maker1Liquidity).div(totalSupply))
            let lowerBound = upperBound.sub(upperBound.div(1e7))
            await assertBounds(await marginAccount.getNormalizedMargin(maker1.address), lowerBound, upperBound)
            upperBound = makerMargin.sub(fundingPaid.mul(maker2Liquidity).div(totalSupply))
            lowerBound = upperBound.sub(upperBound.div(1e7))
            await assertBounds(await marginAccount.getNormalizedMargin(maker2.address), lowerBound, upperBound)
            expect(fundingPaid).gte(fundingReceived)
        })

        it('alice pay and makers receive funding', async function() {
            const baseAssetQuantity = _1e18.mul(-5)
            let tx = await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity, _1e6.mul(4975))
            ;({ quoteAsset, fee } = await getTradeDetails(tx))

            // underlying
            const oracleTwap = _1e6.mul(1100)
            await oracle.setUnderlyingTwapPrice(weth.address, oracleTwap)

            await clearingHouse.settleFunding() // funding event - 1
            await gotoNextFundingTime(amm)

            await clearingHouse.settleFunding() // funding event - 2
            const premium = await amm.cumulativePremiumFraction()

            await Promise.all([
                clearingHouse.updatePositions(maker1.address),
                clearingHouse.updatePositions(maker2.address),
                clearingHouse.updatePositions(alice)
            ])

            const fundingPaid = premium.mul(baseAssetQuantity).div(_1e18)
            expect(await marginAccount.getNormalizedMargin(alice)).to.eq(margin.sub(fundingPaid).sub(fee))
            const fundingReceived = getAdjustedFunding(fundingPaid)

            let upperBound = makerMargin.add(fundingReceived.mul(maker1Liquidity).div(totalSupply))
            let lowerBound = upperBound.sub(upperBound.div(1e6))
            const maker1Margin = await marginAccount.getNormalizedMargin(maker1.address)
            await assertBounds(maker1Margin, lowerBound, upperBound)
            upperBound = makerMargin.add(fundingReceived.mul(maker2Liquidity).div(totalSupply))
            lowerBound = upperBound.sub(upperBound.div(1e6))
            await assertBounds(await marginAccount.getNormalizedMargin(maker2.address), lowerBound, upperBound)
            expect(fundingPaid).gte(fundingReceived)
        })

        it('maker+taker, makers pay', async function() {
            // maker1, alice longs
            const baseAssetQuantity = _1e18.mul(5)
            await Promise.all([
                clearingHouse.connect(maker1).openPosition(0, baseAssetQuantity, await hubbleViewer.getQuote(baseAssetQuantity, 0)),
                clearingHouse.openPosition(0, baseAssetQuantity, await hubbleViewer.getQuote(baseAssetQuantity, 0)),
            ])

            // underlying, shorts pay longs
            let oracleTwap = _1e6.mul(1100)
            await oracle.setUnderlyingTwapPrice(weth.address, oracleTwap)

            let tx = await clearingHouse.settleFunding() // funding event - 1
            let premium = (await parseRawEvent(tx, amm, 'FundingRateUpdated')).args.premiumFraction
            await gotoNextFundingTime(amm)

            let [
                {
                    takerFundingPayment: maker1TakerFunding,
                    makerFundingPayment: maker1MakerFunding
                },
                { makerFundingPayment: maker2Funding },
                { takerFundingPayment: aliceFunding }
            ] = await Promise.all([
                amm.getPendingFundingPayment(maker1.address),
                amm.getPendingFundingPayment(maker2.address),
                amm.getPendingFundingPayment(alice)
            ])

            // let's assert for takers
            let fundingPayment = premium.mul(baseAssetQuantity).div(_1e18) // -ve
            expect(maker1TakerFunding).to.eq(fundingPayment)
            expect(aliceFunding).to.eq(fundingPayment)

            // let's assert for makers
            let fundingPaymentAbs = fundingPayment.abs()
            assertBounds(maker1MakerFunding, roundDown(fundingPaymentAbs), roundUp(fundingPaymentAbs))
            assertBounds(maker2Funding, roundDown(fundingPaymentAbs), roundUp(fundingPaymentAbs))

            // maker1's net position = 5 (as a taker) - 2.5 - 2.5 (as a maker) = 0
            await assertBounds(maker1TakerFunding.abs(), maker1MakerFunding.sub(1e5), maker1MakerFunding.add(1e5)) // round-off quirk

            // overall funding assertions
            let netFundingPaid = maker1MakerFunding.add(maker2Funding).abs()
            let netFundingReceived = aliceFunding.add(maker1TakerFunding).abs() // = 2 * fundingPayment
            netFundingReceived = getAdjustedFunding(netFundingReceived) // 0.1% charged from receivers
            expect(netFundingPaid).gte(netFundingReceived) // protocol shouldn't go in a deficit

            // maker1 removes 1/3 liquidity
            const { quoteAsset, baseAsset } = await hubbleViewer.calcWithdrawAmounts(maker1Liquidity.div(3), 0)
            await clearingHouse.connect(maker1).removeLiquidity(0, maker1Liquidity.div(3), quoteAsset, baseAsset.sub(1))

            tx = await clearingHouse.settleFunding() // funding event - 2
            const premium2 = (await parseRawEvent(tx, amm, 'FundingRateUpdated')).args.premiumFraction

            premium = await amm.cumulativePremiumFraction()

            tx = await clearingHouse.updatePositions(maker1.address)
            ;({
                takerFundingPayment: maker1TakerFunding,
                makerFundingPayment: maker1MakerFunding
            } = (await parseRawEvent(tx, amm, 'FundingPaid')).args)

            tx = await clearingHouse.updatePositions(maker2.address)
            ;({ makerFundingPayment: maker2Funding } = (await parseRawEvent(tx, amm, 'FundingPaid')).args)

            tx = await clearingHouse.updatePositions(alice)
            ;({ takerFundingPayment: aliceFunding } = (await parseRawEvent(tx, amm, 'FundingPaid')).args)


            // maker1 was 5 long as a taker and 5 short as a maker
            // after removing a 3rd of their liquidity, their net taker position = 5 - 5/3 = ~3.33
            const { size: maker1Pos } = await amm.positions(maker1.address)
            expect(ethers.utils.formatUnits(maker1Pos, 18).slice(0, 4)).to.eq('3.33')

            // let's assert for takers
            expect(maker1TakerFunding).to.eq(premium2.mul(maker1Pos).div(_1e18))
            expect(aliceFunding).to.eq(premium.mul(baseAssetQuantity).div(_1e18))

            // maker1's net position is still ~0
            await assertBounds(maker1TakerFunding.abs(), maker1MakerFunding.sub(1e5), maker1MakerFunding.add(1e5)) // round-off quirk

            // overall funding assertions
            netFundingPaid = maker1MakerFunding.add(maker2Funding).abs()
            netFundingReceived = aliceFunding.add(maker1TakerFunding).abs() // = 2 * fundingPayment
            netFundingReceived = getAdjustedFunding(netFundingReceived) // 0.1% charged from receivers

            expect(netFundingPaid).gte(netFundingReceived) // protocol shouldn't go in a deficitt
        })

        it('maker+taker, takers pay', async function() {
            // maker1, alice shorts
            const baseAssetQuantity = _1e18.mul(-5)
            await Promise.all([
                clearingHouse.connect(maker1).openPosition(0, baseAssetQuantity, await hubbleViewer.getQuote(baseAssetQuantity, 0)),
                clearingHouse.openPosition(0, baseAssetQuantity, await hubbleViewer.getQuote(baseAssetQuantity, 0)),
            ])

            // underlying, shorts pay longs
            const oracleTwap = _1e6.mul(1100)
            await oracle.setUnderlyingTwapPrice(weth.address, oracleTwap)

            let tx = await clearingHouse.settleFunding() // funding event - 1
            let premium = (await parseRawEvent(tx, amm, 'FundingRateUpdated')).args.premiumFraction
            await gotoNextFundingTime(amm)

            let [
                {
                    takerFundingPayment: maker1TakerFunding,
                    makerFundingPayment: maker1MakerFunding
                },
                { makerFundingPayment: maker2Funding },
                { takerFundingPayment: aliceFunding }
            ] = await Promise.all([
                amm.getPendingFundingPayment(maker1.address),
                amm.getPendingFundingPayment(maker2.address),
                amm.getPendingFundingPayment(alice)
            ])

            // let's assert for takers
            let fundingPayment = premium.mul(baseAssetQuantity).div(_1e18) // +ve
            expect(maker1TakerFunding).to.eq(fundingPayment)
            expect(aliceFunding).to.eq(fundingPayment)

            // let's assert for makers
            assertBounds(maker1MakerFunding.abs(), roundDown(fundingPayment), roundUp(fundingPayment))
            assertBounds(maker2Funding.abs(), roundDown(fundingPayment), roundUp(fundingPayment))

            // maker1's net position = - 5 (as a taker) + 2.5 + 2.5 (as a maker) = 0
            await assertBounds(maker1TakerFunding, maker1MakerFunding.abs().sub(1e5), maker1MakerFunding.abs().add(1e5)) // round-off quirk

            // overall funding assertions
            let netFundingReceived = maker1MakerFunding.add(maker2Funding).abs()
            netFundingReceived = getAdjustedFunding(netFundingReceived) // 0.1% charged from receivers
            let netFundingPaid = aliceFunding.add(maker1TakerFunding).abs() // = 2 * fundingPayment
            expect(netFundingPaid).gte(netFundingReceived) // protocol shouldn't go in a deficit

            // maker1 add more liquidity
            const amount = _1e18.mul(10);
            const { dToken } = await hubbleViewer.getMakerQuote(0, amount, true, true)
            await clearingHouse.connect(maker1).addLiquidity(0, amount, dToken)

            tx = await clearingHouse.settleFunding() // funding event - 2
            const premium2 = (await parseRawEvent(tx, amm, 'FundingRateUpdated')).args.premiumFraction

            premium = await amm.cumulativePremiumFraction()

            tx = await clearingHouse.updatePositions(maker1.address)
            ;({
                takerFundingPayment: maker1TakerFunding,
                makerFundingPayment: maker1MakerFunding
            } = (await parseRawEvent(tx, amm, 'FundingPaid')).args)

            tx = await clearingHouse.updatePositions(maker2.address)
            ;({ makerFundingPayment: maker2Funding } = (await parseRawEvent(tx, amm, 'FundingPaid')).args)

            tx = await clearingHouse.updatePositions(alice)
            ;({ takerFundingPayment: aliceFunding } = (await parseRawEvent(tx, amm, 'FundingPaid')).args)

            // maker1 was 5 short as a taker and 5 long as a maker, no change in position due to addLiquidity
            const { size: maker1Pos } = await amm.positions(maker1.address)
            expect(maker1Pos).to.eq(baseAssetQuantity)

            // let's assert for takers
            expect(maker1TakerFunding).to.eq(premium2.mul(maker1Pos).div(_1e18))
            expect(aliceFunding).to.eq(premium.mul(baseAssetQuantity).div(_1e18))

            // maker1's net position is still ~0
            await assertBounds(maker1TakerFunding, maker1MakerFunding.abs().sub(1e5), maker1MakerFunding.abs().add(1e5)) // round-off quirk

            // overall funding assertions
            netFundingReceived = maker1MakerFunding.add(maker2Funding).abs()
            netFundingReceived = getAdjustedFunding(netFundingReceived)
            netFundingPaid = aliceFunding.add(maker1TakerFunding).abs() // = 2 * fundingPayment

            expect(netFundingPaid).gte(netFundingReceived) // protocol shouldn't go in a deficitt
        })

        it('two makers pos against one another', async function() {
            // alice longs
            await clearingHouse.openPosition(0, _1e18.mul(5), ethers.constants.MaxUint256)
            // maker2 adds liquidity
            await addMargin(maker2, _1e6.mul(1e6))
            await clearingHouse.connect(maker2).addLiquidity(0, _1e18.mul(500), 0)
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
            let maker1Funding = (await amm.cumulativePremiumPerDtoken()).mul(maker1Liquidity).div(_1e18)

            await Promise.all([
                clearingHouse.updatePositions(maker1.address),
                clearingHouse.updatePositions(maker2.address),
            ])

            expect(fundingReceived).lt(ZERO)
            expect(fundingReceived).to.eq(maker1Funding)
            // charge maker1 0.1%
            maker1Funding = getAdjustedFunding(maker1Funding)
            // maker2 pays slightly more to account for rouding-off
            expect(fundingPaid).to.gt(maker1Funding.mul(-1))
            expect(await marginAccount.getNormalizedMargin(maker1.address)).to.eq(makerMargin.sub(maker1Funding))
            expect(await marginAccount.getNormalizedMargin(maker2.address)).to.lt(makerMargin.add(_1e6.mul(1e6)).add(maker1Funding))
        })
    })
})

function roundUp(num, decimals = 6) {
    const x = BigNumber.from(10).pow(decimals)
    if (num.gte(0)) {
        return num.div(x).add(1).mul(x)
    }
    throw 'not supported'
}

function roundDown(num, decimals = 6) {
    const x = BigNumber.from(10).pow(decimals)
    if (num.gte(0)) {
        return num.div(x).mul(x)
    }
    throw 'not supported'
}

// charge 0.1% from the fundinga amount
function getAdjustedFunding(fundingAmount) {
    return fundingAmount.sub(fundingAmount.div(1e3))
}
