const { expect } = require('chai')

const {
    getTradeDetails,
    assertions,
    gotoNextFundingTime,
    setupContracts,
    getTwapPrice,
    constants: { _1e6, _1e18, ZERO }
} = require('./utils')

describe('Funding Tests', function() {
    before(async function() {
        signers = await ethers.getSigners()
        ;([ _, bob, liquidator1, liquidator2 ] = signers)
        alice = signers[0].address
    })

    describe('single trader', async function() {
        beforeEach(async function() {
            contracts = await setupContracts()
            ;({ swap, marginAccount, marginAccountHelper, clearingHouse, amm, vusd, usdc, oracle, weth } = contracts)

            // add margin
            margin = _1e6.mul(1000)
            await addMargin(signers[0], margin)

            await gotoNextFundingTime(amm)
        })

        it('alice shorts and receives +ve funding', async () => {
            const baseAssetQuantity = _1e18.mul(-5)
            let tx = await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity, _1e6.mul(4975))
            ;({ quoteAsset, fee } = await getTradeDetails(tx))

            // underlying
            const oracleTwap = _1e6.mul(900)
            await oracle.setUnderlyingTwapPrice(weth.address, oracleTwap)

            tx = await clearingHouse.settleFunding()
            const fundingTimestamp = (await ethers.provider.getBlock(tx.blockNumber)).timestamp;

            // mark price
            const twap = await getTwapPrice(amm, 3600, fundingTimestamp)
            const premiumFraction = await amm.cumulativePremiumFraction()
            expect(premiumFraction).to.eq(twap.sub(oracleTwap).div(24))

            await clearingHouse.updatePositions(alice)

            let fundingReceived = premiumFraction.mul(baseAssetQuantity.mul(-1)).div(_1e18)
            fundingReceived = fundingReceived.sub(fundingReceived.div(1e3))
            const remainingMargin = margin.add(fundingReceived).sub(fee)
            expect(await marginAccount.margin(0, alice)).to.eq(remainingMargin)
            expect(await marginAccount.getNormalizedMargin(alice)).to.eq(remainingMargin)
            expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.true
            const { notionalPosition, unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(alice)
            expect(notionalPosition).gt(quoteAsset)
            expect(unrealizedPnl).lt(ZERO)
            await assertions(contracts, alice, {
                size: baseAssetQuantity,
                openNotional: quoteAsset,
                margin: remainingMargin
            })
        })

        it('alice shorts and pays -ve funding', async () => {
            const baseAssetQuantity = _1e18.mul(-5)
            let tx = await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity, _1e6.mul(4975))
            ;({ quoteAsset, fee } = await getTradeDetails(tx))

            const oracleTwap = _1e6.mul(1100)
            await oracle.setUnderlyingTwapPrice(weth.address, oracleTwap)

            tx = await clearingHouse.settleFunding()
            const fundingTimestamp = (await ethers.provider.getBlock(tx.blockNumber)).timestamp;

            const twap = await getTwapPrice(amm, 3600, fundingTimestamp)
            const premiumFraction = await amm.cumulativePremiumFraction()
            expect(premiumFraction).to.eq(twap.sub(oracleTwap).div(24))

            await clearingHouse.updatePositions(alice)

            const fundingPaid = premiumFraction.mul(baseAssetQuantity).div(_1e18)
            const remainingMargin = margin.sub(fundingPaid).sub(fee)
            expect(await marginAccount.margin(0, alice)).to.eq(remainingMargin)
            expect(await marginAccount.getNormalizedMargin(alice)).to.eq(remainingMargin)
            expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.true
            const { notionalPosition, unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(alice)
            expect(notionalPosition).gt(quoteAsset)
            expect(unrealizedPnl).lt(ZERO)
            await assertions(contracts, alice, {
                size: baseAssetQuantity,
                openNotional: quoteAsset,
                margin: remainingMargin
            })
        })

        it('alice longs and pays +ve funding', async () => {
            const baseAssetQuantity = _1e18.mul(5)
            let tx = await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity, _1e6.mul(5100))
            ;({ quoteAsset, fee } = await getTradeDetails(tx))

            const oracleTwap = _1e6.mul(900)
            await oracle.setUnderlyingTwapPrice(weth.address, oracleTwap)
            tx = await clearingHouse.settleFunding()
            const fundingTimestamp = (await ethers.provider.getBlock(tx.blockNumber)).timestamp;

            const twap = await getTwapPrice(amm, 3600, fundingTimestamp)
            const premiumFraction = await amm.cumulativePremiumFraction()
            expect(premiumFraction).to.eq(twap.sub(oracleTwap).div(24))

            await clearingHouse.updatePositions(alice)

            const fundingPaid = premiumFraction.mul(baseAssetQuantity).div(_1e18)
            const remainingMargin = margin.sub(fundingPaid).sub(fee)
            expect(await marginAccount.margin(0, alice)).to.eq(remainingMargin)
            expect(await marginAccount.getNormalizedMargin(alice)).to.eq(remainingMargin)
            expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.true
            const { notionalPosition, unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(alice)
            expect(notionalPosition).gt(ZERO)
            expect(notionalPosition).lt(quoteAsset)
            expect(unrealizedPnl).lt(ZERO)
            await assertions(contracts, alice, {
                size: baseAssetQuantity,
                openNotional: quoteAsset,
                margin: remainingMargin
            })
        })

        it('alice longs and receives -ve funding', async () => {
            const baseAssetQuantity = _1e18.mul(5)
            let tx = await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity, _1e6.mul(5100))
            ;({ quoteAsset, fee } = await getTradeDetails(tx))

            const oracleTwap = _1e6.mul(1100)
            await oracle.setUnderlyingTwapPrice(weth.address, oracleTwap)
            tx = await clearingHouse.settleFunding()
            const fundingTimestamp = (await ethers.provider.getBlock(tx.blockNumber)).timestamp;

            const twap = await getTwapPrice(amm, 3600, fundingTimestamp)
            const premiumFraction = await amm.cumulativePremiumFraction()
            expect(premiumFraction).to.eq(twap.sub(oracleTwap).div(24))

            await clearingHouse.updatePositions(alice)

            let fundingReceived = premiumFraction.mul(baseAssetQuantity).div(_1e18).mul(-1) // premiumFraction is -ve
            fundingReceived = fundingReceived.sub(fundingReceived.div(1e3))
            const remainingMargin = margin.add(fundingReceived).sub(fee)
            expect(await marginAccount.margin(0, alice)).to.eq(remainingMargin)
            expect(await marginAccount.getNormalizedMargin(alice)).to.eq(remainingMargin)
            expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.true
            const { notionalPosition, unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(alice)
            expect(notionalPosition).gt(ZERO)
            expect(notionalPosition).lt(quoteAsset)
            expect(unrealizedPnl).lt(ZERO)
            await assertions(contracts, alice, {
                size: baseAssetQuantity,
                openNotional: quoteAsset,
                margin: remainingMargin
            })
        })

        it('alice shorts and paying -ve funding causes them to drop below maintenance margin and liquidated', async function() {
            const baseAssetQuantity = _1e18.mul(-5)
            let tx = await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity, _1e6.mul(4900))
            ;({ quoteAsset, fee } = await getTradeDetails(tx))

            // $1k margin, ~$5k in notional position, < $500 margin will put them underwater => $100 funding/unit
            const oracleTwap = _1e6.mul(3400)
            await oracle.setUnderlyingTwapPrice(weth.address, oracleTwap)
            tx = await clearingHouse.settleFunding()
            const fundingTimestamp = (await ethers.provider.getBlock(tx.blockNumber)).timestamp;

            const twap = await getTwapPrice(amm, 3600, fundingTimestamp)
            const premiumFraction = await amm.cumulativePremiumFraction()
            expect(premiumFraction).to.eq(twap.sub(oracleTwap).div(24))

            await clearingHouse.updatePositions(alice)

            const fundingPaid = premiumFraction.mul(baseAssetQuantity).div(_1e18)
            let remainingMargin = margin.sub(fundingPaid).sub(fee)
            expect(await marginAccount.margin(0, alice)).to.eq(remainingMargin)
            expect(await marginAccount.getNormalizedMargin(alice)).to.eq(remainingMargin)
            let { notionalPosition, unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(alice)
            expect(notionalPosition).gt(quoteAsset)
            expect(unrealizedPnl).lt(ZERO)
            await assertions(contracts, alice, {
                size: baseAssetQuantity,
                openNotional: quoteAsset,
                margin: remainingMargin
            })

            // can\'t open new positions below maintenance margin
            expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.false
            await expect(
                clearingHouse.openPosition(0, _1e18.mul(-1), 0)
            ).to.be.revertedWith('CH: Below Maintenance Margin')

            // Liquidate
            ;({ unrealizedPnl, notionalPosition } = await amm.getNotionalPositionAndUnrealizedPnl(alice))
            await clearingHouse.connect(liquidator1).liquidate(alice)

            const liquidationPenalty = notionalPosition.mul(5e4).div(_1e6)
            remainingMargin = remainingMargin.sub(liquidationPenalty).add(unrealizedPnl)

            expect(await marginAccount.margin(0, alice)).to.eq(remainingMargin) // entire margin is in vusd
            expect(await vusd.balanceOf(liquidator1.address)).to.eq(liquidationPenalty.sub(liquidationPenalty.div(2)))
            await assertions(contracts, alice, {
                size: 0,
                openNotional: 0,
                notionalPosition: 0,
                unrealizedPnl: 0,
                margin: remainingMargin
            })
            expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.true
        })
    })

    it('alice is in liquidation zone but saved by positive funding payment', async () => {
        ;({ swap, marginAccount, marginAccountHelper, clearingHouse, amm, vusd, usdc, oracle, weth, insuranceFund } = await setupContracts())
        await oracle.setUnderlyingPrice(weth.address, 1e6 * 2000) // $2k
        await marginAccount.whitelistCollateral(weth.address, 0.7 * 1e6) // weight = 0.7
        wethAmount = _1e18
        await weth.mint(alice, wethAmount)
        await weth.approve(marginAccount.address, wethAmount)
        await marginAccount.addMargin(1, wethAmount);

        const baseAssetQuantity = _1e18.mul(-5)
        await clearingHouse.openPosition(0 , baseAssetQuantity, 0)
        await gotoNextFundingTime(amm)

        // alice margin falls below maintenance margin
        const oracleTwap = _1e6.mul(700)
        await oracle.setUnderlyingPrice(weth.address, oracleTwap) // reduces margin
        await oracle.setUnderlyingTwapPrice(weth.address, oracleTwap) // +ve funding rate
        expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.false

        await clearingHouse.connect(liquidator1).callStatic.liquidate(alice) // doesn't throw exception

        // funding settled
        await clearingHouse.settleFunding()
        expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.true
        await expect(
            clearingHouse.connect(liquidator1).liquidate(alice)
        ).to.be.revertedWith('Above Maintenance Margin')
    })

    async function addMargin(trader, margin) {
        await usdc.mint(trader.address, margin)
        await usdc.connect(trader).approve(marginAccountHelper.address, margin)
        await marginAccountHelper.connect(trader).addVUSDMarginWithReserve(margin)
    }
})
