const { expect } = require('chai')

const {
    constants: { _1e6, _1e18, ZERO },
    setupContracts,
    addMargin,
    unbondAndRemoveLiquidity,
    bnToFloat,
    setupRestrictedTestToken,
    calcMakerLiquidationPrice,
    setDefaultClearingHouseParams
} = require('./utils')

describe('Hubble Viewer', async function() {
    describe('ExpectedMFAndLiquidationPrice when taker+maker', async function() {
        before('alice adds liquidity', async function() {
            signers = await ethers.getSigners()
            alice = signers[0].address

            contracts = await setupContracts()
            ;({ swap, marginAccount, marginAccountHelper, clearingHouse, amm, vusd, usdc, oracle, weth, hubbleViewer, liquidationPriceViewer } = contracts)
            const Leaderboard = await ethers.getContractFactory('Leaderboard')
            leaderboard = await Leaderboard.deploy(hubbleViewer.address)
            await setDefaultClearingHouseParams(clearingHouse)

            // add margin
            margin = _1e6.mul(4000)
            await addMargin(signers[0], margin)
            const liquidity = _1e18.mul(10)
            const { dToken } = await hubbleViewer.getMakerQuote(0, liquidity, true, true)
            await clearingHouse.addLiquidity(0, liquidity, dToken)
            // add another collateral for liquidation price calculation
            await marginAccount.whitelistCollateral(weth.address, 0.8 * 1e6) // weight = 0.8
        })

        it('increase taker position', async function() {
            // alice longs
            const baseAssetQuantity = _1e18.mul(5)
            let quote = await hubbleViewer.getQuote(baseAssetQuantity, 0)
            await clearingHouse.openPosition(0, baseAssetQuantity, quote)
            const {
                expectedMarginFraction,
                liquidationPrice: expectedLiquidationPrice
            } = await liquidationPriceViewer.getTakerExpectedMFAndLiquidationPrice(alice, 0, baseAssetQuantity)
            // alice longs again
            quote = await hubbleViewer.getQuote(baseAssetQuantity, 0)
            await clearingHouse.openPosition(0, baseAssetQuantity, quote)

            expect((await clearingHouse.getMarginFraction(alice)).div(1e4)).to.eq(expectedMarginFraction.div(1e4))
            const liquidationPrice = await getTakerLiquidationPrice(alice, ZERO)
            expect(bnToFloat(expectedLiquidationPrice)).to.be.approximately(bnToFloat(liquidationPrice), 2)
        })

        it('reduce taker position', async function() {
            // alice shorts - netTakerPosition 5+5-5 = 5
            const baseAssetQuantity = _1e18.mul(-5)
            const {
                expectedMarginFraction,
                quoteAssetQuantity: quote,
                liquidationPrice: expectedLiquidationPrice
            } = await liquidationPriceViewer.getTakerExpectedMFAndLiquidationPrice(alice, 0, baseAssetQuantity)

            await clearingHouse.openPosition(0, baseAssetQuantity, quote)

            expect((await clearingHouse.getMarginFraction(alice)).div(1e4)).to.eq(expectedMarginFraction.div(1e4))
            const liquidationPrice = await getTakerLiquidationPrice(alice, ZERO)
            expect(bnToFloat(expectedLiquidationPrice)).to.be.approximately(bnToFloat(liquidationPrice), 2)
        })

        it('reverse taker position', async function() {
            // alice shorts - netTakerPosition 5-15 = -10
            const baseAssetQuantity = _1e18.mul(-15)
            const {
                expectedMarginFraction,
                quoteAssetQuantity: quote,
                liquidationPrice: expectedLiquidationPrice
            } = await liquidationPriceViewer.getTakerExpectedMFAndLiquidationPrice(alice, 0, baseAssetQuantity)

            await clearingHouse.openPosition(0, baseAssetQuantity, quote)

            expect((await clearingHouse.getMarginFraction(alice)).div(1e4)).to.eq(expectedMarginFraction.div(1e4))
            const liquidationPrice = await getTakerLiquidationPrice(alice, ZERO)
            expect(bnToFloat(expectedLiquidationPrice)).to.be.approximately(bnToFloat(liquidationPrice), 2)
        })

        it('alice adds more liquidity', async function() {
            await addMargin(signers[0], _1e6.mul(2000))
            const liquidity = _1e18.mul(10)
            const { fillAmount: vUsd, dToken } = await hubbleViewer.getMakerQuote(0, liquidity, true, true)
            const { expectedMarginFraction, liquidationPriceData } = await liquidationPriceViewer.getMakerExpectedMFAndLiquidationPrice(alice, 0, vUsd, false)
            await clearingHouse.addLiquidity(0, liquidity, dToken)

            expect((await clearingHouse.getMarginFraction(alice)).div(1e3)).to.eq(expectedMarginFraction.div(1e3))
            const makerLiquidationPrices = calcMakerLiquidationPrice(liquidationPriceData)
            expect(parseInt(makerLiquidationPrices.longLiqPrice)).to.eq(518)
            expect(parseInt(makerLiquidationPrices.shortLiqPrice)).to.eq(1890)
        })

        it('alice removes liquidity', async function() {
            const liquidity = _1e18.mul(5)
            const { fillAmount, dToken } = await hubbleViewer.getMakerQuote(0, liquidity, true, false)
            const { expectedMarginFraction, liquidationPriceData } = await liquidationPriceViewer.getMakerExpectedMFAndLiquidationPrice(alice, 0, fillAmount, true)
            await unbondAndRemoveLiquidity(signers[0], amm, 0, dToken, 0, 0)

            expect((await clearingHouse.getMarginFraction(alice)).div(1e3)).to.eq(expectedMarginFraction.div(1e3))
            const makerLiquidationPrices = calcMakerLiquidationPrice(liquidationPriceData)
            expect(parseInt(makerLiquidationPrices.longLiqPrice)).to.eq(389)
            expect(parseInt(makerLiquidationPrices.shortLiqPrice)).to.eq(2517)
        })

        it('bob adds liquidity and gets more vUSD while removing', async function () {
            const [ _, bob, charlie ] = signers
            // add margin
            await addMargin(bob, _1e6.mul(2001))
            await addMargin(charlie, _1e6.mul(2000))

            // bob adds liquidity
            const liquidity = _1e18.mul(10)
            const { dToken } = await hubbleViewer.getMakerQuote(0, liquidity, true, true)
            await clearingHouse.connect(bob).addLiquidity(0, liquidity, dToken)

            const { dToken: _dToken } = await amm.makers(bob.address)
            expect(dToken).to.eq(_dToken)

            // charlie longs
            const amount = await hubbleViewer.getQuote(liquidity, 0)
            await clearingHouse.connect(charlie).openPosition(0, liquidity, amount)

            // bob removes all liquidity
            const { quoteAsset: vUSD } = await hubbleViewer.calcWithdrawAmounts(dToken, 0)
            const { expectedMarginFraction } = await liquidationPriceViewer.getMakerExpectedMFAndLiquidationPrice(bob.address, 0, vUSD, true)
            await unbondAndRemoveLiquidity(bob, amm, 0, dToken, 0, 0)

            expect((await clearingHouse.getMarginFraction(bob.address)).div(1e3)).to.eq(expectedMarginFraction.div(1e3))
        })
    })

    describe('liquidation price', async function() {
        before('setup contracts', async function() {
            signers = await ethers.getSigners()
            alice = signers[0].address

            initialRate = 1000
            contracts = await setupContracts({amm: {initialRate}})
            ;({ swap, marginAccount, marginAccountHelper, clearingHouse, amm, vusd, usdc, oracle, weth, hubbleViewer, liquidationPriceViewer } = contracts)

            // add collateral
            // test for ETH-PERP, setting ETH index = 1
            await marginAccount.whitelistCollateral(weth.address, 0.8 * 1e6) // weight = 0.8
            const avax = await setupRestrictedTestToken('AVAX', 'AVAX', 18)
            const avaxPrice = 1e6 * 20 // $20
            await oracle.setUnderlyingPrice(avax.address, avaxPrice)
            await marginAccount.whitelistCollateral(avax.address, 0.8 * 1e6) // weight = 0.8

            // add margin
            const hUsdMargin = _1e6.mul(5000)
            wethMargin = _1e18.mul(_1e6.mul(1000)).div(await oracle.getUnderlyingPrice(weth.address)) // $1000
            const avaxMargin = _1e18.mul(_1e6.mul(1000)).div(avaxPrice) // $1000
            await Promise.all([
                addMargin(signers[0], hUsdMargin),
                weth.mint(alice, wethMargin),
                weth.approve(marginAccount.address, wethMargin),
                avax.mint(alice, avaxMargin),
                avax.approve(marginAccount.address, avaxMargin)
            ])
            await marginAccount.addMargin(1, wethMargin)
            await marginAccount.addMargin(2, avaxMargin)
        })

        it('taker+maker liquidation price when low margin', async function() {
            // add liquidity for non-zero makerNotional and pnl, makerNotional = 2 * 10000
            await clearingHouse.addLiquidity(0, _1e18.mul(10), 0)

            await clearingHouse.openPosition(0, _1e18.mul(-5), 0)
            // bob makes a counter-trade
            bob = signers[1]
            await addMargin(bob, _1e6.mul(20000))
            await clearingHouse.connect(bob).openPosition(0, _1e18.mul(70), ethers.constants.MaxUint256)
            makerNotional = _1e6.mul(20000)

            expect(await liquidationPriceViewer.getTakerLiquidationPrice(alice, 0)).to.eq(
                await getTakerLiquidationPrice(alice, wethMargin.mul(8).div(10))
            )
            // reverse position
            const base = _1e18.mul(10)
            const quote = await hubbleViewer.getQuote(base, 0)
            await clearingHouse.openPosition(0, base, quote.mul(1005).div(1000))
            expect(await liquidationPriceViewer.getTakerLiquidationPrice(alice, 0)).to.eq(
                await getTakerLiquidationPrice(alice, wethMargin.mul(8).div(10))
            )

            // maker liquidation price
            const liquidationPriceData = await liquidationPriceViewer.getMakerLiquidationPrice(alice, 0)
            const makerLiquidationPrices = calcMakerLiquidationPrice(liquidationPriceData)
            expect(liquidationPriceData.coefficient).to.gt(ZERO) // low margin
            expect(makerLiquidationPrices).to.deep.eq(
                await getMakerLiquidationPrice(alice, makerNotional, _1e6.mul(initialRate))
            )
            expect(makerLiquidationPrices.longLiqPrice).to.lt(makerLiquidationPrices.shortLiqPrice)
        })

        it('maker liquidation price when low maker leverage', async function() {
            await addMargin(signers[0], _1e6.mul(18000))
            expect(bnToFloat(await liquidationPriceViewer.getMakerLeverage(alice, 0)).toFixed(3)).to.eq('0.839')
            const liquidationPriceData = await liquidationPriceViewer.getMakerLiquidationPrice(alice, 0)
            const makerLiquidationPrices = calcMakerLiquidationPrice(liquidationPriceData)

            expect(liquidationPriceData.coefficient).to.lt(ZERO)
            expect(makerLiquidationPrices).to.deep.eq(
                await getMakerLiquidationPrice(alice, makerNotional, _1e6.mul(initialRate))
            )
            expect(makerLiquidationPrices.longLiqPrice).to.eq(ZERO)
            expect(makerLiquidationPrices.shortLiqPrice).to.eq(ZERO)
        })
    })
})

