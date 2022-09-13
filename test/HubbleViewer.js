const { expect } = require('chai')

const {
    constants: { _1e6, _1e18 },
    setupContracts,
    addMargin,
    unbondAndRemoveLiquidity,
    setDefaultClearingHouseParams
} = require('./utils')

describe('Hubble Viewer', async function() {
    describe('getMakerExpectedMFAndLiquidationPrice when taker+maker', async function() {
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
            const { expectedMarginFraction, liquidationPrice } = await liquidationPriceViewer.getTakerExpectedMFAndLiquidationPrice(alice, 0, baseAssetQuantity)
            // alice longs again
            quote = await hubbleViewer.getQuote(baseAssetQuantity, 0)
            await clearingHouse.openPosition(0, baseAssetQuantity, quote)

            expect((await clearingHouse.getMarginFraction(alice)).div(1e4)).to.eq(expectedMarginFraction.div(1e4))
            // makerNotional = 20000, margin = 4000, size = 10, openNotional = 10021.26, MM = 0.1
            // liquidationPrice = (openNotional - margin + MM * makerNotional) / ((1 - MM) * size)
            // => (10021.26 - 4000 + 0.1 * 20000) / (10 * 0.9) = 891.25
            expect(parseInt(liquidationPrice.toNumber() / 1e6)).to.eq(892)
        })

        it('reduce taker position', async function() {
            // alice shorts - netTakerPosition 5+5-5 = 5
            const baseAssetQuantity = _1e18.mul(-5)
            const { expectedMarginFraction, quoteAssetQuantity: quote, liquidationPrice } = await liquidationPriceViewer.getTakerExpectedMFAndLiquidationPrice(alice, 0, baseAssetQuantity)

            await clearingHouse.openPosition(0, baseAssetQuantity, quote)

            expect((await clearingHouse.getMarginFraction(alice)).div(1e4)).to.eq(expectedMarginFraction.div(1e4))
            expect(parseInt(liquidationPrice.toNumber() / 1e6)).to.eq(675)
        })

        it('reverse taker position', async function() {
            // alice shorts - netTakerPosition 5-15 = -10
            const baseAssetQuantity = _1e18.mul(-15)
            const { expectedMarginFraction, quoteAssetQuantity: quote, liquidationPrice } = await liquidationPriceViewer.getTakerExpectedMFAndLiquidationPrice(alice, 0, baseAssetQuantity)

            await clearingHouse.openPosition(0, baseAssetQuantity, quote)

            expect((await clearingHouse.getMarginFraction(alice)).div(1e4)).to.eq(expectedMarginFraction.div(1e4))
            // makerNotional = 20000, margin = 4000, size = 10, openNotional = 9978.83, MM = 0.1
            // liquidationPrice = (openNotional + margin - MM * makerNotional) / ((1 + MM) * size)
            // => (9978.83 + 4000 - 0.1 * 20000) / (10 * 1.1) = 1088.98 (approx because of openNotional calculation before and after the trade)
            expect(parseInt(liquidationPrice.toNumber() / 1e6)).to.eq(1093)
        })

        it('alice adds more liquidity', async function() {
            await addMargin(signers[0], _1e6.mul(2000))
            const liquidity = _1e18.mul(10)
            const { fillAmount: vUsd, dToken } = await hubbleViewer.getMakerQuote(0, liquidity, true, true)
            const { expectedMarginFraction, longLiquidationPrice, shortLiquidationPrice } = await liquidationPriceViewer.getMakerExpectedMFAndLiquidationPrice(alice, 0, vUsd, false)
            await clearingHouse.addLiquidity(0, liquidity, dToken)

            expect((await clearingHouse.getMarginFraction(alice)).div(1e3)).to.eq(expectedMarginFraction.div(1e3))
            // makerNotional = 39608.65, initialPrice = 990.21, hUSD = 5945.18, takerSize = 10
            // longPrice = (39608.65 * 1.1 - 5945.18) / (39608.65 / 990.21 - 0.1*10) = 964.72
            // shortPrice = (39608.65 * 0.9 + 5945.18) / (39608.65 / 990.21 + 0.1*10) = 1014.45
            expect(parseInt(longLiquidationPrice.toNumber() / 1e6)).to.eq(964)
            expect(parseInt(shortLiquidationPrice.toNumber() / 1e6)).to.eq(1014)
        })

        it('alice removes liquidity', async function() {
            const liquidity = _1e18.mul(5)
            const { fillAmount, dToken } = await hubbleViewer.getMakerQuote(0, liquidity, true, false)
            const { expectedMarginFraction, longLiquidationPrice, shortLiquidationPrice } = await liquidationPriceViewer.getMakerExpectedMFAndLiquidationPrice(alice, 0, fillAmount, true)
            await unbondAndRemoveLiquidity(signers[0], amm, 0, dToken, 0, 0)

            expect((await clearingHouse.getMarginFraction(alice)).div(1e3)).to.eq(expectedMarginFraction.div(1e3))
            expect(parseInt(longLiquidationPrice.toNumber() / 1e6)).to.eq(922)
            expect(parseInt(shortLiquidationPrice.toNumber() / 1e6)).to.eq(1053)
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
})
