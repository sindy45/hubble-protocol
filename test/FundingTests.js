const { expect } = require('chai')

const {
    getTradeDetails,
    assertions,
    gotoNextFundingTime,
    setupContracts,
    getTwapPrice,
    parseRawEvent,
    addMargin,
    constants: { _1e6, _1e18, ZERO, feeSink }
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
            ;({ swap, marginAccount, marginAccountHelper, clearingHouse, amm, vusd, usdc, oracle, weth, hubbleViewer } = contracts)

            // add margin
            margin = _1e6.mul(2000)
            await addMargin(signers[0], margin)

            await gotoNextFundingTime(amm)
            // don't cap funding rate
            await amm.setMaxFundingRate(0)
        })

        it('alice shorts and receives +ve funding', async () => {
            const baseAssetQuantity = _1e18.mul(-5)
            let tx = await clearingHouse.openPosition2(0 /* amm index */, baseAssetQuantity, _1e6.mul(4975))
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
            const remainingMargin = margin.add(fundingReceived).sub(fee)
            expect(await marginAccount.margin(0, alice)).to.eq(remainingMargin)
            expect(await marginAccount.getNormalizedMargin(alice)).to.eq(remainingMargin)
            expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.true
            await assertions(contracts, alice, {
                size: baseAssetQuantity,
                openNotional: quoteAsset,
                notionalPosition: quoteAsset,
                unrealizedPnl: ZERO,
                margin: remainingMargin
            })

            const { totalCollateral, freeMargin } = await hubbleViewer.getAccountInfo(alice)
            const minAllowableMargin = await clearingHouse.minAllowableMargin()
            expect(totalCollateral).to.eq(remainingMargin)
            expect(freeMargin).to.eq(remainingMargin.sub(quoteAsset.mul(minAllowableMargin).div(_1e6)))
        })

        it('alice shorts and pays -ve funding', async () => {
            const baseAssetQuantity = _1e18.mul(-5)
            let tx = await clearingHouse.openPosition2(0 /* amm index */, baseAssetQuantity, _1e6.mul(4975))
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
            await assertions(contracts, alice, {
                size: baseAssetQuantity,
                openNotional: quoteAsset,
                notionalPosition: quoteAsset,
                unrealizedPnl: ZERO,
                margin: remainingMargin
            })
        })

        it('alice longs and pays +ve funding', async () => {
            const baseAssetQuantity = _1e18.mul(5)
            let tx = await clearingHouse.openPosition2(0 /* amm index */, baseAssetQuantity, _1e6.mul(5100))
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
            await assertions(contracts, alice, {
                size: baseAssetQuantity,
                openNotional: quoteAsset,
                notionalPosition: quoteAsset,
                unrealizedPnl: ZERO,
                margin: remainingMargin
            })

            const { totalCollateral, freeMargin } = await hubbleViewer.getAccountInfo(alice)
            const minAllowableMargin = await clearingHouse.minAllowableMargin()
            expect(totalCollateral).to.eq(remainingMargin)
            expect(freeMargin).to.eq(remainingMargin.sub(quoteAsset.mul(minAllowableMargin).div(_1e6)))
        })

        it('alice longs and receives -ve funding', async () => {
            const baseAssetQuantity = _1e18.mul(5)
            let tx = await clearingHouse.openPosition2(0 /* amm index */, baseAssetQuantity, _1e6.mul(5100))
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
            const remainingMargin = margin.add(fundingReceived).sub(fee)
            expect(await marginAccount.margin(0, alice)).to.eq(remainingMargin)
            expect(await marginAccount.getNormalizedMargin(alice)).to.eq(remainingMargin)
            expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.true
            await assertions(contracts, alice, {
                size: baseAssetQuantity,
                openNotional: quoteAsset,
                notionalPosition: quoteAsset,
                unrealizedPnl: ZERO,
                margin: remainingMargin
            })
        })

        it('alice shorts and paying -ve funding causes them to drop below maintenance margin and liquidated', async function() {
            await amm.setLiquidationParams(1e6, 1e4)

            const baseAssetQuantity = _1e18.mul(-5)
            let tx = await clearingHouse.openPosition2(0 /* amm index */, baseAssetQuantity, _1e6.mul(5000))
            ;({ quoteAsset, fee } = await getTradeDetails(tx))

            // $2k margin, ~$5k in notional position, < $500 margin will put them underwater => $300 funding/unit
            const oracleTwap = _1e6.mul(8200)
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
            await assertions(contracts, alice, {
                size: baseAssetQuantity,
                openNotional: quoteAsset,
                notionalPosition: quoteAsset,
                unrealizedPnl: ZERO,
                margin: remainingMargin
            })

            // can\'t open new positions below maintenance margin
            expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.false
            await expect(
                clearingHouse.openPosition2(0, _1e18.mul(-1), 0)
            ).to.be.revertedWith('CH: Below Minimum Allowable Margin')

            // Liquidate
            const feeSinkBalance = await vusd.balanceOf(feeSink)
            ;({ unrealizedPnl, notionalPosition } = await amm.getNotionalPositionAndUnrealizedPnl(alice))
            await clearingHouse.connect(liquidator1).liquidate2(alice)

            const liquidationPenalty = notionalPosition.mul(5e4).div(_1e6)
            remainingMargin = remainingMargin.sub(liquidationPenalty).add(unrealizedPnl)

            expect(await marginAccount.margin(0, alice)).to.eq(remainingMargin) // entire margin is in vusd
            expect(await vusd.balanceOf(feeSink)).to.eq(liquidationPenalty.add(feeSinkBalance))
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
        await amm.setMaxFundingRate(0)
        await marginAccount.whitelistCollateral(weth.address, 0.7 * 1e6) // weight = 0.7
        wethAmount = _1e18.mul(2)
        await weth.mint(alice, wethAmount)
        await weth.approve(marginAccount.address, wethAmount)
        await marginAccount.addMargin(1, wethAmount);

        const baseAssetQuantity = _1e18.mul(-5)
        await clearingHouse.openPosition2(0 , baseAssetQuantity, 0)
        await gotoNextFundingTime(amm)

        // alice margin falls below maintenance margin
        const base = _1e18.mul(15)
        const price = _1e6.mul(1220)
        await oracle.setUnderlyingPrice(weth.address, price)
        await addMargin(bob, base.mul(price).div(_1e18))
        await clearingHouse.connect(bob).openPosition2(0, base, base.mul(price).div(_1e18))
        expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.false

        // mine extra block to change block number
        await network.provider.send("evm_mine");
        await clearingHouse.connect(liquidator1).callStatic.liquidate2(alice) // doesn't throw exception

        // funding settled
        const oracleTwap = _1e6.mul(700)
        await oracle.setUnderlyingTwapPrice(weth.address, oracleTwap) // +ve funding rate
        await clearingHouse.settleFunding()
        expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.true
        await expect(
            clearingHouse.connect(liquidator1).liquidate2(alice)
        ).to.be.revertedWith('Above Maintenance Margin')
    })

    describe('funding payment cap', async function() {
        before(async function() {
            contracts = await setupContracts()
            ;({ marginAccount, marginAccountHelper, clearingHouse, amm, vusd, usdc, oracle, weth, hubbleViewer } = contracts)

            // add margin
            const margin = _1e6.mul(2000)
            await addMargin(signers[0], margin)
            // set maxFunding rate = 50% annual = 0.00570776% hourly
            maxFundingRate = 57
            await amm.setMaxFundingRate(maxFundingRate)
        })

        it('fundingRate positive and greater than maxFundingRate', async () => {
            // alice shorts
            baseAssetQuantity = _1e18.mul(-5)
            await clearingHouse.openPosition2(0, baseAssetQuantity, 0)
            await gotoNextFundingTime(amm)
            const oracleTwap = _1e6.mul(990)
            await oracle.setUnderlyingTwapPrice(weth.address, oracleTwap)
            const ammTwap = await amm.getTwapPrice(3600) // 999

            const tx = await clearingHouse.settleFunding()
            const premiumFraction = (await parseRawEvent(tx, clearingHouse, 'FundingRateUpdated')).args.premiumFraction

            expect(ammTwap.sub(oracleTwap).div(24)).to.gt(oracleTwap.mul(maxFundingRate).div(1e6))
            expect(premiumFraction).to.eq(oracleTwap.mul(maxFundingRate).div(1e6))

            const margin = await marginAccount.margin(0, alice)
            await clearingHouse.updatePositions(alice)

            let fundingReceived = premiumFraction.mul(baseAssetQuantity.abs()).div(_1e18)
            expect(await marginAccount.margin(0, alice)).to.eq(margin.add(fundingReceived))
        })

        it('fundingRate negative and less than -maxFundingRate', async () => {
            await gotoNextFundingTime(amm)
            const oracleTwap = _1e6.mul(1010)
            await oracle.setUnderlyingTwapPrice(weth.address, oracleTwap)
            const ammTwap = await amm.getTwapPrice(3600) // 999

            const tx = await clearingHouse.settleFunding()
            const premiumFraction = (await parseRawEvent(tx, clearingHouse, 'FundingRateUpdated')).args.premiumFraction

            expect(ammTwap.sub(oracleTwap).div(24)).to.lt(oracleTwap.mul(-maxFundingRate).div(1e6))
            expect(premiumFraction).to.eq(oracleTwap.mul(-maxFundingRate).div(1e6))

            const margin = await marginAccount.margin(0, alice)
            await clearingHouse.updatePositions(alice)

            const fundingPaid = premiumFraction.mul(baseAssetQuantity).div(_1e18)
            expect(await marginAccount.margin(0, alice)).to.eq(margin.sub(fundingPaid))
        })

        it('fundingRate positive and less than maxFundingRate', async () => {
            await gotoNextFundingTime(amm)
            const oracleTwap = _1e6.mul(999)
            await oracle.setUnderlyingTwapPrice(weth.address, oracleTwap)
            const ammTwap = await amm.getTwapPrice(3600) // 999

            const tx = await clearingHouse.settleFunding()
            const premiumFraction = (await parseRawEvent(tx, clearingHouse, 'FundingRateUpdated')).args.premiumFraction

            expect(ammTwap.sub(oracleTwap).div(24)).to.lt(oracleTwap.mul(maxFundingRate).div(1e6))
            expect(premiumFraction).to.eq(ammTwap.sub(oracleTwap).div(24))

            const margin = await marginAccount.margin(0, alice)
            await clearingHouse.updatePositions(alice)

            let fundingReceived = premiumFraction.mul(baseAssetQuantity.abs()).div(_1e18)
            expect(await marginAccount.margin(0, alice)).to.eq(margin.add(fundingReceived))
        })

        it('fundingRate negative and greater than -maxFundingRate', async () => {
            await gotoNextFundingTime(amm)
            const oracleTwap = _1e6.mul(1000)
            await oracle.setUnderlyingTwapPrice(weth.address, oracleTwap)
            const ammTwap = await amm.getTwapPrice(3600) // 999

            const tx = await clearingHouse.settleFunding()
            const premiumFraction = (await parseRawEvent(tx, clearingHouse, 'FundingRateUpdated')).args.premiumFraction

            expect(ammTwap.sub(oracleTwap).div(24)).to.gt(oracleTwap.mul(-maxFundingRate).div(1e6))
            expect(premiumFraction).to.eq(ammTwap.sub(oracleTwap).div(24))

            const margin = await marginAccount.margin(0, alice)
            await clearingHouse.updatePositions(alice)

            const fundingPaid = premiumFraction.mul(baseAssetQuantity).div(_1e18)
            expect(await marginAccount.margin(0, alice)).to.eq(margin.sub(fundingPaid))
        })
    })
})
