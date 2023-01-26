const { expect } = require('chai')

const {
    constants: { _1e6, _1e18, ZERO },
    setupContracts,
    addMargin,
    bnToFloat,
    setupRestrictedTestToken,
    setDefaultClearingHouseParams
} = require('./utils')

describe('Hubble Viewer', async function() {
    describe.skip('ExpectedMFAndLiquidationPrice', async function() {
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
            // add another collateral for liquidation price calculation
            await marginAccount.whitelistCollateral(weth.address, 0.8 * 1e6) // weight = 0.8
        })

        it('increase taker position', async function() {
            // alice longs
            const baseAssetQuantity = _1e18.mul(5)
            let quote = await hubbleViewer.getQuote(baseAssetQuantity, 0)
            await clearingHouse.openPosition2(0, baseAssetQuantity, quote)
            const {
                expectedMarginFraction,
                liquidationPrice: expectedLiquidationPrice
            } = await liquidationPriceViewer.getTakerExpectedMFAndLiquidationPrice(alice, 0, baseAssetQuantity)
            // alice longs again
            quote = await hubbleViewer.getQuote(baseAssetQuantity, 0)
            await clearingHouse.openPosition2(0, baseAssetQuantity, quote)

            expect(await clearingHouse.getMarginFraction(alice)).to.eq(expectedMarginFraction)
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

            await clearingHouse.openPosition2(0, baseAssetQuantity, quote)

            expect(await clearingHouse.getMarginFraction(alice)).to.eq(expectedMarginFraction)
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

            await clearingHouse.openPosition2(0, baseAssetQuantity, quote)

            expect(await clearingHouse.getMarginFraction(alice)).to.eq(expectedMarginFraction)
            const liquidationPrice = await getTakerLiquidationPrice(alice, ZERO)
            expect(bnToFloat(expectedLiquidationPrice)).to.be.approximately(bnToFloat(liquidationPrice), 2)
        })
    })

    describe.skip('liquidation price', async function() {
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

        it('taker liquidation price when low margin', async function() {
            await clearingHouse.openPosition2(0, _1e18.mul(-5), 0)

            // bob increases the price
            bob = signers[1]
            let base = _1e18.mul(15)
            const price = _1e6.mul(1050)
            await addMargin(bob, base.mul(price).div(_1e18))
            await clearingHouse.connect(bob).openPosition2(0, base, base.mul(price).div(_1e18))

            expect(await liquidationPriceViewer.getTakerLiquidationPrice(alice, 0)).to.eq(
                await getTakerLiquidationPrice(alice, wethMargin.mul(8).div(10))
            )
            // reverse position
            base = _1e18.mul(10)
            const quote = await hubbleViewer.getQuote(base, 0)
            await clearingHouse.openPosition2(0, base, quote.mul(1005).div(1000))
            expect(await liquidationPriceViewer.getTakerLiquidationPrice(alice, 0)).to.eq(
                await getTakerLiquidationPrice(alice, wethMargin.mul(8).div(10))
            )
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