async function getTakerLiquidationPrice(trader, avax) {
    let [ { size }, { notionalPosition, margin }, maintenanceMargin, indexPrice ] = await Promise.all([
        amm.positions(trader),
        clearingHouse.getNotionalPositionAndMargin(alice, true, 0),
        clearingHouse.maintenanceMargin(),
        oracle.getUnderlyingPrice(weth.address)
    ])

    let liquidationPrice
    if (size < 0) {
        // liqPrice = indexPrice + (MM * nowNotional - margin) / (avax + (1 + MM) * size)
        liquidationPrice = notionalPosition.mul(maintenanceMargin).div(_1e6).sub(margin)
        liquidationPrice = indexPrice.add(liquidationPrice.mul(_1e18).div(avax.add(size.mul(_1e6.add(maintenanceMargin)).div(_1e6))))
    } else if (size > 0) {
        // liqPrice = indexPrice + (MM * nowNotional - margin) / (avax + (1 - MM) * size)
        liquidationPrice = notionalPosition.mul(maintenanceMargin).div(_1e6).sub(margin)
        liquidationPrice = indexPrice.add(liquidationPrice.mul(_1e18).div(avax.add(size.mul(_1e6.sub(maintenanceMargin)).div(_1e6))))
    }
    return liquidationPrice >= 0 ? liquidationPrice : 0
}

async function getMakerLiquidationPrice(trader, makerNotional, initialPrice) {
    let [ { unrealizedPnl: takerPnl }, margin, totalFunding, maintenanceMargin ] = await Promise.all([
        amm.getTakerNotionalPositionAndUnrealizedPnl(alice),
        marginAccount.getNormalizedMargin(trader),
        clearingHouse.getTotalFunding(trader),
        clearingHouse.maintenanceMargin()
    ])

    margin = margin.add(takerPnl).sub(totalFunding)
    const coefficient = makerNotional.mul(2 * 1e6).div((maintenanceMargin.add(_1e6)).mul(makerNotional).div(_1e6).sub(margin))
    return calcMakerLiquidationPrice({ coefficient, initialPrice })
}
