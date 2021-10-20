const { expect } = require('chai')

const {
    gotoNextFundingTime,
    setupContracts,
    getTwapPrice,
    constants: { _1e6, _1e18, _1e12, ZERO }
} = require('./utils')

describe('UI Helpers', async function() {
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

    it('getFundingPaymentInfo, getTradingInfo, getLiquidationPrice', async function () {
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
        expect((await getLiquidationPrice(alice, clearingHouse, marginAccount, 0)).div(_1e6)).to.eq('1101')

        await clearingHouse.openPosition(0, baseAssetQuantity.mul(-3), _1e6.mul(15500)) // alice has net long position now
        await clearingHouse.connect(bob).openPosition(0, baseAssetQuantity.div(-2), ethers.constants.MaxUint256)
        await gotoNextFundingTime(amm)

        tx = await clearingHouse.settleFunding() // alice pays funding payment 22.92
        fundingTimestamp = (await ethers.provider.getBlock(tx.blockNumber)).timestamp;
        const twap2 = await getTwapPrice(amm, 3600, fundingTimestamp)
        expect((await getLiquidationPrice(alice, clearingHouse, marginAccount, 0)).div(_1e6)).to.eq('695')

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

    async function getFundingPaymentInfo(amm, trader) {
        const [ positionChangedEvent, fundingRateEvent ] = await Promise.all([
            amm.queryFilter(amm.filters.PositionChanged(trader)),
            amm.queryFilter('FundingRateUpdated')
        ])
        const positionChangedEventLength = positionChangedEvent.length;

        const fundingInfo = []
        for (let i = 0; i < fundingRateEvent.length; i++) {
            const blockNumber = fundingRateEvent[i].blockNumber

            // For every funding event, find the trader's position size
            let positionSize
            if (positionChangedEvent[positionChangedEventLength-1].blockNumber <= blockNumber) {
                positionSize = positionChangedEvent[positionChangedEventLength-1].args.size;
            } else {
                for (let j = 0; j < positionChangedEvent.length-1; j++) {
                    if (positionChangedEvent[j].blockNumber <= blockNumber && positionChangedEvent[j+1].blockNumber >= blockNumber) {
                        positionSize = positionChangedEvent[j].args.size
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

    async function getLiquidationPrice(trader, clearingHouse, marginAccount, ammIndex) {
        const [ maintenanceMargin, {notionalPosition: totalNotionalPosition, unrealizedPnl: totalUnrealizedPnl}, positions, totalFunding, weightedCollateral ] = await Promise.all([
            clearingHouse.maintenanceMargin(),
            clearingHouse.getTotalNotionalPositionAndUnrealizedPnl(trader),
            clearingHouse.userPositions(trader),
            clearingHouse.getTotalFunding(trader),
            marginAccount.getNormalizedMargin(trader)
        ])
        const currentNetMargin = weightedCollateral.add(totalUnrealizedPnl).sub(totalFunding) // negative funding means trader should receive funds
        const pnlForLiquidation = maintenanceMargin.mul(totalNotionalPosition).div(_1e6).sub(currentNetMargin)
        const ammPositionSize = positions[ammIndex].size
        let liquidationPrice

        if (ammPositionSize.eq(ZERO)) {
            return 0
        }

        if (ammPositionSize.gt(ZERO)) {
            // Liquidation Price = (OpenNotional + maintnenaceMargin*totalNotionalPosition - currentNetMargin) / ammPositionSize
            liquidationPrice = positions[ammIndex].openNotional.add(pnlForLiquidation).mul(_1e18).div(ammPositionSize)
        } else {
            // Liquidation Price = (OpenNotional - (maintnenaceMargin*totalNotionalPosition - currentNetMargin)) / abs(ammPositionSize)
            liquidationPrice = positions[ammIndex].openNotional.sub(pnlForLiquidation).mul(_1e18).div(ammPositionSize.abs())
        }
        return liquidationPrice
    }

    async function addMargin(trader, margin) {
        await usdc.mint(trader.address, margin)
        await usdc.connect(trader).approve(marginAccountHelper.address, margin)
        await marginAccountHelper.connect(trader).addVUSDMarginWithReserve(margin)
    }
})
