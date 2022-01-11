const { expect } = require('chai')

const {
    gotoNextFundingTime,
    setupContracts,
    getTwapPrice,
    constants: { _1e6, _1e18, _1e12, ZERO }
} = require('./utils')

describe('UI Helpers', async function() {
    describe('JS functions', async function(){
        before(async function() {
            signers = await ethers.getSigners()
            ;([ _, bob ] = signers)
            alice = signers[0].address

            contracts = await setupContracts()
            ;({ swap, marginAccount, marginAccountHelper, clearingHouse, amm, vusd, usdc, oracle, weth } = contracts)

            // add margin
            margin = _1e6.mul(2000)
            await addMargin(signers[0], margin)
            await addMargin(bob, margin)
        })

        it('getFundingPaymentInfo, getTradingInfo', async function () {
            const baseAssetQuantity = _1e18.mul(-5)
            await clearingHouse.openPosition(0, baseAssetQuantity, 0)
            await clearingHouse.openPosition(0, baseAssetQuantity, 0) // alice has short position
            await clearingHouse.connect(bob).openPosition(0, baseAssetQuantity.div(2), 0)
            await gotoNextFundingTime(amm)

            const oracleTwap = _1e6.mul(900)
            await oracle.setUnderlyingTwapPrice(weth.address, oracleTwap)
            let tx = await clearingHouse.settleFunding() // alice receives funding payment 31.47
            let fundingTimestamp = (await ethers.provider.getBlock(tx.blockNumber)).timestamp;
            const twap1 = await getTwapPrice(amm, 3600, fundingTimestamp)

            await clearingHouse.openPosition(0, baseAssetQuantity.mul(-3), _1e6.mul(15500)) // alice has net long position now
            await clearingHouse.connect(bob).openPosition(0, baseAssetQuantity.div(-2), ethers.constants.MaxUint256)
            await gotoNextFundingTime(amm)

            tx = await clearingHouse.settleFunding() // alice pays funding payment 22.92
            fundingTimestamp = (await ethers.provider.getBlock(tx.blockNumber)).timestamp;
            const twap2 = await getTwapPrice(amm, 3600, fundingTimestamp)

            const fundingInfo = await getFundingPaymentInfo(amm, alice)
            const tradingInfoAlice = await getTradingInfo(clearingHouse, alice)
            const tradingInfoBob = await getTradingInfo(clearingHouse, bob.address)

            expect(fundingInfo[0].fundingAmount).eq(twap1.sub(oracleTwap).div(24).mul(baseAssetQuantity.mul(2)).div(_1e18))
            expect(fundingInfo[1].fundingAmount).eq(twap2.sub(oracleTwap).div(-24).mul(baseAssetQuantity).div(_1e18))

            expect(tradingInfoAlice.length).to.eq(3)
            expect(tradingInfoAlice[0].side).to.eq('Sell')
            expect(tradingInfoAlice[0].size).to.eq(baseAssetQuantity.abs())
            expect(tradingInfoAlice[1].side).to.eq('Sell')
            expect(tradingInfoAlice[1].size).to.eq(baseAssetQuantity.abs())
            expect(tradingInfoAlice[2].side).to.eq('Buy')
            expect(tradingInfoAlice[2].size).to.eq(baseAssetQuantity.mul(3).abs())

            expect(tradingInfoBob.length).to.eq(2)
            expect(tradingInfoBob[0].side).to.eq('Sell')
            expect(tradingInfoBob[0].size).to.eq(baseAssetQuantity.div(2).abs())
            expect(tradingInfoBob[1].side).to.eq('Buy')
            expect(tradingInfoBob[1].size).to.eq(baseAssetQuantity.div(2).abs())
        })
    })

    describe('getExpectedMFAndLiquidationPrice, getMakerExpectedMFAndLiquidationPrice when taker+maker', async function() {
        before('alice adds liquidity', async function() {
            signers = await ethers.getSigners()
            alice = signers[0].address

            contracts = await setupContracts()
            ;({ swap, marginAccount, marginAccountHelper, clearingHouse, amm, vusd, usdc, oracle, weth, hubbleViewer } = contracts)

            // add margin
            margin = _1e6.mul(4000)
            await addMargin(signers[0], margin)
            const liquidity = _1e18.mul(10)
            const { dToken } = await hubbleViewer.getMakerQuote(0, liquidity, true, true)
            await clearingHouse.addLiquidity(0, liquidity, dToken)
        })

        it('increase taker position', async function() {
            // alice longs
            const baseAssetQuantity = _1e18.mul(5)
            let quote = await hubbleViewer.getQuote(baseAssetQuantity, 0)
            await clearingHouse.openPosition(0, baseAssetQuantity, quote)
            const { expectedMarginFraction, liquidationPrice } = await hubbleViewer.getTakerExpectedMFAndLiquidationPrice(alice, 0, baseAssetQuantity)
            // alice longs again
            quote = await hubbleViewer.getQuote(baseAssetQuantity, 0)
            await clearingHouse.openPosition(0, baseAssetQuantity, quote)

            expect((await clearingHouse.getMarginFraction(alice)).div(1e4)).to.eq(expectedMarginFraction.div(1e4))
            expect(parseInt(liquidationPrice.toNumber() / 1e6)).to.eq(905)
        })

        it('reduce taker position', async function() {
            // alice shorts - netTakerPosition 5+5-5 = 5
            const baseAssetQuantity = _1e18.mul(-5)
            const { expectedMarginFraction, quoteAssetQuantity: quote, liquidationPrice } = await hubbleViewer.getTakerExpectedMFAndLiquidationPrice(alice, 0, baseAssetQuantity)

            await clearingHouse.openPosition(0, baseAssetQuantity, quote)

            expect((await clearingHouse.getMarginFraction(alice)).div(1e4)).to.eq(expectedMarginFraction.div(1e4))
            expect(parseInt(liquidationPrice.toNumber() / 1e6)).to.eq(707)
        })

        it('reverse taker position', async function() {
            // alice shorts - netTakerPosition 5-15 = -10
            const baseAssetQuantity = _1e18.mul(-15)
            const { expectedMarginFraction, quoteAssetQuantity: quote, liquidationPrice } = await hubbleViewer.getTakerExpectedMFAndLiquidationPrice(alice, 0, baseAssetQuantity)

            await clearingHouse.openPosition(0, baseAssetQuantity, quote)

            expect((await clearingHouse.getMarginFraction(alice)).div(1e4)).to.eq(expectedMarginFraction.div(1e4))
            expect(parseInt(liquidationPrice.toNumber() / 1e6)).to.eq(1103)
        })

        it('alice adds more liquidity', async function() {
            await addMargin(signers[0], _1e6.mul(2000))
            const liquidity = _1e18.mul(10)
            const { fillAmount: vUsd } = await hubbleViewer.getMakerQuote(0, liquidity, true, true)
            const { expectedMarginFraction, liquidationPrice } = await hubbleViewer.getMakerExpectedMFAndLiquidationPrice(alice, 0, vUsd, false)
            const { dToken } = await hubbleViewer.getMakerQuote(0, liquidity, true, true)
            await clearingHouse.addLiquidity(0, liquidity, dToken)

            expect((await clearingHouse.getMarginFraction(alice)).div(1e3)).to.eq(expectedMarginFraction.div(1e3))
            expect(parseInt(liquidationPrice.toNumber() / 1e6)).to.eq(1094)
        })

        it('alice removes liquidity', async function() {
            const liquidity = _1e18.mul(5)
            const { fillAmount: vUsd } = await hubbleViewer.getMakerQuote(0, liquidity, true, false)
            const { expectedMarginFraction, liquidationPrice } = await hubbleViewer.getMakerExpectedMFAndLiquidationPrice(alice, 0, vUsd, true)
            const { vAsset, dToken } = await amm.makers(alice)
            const dTokenAmount = liquidity.mul(dToken).div(vAsset)
            await clearingHouse.removeLiquidity(0, dTokenAmount, 0, 0)

            expect((await clearingHouse.getMarginFraction(alice)).div(1e3)).to.eq(expectedMarginFraction.div(1e3))
            expect(parseInt(liquidationPrice.toNumber() / 1e6)).to.eq(1193)
        })
    })

    async function getFundingPaymentInfo(amm, trader) {
        const [ positionChangedEvent, fundingRateEvent ] = await Promise.all([
            amm.queryFilter(amm.filters.PositionChanged(trader)),
            amm.queryFilter('FundingRateUpdated') // or amm.queryFilter(amm.filters.FundingRateUpdated())
        ])
        const positionChangedEventLength = positionChangedEvent.length;

        const fundingInfo = []
        for (let i = 0; i < fundingRateEvent.length; i++) {
            const blockNumber = fundingRateEvent[i].blockNumber

            // For every funding event, find the trader's position size
            let positionSize = ZERO
            if (positionChangedEvent[positionChangedEventLength-1].blockNumber <= blockNumber) {
                positionSize = positionChangedEvent[positionChangedEventLength-1].args.size;
            } else {
                for (let j = 0; j < positionChangedEvent.length-1; j++) {
                    if (positionChangedEvent[j].blockNumber <= blockNumber && positionChangedEvent[j+1].blockNumber >= blockNumber) {
                        positionSize = positionChangedEvent[j].args.size
                        break
                    }
                }
            }

            fundingInfo.push({
                timestamp : fundingRateEvent[i].args.timestamp,
                fundingRate : fundingRateEvent[i].args.fundingRate, // scaled 6 decimals
                fundingAmount : fundingRateEvent[i].args.premiumFraction.mul(positionSize).div(_1e18) // scaled 6 decimals
            })
        }
        return fundingInfo
    }

    async function getTradingInfo(clearingHouse, trader) {
        const positionModifiedEvent = await clearingHouse.queryFilter(clearingHouse.filters.PositionModified(trader))
        const tradeFee = await clearingHouse.tradeFee();
        const tradingInfo = []

        for (let i = 0; i < positionModifiedEvent.length; i++) {
            const { baseAssetQuantity, quoteAsset: quoteAssetQuantity } = positionModifiedEvent[i].args
            tradingInfo.push({
                timestamp : (await positionModifiedEvent[i].getBlock()).timestamp,
                market: positionModifiedEvent[i].args.idx,
                side: baseAssetQuantity.gt(ZERO) ? 'Buy' : 'Sell',
                size: baseAssetQuantity.abs(),
                price: quoteAssetQuantity.mul(_1e12).div(baseAssetQuantity.abs()),
                total: quoteAssetQuantity,
                fee: quoteAssetQuantity.mul(tradeFee).div(_1e6) // scaled by 6 decimals,
            })
        }
        return tradingInfo
    }

    async function addMargin(trader, margin) {
        await usdc.mint(trader.address, margin)
        await usdc.connect(trader).approve(marginAccountHelper.address, margin)
        await marginAccountHelper.connect(trader).addVUSDMarginWithReserve(margin)
    }
})
