const { expect } = require('chai')

const {
    gotoNextFundingTime,
    setupContracts,
    getTwapPrice,
    constants: { _1e6, _1e18, ZERO }
} = require('./utils')

describe('UI Helpers', async function() {
    before(async function() {
        signers = await ethers.getSigners()
        ;([ _, bob ] = signers)
        alice = signers[0].address

        contracts = await setupContracts(ZERO /* tradeFee */)
        ;({ swap, marginAccount, marginAccountHelper, clearingHouse, amm, vusd, usdc, oracle, weth } = contracts)

        // add margin
        margin = _1e6.mul(2000)
        await addMargin(signers[0], margin)
        await addMargin(bob, margin)
    })

    it('Funding payment history', async function () {
        const baseAssetQuantity = _1e18.mul(-5)
        await clearingHouse.openPosition(0 , baseAssetQuantity, 0)
        await clearingHouse.openPosition(0 , baseAssetQuantity, 0)
        await clearingHouse.connect(bob).openPosition(0 , baseAssetQuantity.div(2), 0)
        await gotoNextFundingTime(amm)

        const oracleTwap = _1e6.mul(900)
        await oracle.setUnderlyingTwapPrice(weth.address, oracleTwap)
        let tx = await clearingHouse.settleFunding()
        let fundingTimestamp = (await ethers.provider.getBlock(tx.blockNumber)).timestamp;
        const twap1 = await getTwapPrice(amm, 3600, fundingTimestamp)

        await clearingHouse.openPosition(0 , baseAssetQuantity.mul(-1), ethers.constants.MaxUint256)
        await clearingHouse.connect(bob).openPosition(0 , baseAssetQuantity.div(-2), ethers.constants.MaxUint256)
        await gotoNextFundingTime(amm)

        tx = await clearingHouse.settleFunding()
        fundingTimestamp = (await ethers.provider.getBlock(tx.blockNumber)).timestamp;
        const twap2 = await getTwapPrice(amm, 3600, fundingTimestamp)

        const fundingInfo = await getFundingPaymentInfo(amm, alice)

        expect(fundingInfo[0].fundingAmount).eq(twap1.sub(oracleTwap).div(24).mul(baseAssetQuantity.mul(2)).div(_1e18))
        expect(fundingInfo[1].fundingAmount).eq(twap2.sub(oracleTwap).div(24).mul(baseAssetQuantity).div(_1e18))
    })

    async function getFundingPaymentInfo(amm, alice) {
        const [ positionChangedEvent, fundingRateEvent ] = await Promise.all([
            amm.queryFilter(amm.filters.PositionChanged(alice)),
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

    async function addMargin(trader, margin) {
        await usdc.mint(trader.address, margin)
        await usdc.connect(trader).approve(marginAccountHelper.address, margin)
        await marginAccountHelper.connect(trader).addVUSDMarginWithReserve(margin)
    }
})
