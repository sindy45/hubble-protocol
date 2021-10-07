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
            await oracle.setTwapPrice(weth.address, oracleTwap)

            tx = await clearingHouse.settleFunding()
            const fundingTimestamp = (await ethers.provider.getBlock(tx.blockNumber)).timestamp;

            // mark price
            const twap = await getTwapPrice(amm, 3600, fundingTimestamp)
            const premiumFraction = await amm.getLatestCumulativePremiumFraction()
            expect(premiumFraction).to.eq(twap.sub(oracleTwap).div(24))

            await clearingHouse.updatePositions(alice)

            const fundingReceived = premiumFraction.mul(baseAssetQuantity.mul(-1)).div(_1e18)
            const remainingMargin = margin.add(fundingReceived).sub(fee)
            expect(await marginAccount.margin(0, alice)).to.eq(remainingMargin)
            expect(await marginAccount.getNormalizedMargin(alice)).to.eq(remainingMargin)
            expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.true
            await assertions(contracts, alice, {
                size: baseAssetQuantity,
                openNotional: quoteAsset,
                notionalPosition: quoteAsset,
                unrealizedPnl: 0,
                margin: remainingMargin
            })
        })

        it('alice shorts and pays -ve funding', async () => {
            const baseAssetQuantity = _1e18.mul(-5)
            let tx = await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity, _1e6.mul(4975))
            ;({ quoteAsset, fee } = await getTradeDetails(tx))

            const oracleTwap = _1e6.mul(1100)
            await oracle.setTwapPrice(weth.address, oracleTwap)

            tx = await clearingHouse.settleFunding()
            const fundingTimestamp = (await ethers.provider.getBlock(tx.blockNumber)).timestamp;

            const twap = await getTwapPrice(amm, 3600, fundingTimestamp)
            const premiumFraction = await amm.getLatestCumulativePremiumFraction()
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
                unrealizedPnl: 0,
                margin: remainingMargin
            })
        })

        it('alice longs and pays +ve funding', async () => {
            const baseAssetQuantity = _1e18.mul(5)
            let tx = await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity, _1e6.mul(5100))
            ;({ quoteAsset, fee } = await getTradeDetails(tx))

            const oracleTwap = _1e6.mul(900)
            await oracle.setTwapPrice(weth.address, oracleTwap)
            tx = await clearingHouse.settleFunding()
            const fundingTimestamp = (await ethers.provider.getBlock(tx.blockNumber)).timestamp;

            const twap = await getTwapPrice(amm, 3600, fundingTimestamp)
            const premiumFraction = await amm.getLatestCumulativePremiumFraction()
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
                unrealizedPnl: 0,
                margin: remainingMargin
            })
        })

        it('alice longs and receives -ve funding', async () => {
            const baseAssetQuantity = _1e18.mul(5)
            let tx = await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity, _1e6.mul(5100))
            ;({ quoteAsset, fee } = await getTradeDetails(tx))

            const oracleTwap = _1e6.mul(1100)
            await oracle.setTwapPrice(weth.address, oracleTwap)
            tx = await clearingHouse.settleFunding()
            const fundingTimestamp = (await ethers.provider.getBlock(tx.blockNumber)).timestamp;

            const twap = await getTwapPrice(amm, 3600, fundingTimestamp)
            const premiumFraction = await amm.getLatestCumulativePremiumFraction()
            expect(premiumFraction).to.eq(twap.sub(oracleTwap).div(24))

            await clearingHouse.updatePositions(alice)

            const fundingReceived = premiumFraction.mul(baseAssetQuantity).div(_1e18).mul(-1) // premiumFraction is -ve
            const remainingMargin = margin.add(fundingReceived).sub(fee)
            expect(await marginAccount.margin(0, alice)).to.eq(remainingMargin)
            expect(await marginAccount.getNormalizedMargin(alice)).to.eq(remainingMargin)
            expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.true
            await assertions(contracts, alice, {
                size: baseAssetQuantity,
                openNotional: quoteAsset,
                notionalPosition: quoteAsset,
                unrealizedPnl: 0,
                margin: remainingMargin
            })
        })

        it('alice shorts and paying -ve funding causes them to drop below maintenance margin and liquidated', async function() {
            const baseAssetQuantity = _1e18.mul(-5)
            let tx = await clearingHouse.openPosition(0 /* amm index */, baseAssetQuantity, _1e6.mul(4900))
            ;({ quoteAsset, fee } = await getTradeDetails(tx))

            // $1k margin, ~$5k in notional position, < $500 margin will put them underwater => $100 funding/unit
            const oracleTwap = _1e6.mul(3400)
            await oracle.setTwapPrice(weth.address, oracleTwap)
            tx = await clearingHouse.settleFunding()
            const fundingTimestamp = (await ethers.provider.getBlock(tx.blockNumber)).timestamp;

            const twap = await getTwapPrice(amm, 3600, fundingTimestamp)
            const premiumFraction = await amm.getLatestCumulativePremiumFraction()
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
                unrealizedPnl: 0,
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
            remainingMargin = remainingMargin.sub(liquidationPenalty)

            expect(await marginAccount.margin(0, alice)).to.eq(remainingMargin) // entire margin is in vusd
            expect(await vusd.balanceOf(liquidator1.address)).to.eq(liquidationPenalty.div(2))
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

    describe('two traders', async function() {
        beforeEach(async function() {
            contracts = await setupContracts(ZERO /* tradeFee */)
            ;({ swap, marginAccount, marginAccountHelper, clearingHouse, amm, vusd, usdc, oracle, weth } = contracts)

            // add margin
            margin = _1e6.mul(1000)
            await addMargin(signers[0], margin)
            await addMargin(bob, margin)
        })

        it('will generate loss for insurance fund when funding rate is +ve and amm holds more short position', async function() {
            const premiumFraction = await testPositionImbalance(_1e18.mul(10), _1e18.mul(5), 900)
            expect(
                await insuranceFund.pendingObligation()
            ).to.eq(premiumFraction.mul(5))
            expect(
                await vusd.balanceOf(insuranceFund.address)
            ).to.eq(ZERO)
        })

        it('will generate loss for insurance fund when funding rate is -ve and amm holds more long position', async function() {
            const premiumFraction = await testPositionImbalance(_1e18.mul(3), _1e18.mul(5), 1100)
            expect(
                await insuranceFund.pendingObligation()
            ).to.eq(premiumFraction.mul(-2)) // 3 - 5
            expect(
                await vusd.balanceOf(insuranceFund.address)
            ).to.eq(ZERO)
        })

        it('will generate profit for insurance fund when funding rate is -ve and amm holds more short position', async function() {
            const premiumFraction = await testPositionImbalance(_1e18.mul(7), _1e18.mul(3), 1100)
            expect(await insuranceFund.pendingObligation()).to.eq(ZERO)
            expect(
                await vusd.balanceOf(insuranceFund.address)
            ).to.eq(premiumFraction.mul(-4)) // longs - shorts
        })

        it('will generate profit for insurance fund when funding rate is +ve and amm holds more long position', async function() {
            const premiumFraction = await testPositionImbalance(_1e18.mul(2), _1e18.mul(8), 900)
            expect(await insuranceFund.pendingObligation()).to.eq(ZERO)
            expect(
                await vusd.balanceOf(insuranceFund.address)
            ).to.eq(premiumFraction.mul(6)) // longs - shorts
        })

        async function testPositionImbalance(aliceShort, bobLong, twap) {
            await clearingHouse.openPosition(0, aliceShort.mul(-1), 0)
            await clearingHouse.connect(bob).openPosition(0, bobLong, ethers.constants.MaxUint256)

            // mark price is twap is ~999; set underlying such that to receive a -ve funding rate
            await oracle.setTwapPrice(weth.address, _1e6.mul(twap))
            await gotoNextFundingTime(amm)
            await clearingHouse.settleFunding()

            const premiumFraction = await amm.getLatestCumulativePremiumFraction()

            await clearingHouse.updatePositions(alice)
            await clearingHouse.updatePositions(bob.address)

            expect(
                await marginAccount.getNormalizedMargin(alice)
            ).to.eq(margin.add(premiumFraction.mul(aliceShort).div(_1e18)))

            expect(
                await marginAccount.getNormalizedMargin(bob.address)
            ).to.eq(margin.sub(premiumFraction.mul(bobLong).div(_1e18)))

            return premiumFraction
        }
    })

    async function addMargin(trader, margin) {
        await usdc.mint(trader.address, margin)
        await usdc.connect(trader).approve(marginAccountHelper.address, margin)
        await marginAccountHelper.connect(trader).addVUSDMarginWithReserve(margin)
    }
})
