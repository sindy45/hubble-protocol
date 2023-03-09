const { expect } = require('chai');
const utils = require('../utils')

const {
    constants: { _1e6, _1e12, _1e18, ZERO },
    assertions,
    setupContracts,
    addMargin,
    setupRestrictedTestToken,
} = utils

const TRADE_FEE = 0.000567 * _1e6

describe('Twap Price Tests', function() {
    /*
        Test data
        spot price (scaled by 6 demicals)
            1000000000
            999900000
            999700000
            1000000000
            999600000
            999100000
            999700000
            999000000
            998200000
            999100000
            998100000
            997000000
            998200000
            996900000
            995500000
            997000000
            995400000
            993700000
            995500000
            993600000
            991600000
            993700000
            991500000
            989200000
            991600000
            989100000
            986500000
            989200000
            986400000
            983500000
    */

    before('generate sample snapshots', async function() {
        signers = await ethers.getSigners()
        alice = signers[0].address
        ;({ amm } = await setupContracts({ tradeFee: TRADE_FEE }))
        // add margin
        margin = _1e6.mul(10000)
        await addMargin(signers[0], margin)

        baseAssetQuantity = _1e18.mul(5)

        // spot price after long ~ 1003
        // spot price after first short ~ 1002
        // spot price after second short ~ 1001
        let timestamp = Date.now()
        for (let i = 0; i < 30; i++) {
            if (i % 3 == 0) {
                let markPrice = await amm.lastPrice();
                markPrice = markPrice.add(_1e6.mul(i).div(10))
                const base = baseAssetQuantity.mul(2)
                const quote = markPrice.mul(base).div(_1e18).abs()

                await clearingHouse.openPosition2(0, base, quote)
                timestamp += 14
                await increaseEvmTime(timestamp)
            } else {
                let markPrice = await amm.lastPrice();
                markPrice = markPrice.sub(_1e6.mul(i).div(10))
                const base = baseAssetQuantity.mul(-1)
                const quote = markPrice.mul(base).div(_1e18).abs()

                await clearingHouse.openPosition2(0, base, quote)
                timestamp += 28
                await increaseEvmTime(timestamp)
            }
        }
    })

    it('get TWAP price', async () => {
        // latest spot price is not considered in the calcualtion as delta t is 0
        // total snapshots in 420 seconds = 18
        //  (
        //    (997000000+998200000+995500000+993700000+991600000+989200000)*14 +
        //    (997000000+996900000+995500000+995400000+993700000+993600000+991600000+991500000+989200000+989100000+986500000+986400000)*28
        // ) / 420 = 992.60

        const twap = await amm.getTwapPrice(420)
        expect((twap.toNumber() / 1e6).toFixed(2)).to.eq('992.60')
    })

    it('the timestamp of latest snapshot=now, the latest snapshot wont have any effect', async () => {
        await clearingHouse.openPosition2(0, baseAssetQuantity.mul(-1), ZERO)

        // Shaving off 20 secs from the 420s window would mean dropping the first 1003 snapshot and 6 secs off the 1002 reading.
        // twap = (1003 * 5 snapshots * 14 sec + 1002 * 22 sec + 1002*5*28 + 1001*6*28)/400 = 1002.x
        const twap = await amm.getTwapPrice(400)
        expect((twap.toNumber() / 1e6).toFixed(2)).to.eq('991.39')
    })

    it('asking interval more than the snapshots', async () => {
        // total 31 snapshots, out of which latest doesn't count
        // twap = (1003 * 10 snapshots * 14 sec + 1002*10*28 + 1001*10*28)/700 ~ 1001.x

        const twap = await amm.getTwapPrice(900)
        expect((twap.toNumber() / 1e6).toFixed(2)).to.eq('995.82')
    })

    it('asking interval less than latest snapshot, return latest price directly', async () => {
        // price is 1000.4
        await increaseEvmTime(Date.now() + 500)
        await clearingHouse.openPosition2(0, baseAssetQuantity.mul(-1), ZERO) // add a delay of 500 seconds

        const twap = await amm.getTwapPrice(420)
        expect((twap.toNumber() / 1e6).toFixed(2)).to.eq('983.50')
    })

    it('price with interval 0 should be the same as spot price', async () => {
        expect(await amm.getTwapPrice(0)).to.eq(await amm.lastPrice())
    })
})

describe('AMM unit tests', async function() {
    before(async function() {
        signers = await ethers.getSigners()
        ;([ alice ] = signers.map(s => s.address))
        bob = signers[1]

        initialPrice = _1e6.mul(1000)
        contracts = await setupContracts({ amm: { whitelist: false, initialPrice }})
        ;({ registry, marginAccount, marginAccountHelper, clearingHouse, amm, vusd, weth, usdc, hubbleViewer, liquidationPriceViewer, orderBook } = contracts)

        // add margin
        margin = _1e6.mul(2000)
        await addMargin(signers[0], margin)
        // set min size to 0.5
        await amm.setMinSizeRequirement(_1e18.div(2))
    })

    it('openPosition fails when amm not whitelisted', async () => {
        // CH doesn't know about the AMM yet
        await expect(
            clearingHouse.openPosition2(0, -1, 0)
        ).to.be.revertedWith('Array accessed at an out-of-bounds or negative index')
    })

    it('whitelist amm', async () => {
        expect(await clearingHouse.getAmmsLength()).to.eq(0)
        let markets = await hubbleViewer.markets()
        expect(markets.length).to.eq(0)

        await clearingHouse.whitelistAmm(amm.address)

        expect(await clearingHouse.getAmmsLength()).to.eq(1)
        markets = await hubbleViewer.markets()
        expect(markets.length).to.eq(1)
        expect(markets[0].amm).to.eq(amm.address)
        expect(markets[0].underlying).to.eq(weth.address)
    })

    it('openPosition work when amm whitelisted', async () => {
        const baseAssetQuantity = _1e18.mul(-1)
        await clearingHouse.openPosition2(0, _1e18.mul(-1), 0)
        const notionalPosition = baseAssetQuantity.mul(initialPrice).div(_1e18).abs()
        await assertions(contracts, alice, {
            size: baseAssetQuantity,
            openNotional: notionalPosition,
            notionalPosition,
            unrealizedPnl: ZERO
        })
    })

    it('add 2nd amm', async () => {
        avax = await utils.setupRestrictedTestToken('avax', 'avax', 6)
        ;({ amm: avaxAmm } = await utils.setupAmm(
            alice,
            [ 'AVAX-PERP', avax.address, oracle.address, 100 /* min size = 100 wei */ ],
            {
                initialRate: 65,
                whitelist: false
            }
        ))
        // assert that AMM hasn't been whitelisted as yet
        expect(await clearingHouse.getAmmsLength()).to.eq(1)
    })

    it('other amms will work as usual when 1 amm is not whitelisted', async () => {
        await oracle.setUnderlyingTwapPrice(weth.address, _1e6.mul(900))
        await utils.gotoNextFundingTime(amm)

        await ops()

        expect((await amm.cumulativePremiumFraction()).gt(0)).to.be.true
        expect(await avaxAmm.cumulativePremiumFraction()).to.eq(0)
    })

    it('other amms will work as usual when last amm is whitelisted', async () => {
        await clearingHouse.whitelistAmm(avaxAmm.address)
        await utils.gotoNextFundingTime(avaxAmm)

        // settleFunding will succeed even when there's no trade; premiumFraction will be ZERO
        await clearingHouse.settleFunding()

        expect(await avaxAmm.cumulativePremiumFraction()).to.eq(ZERO)

        // opening small positions will fail
        await expect(
            clearingHouse.connect(bob).openPosition2(0, _1e18.div(-10), 0)
        ).to.be.revertedWith('position_less_than_minSize')
        await expect(
            clearingHouse.connect(bob).openPosition2(0, _1e18.div(10), 0)
        ).to.be.revertedWith('position_less_than_minSize')
        await clearingHouse.openPosition2(1, -10000, 0)

        await ops()
    })

    it('min size requirement', async () => {
        await clearingHouse.closePosition(0)

        let posSize = _1e18.mul(-5)
        await clearingHouse.openPosition2(0, posSize, 0)
        // net position = -0.4
        posSize = _1e18.mul(46).div(10)
        await expect(clearingHouse.openPosition2(0, posSize, 0)).to.be.revertedWith('position_less_than_minSize')
        // net position = 0.3
        posSize = _1e18.mul(53).div(10)
        await expect(clearingHouse.openPosition2(0, posSize, 0)).to.be.revertedWith('position_less_than_minSize')
    })

    async function ops() {
        return Promise.all([
            clearingHouse.settleFunding(),
            clearingHouse.updatePositions(alice),
            clearingHouse.openPosition2(0, _1e18.mul(-1), 0)
        ])
    }
})

describe('Oracle Price Spread Check', async function() {
    beforeEach(async function() {
        signers = await ethers.getSigners()
        ;([ alice ] = signers.map(s => s.address))
        bob = signers[1]

        contracts = await setupContracts({ tradeFee: TRADE_FEE, amm: { testAmm: true }})
        ;({ marginAccount, oracle, clearingHouse, amm, vusd, weth, swap, hubbleViewer } = contracts)

        // addCollateral, using a different collateral to make a trader liquidable easily
        avax = await setupRestrictedTestToken('AVAX', 'AVAX', 6)
        avaxOraclePrice = 1e6 * 100 // $100
        await Promise.all([
            oracle.setUnderlyingPrice(avax.address, avaxOraclePrice),
            marginAccount.whitelistCollateral(avax.address, 0.8 * 1e6) // weight = 0.8
        ])

        // addMargin
        avaxMargin = _1e6.mul(20) // $2000
        await Promise.all([
            avax.mint(alice, avaxMargin),
            avax.approve(marginAccount.address, avaxMargin),
        ])
        await marginAccount.addMargin(1, avaxMargin)

        // set markPrice
        await clearingHouse.openPosition2(0, _1e18.mul(-1), 0)
    })

    it('price decrease not allowed when markPrice is below price spread', async function() {
        // markPrice = 1000, indexPrice = 1000/0.8 = 1250
        await oracle.setUnderlyingPrice(weth.address, _1e6.mul(1250))
        expect(await amm.isOverSpreadLimit()).to.be.true
        await expect(
            clearingHouse.openPosition2(0, _1e18.mul(-5), _1e6.mul(4999)) // price = 4999 / 5 = 999.8
        ).to.be.revertedWith('AMM_price_decrease_not_allowed')

        // longs allowed
        await clearingHouse.openPosition2(0, _1e18.mul(5), _1e6.mul(5000))
    })

    it('price increase not allowed when markPrice is above price spread', async function() {
        // markPrice = 1000, indexPrice = 1000/1.2 = 833
        await oracle.setUnderlyingPrice(weth.address, _1e6.mul(833))
        expect(await amm.isOverSpreadLimit()).to.be.true
        await expect(
            clearingHouse.openPosition2(0, _1e18.mul(5), ethers.constants.MaxUint256)
        ).to.be.revertedWith('AMM_price_increase_not_allowed')

        // shorts allowed
        await clearingHouse.openPosition2(0, _1e18.mul(-5), 0)
    })

    // marginFraction < maintenanceMargin < minAllowableMargin < oracleBasedMF
    it('amm isOverSpreadLimit on long side', async function() {
        expect(await amm.isOverSpreadLimit()).to.be.false
        await clearingHouse.openPosition2(0, _1e18.mul(-5), 0)

        // bob makes counter-trade to drastically reduce amm based marginFraction
        avaxMargin = _1e6.mul(2000)
        await Promise.all([
            avax.mint(bob.address, avaxMargin),
            avax.connect(bob).approve(marginAccount.address, avaxMargin),
        ])
        await marginAccount.connect(bob).addMargin(1, avaxMargin)
        await oracle.setUnderlyingPrice(weth.address, _1e6.mul(1100))
        await clearingHouse.connect(bob).openPosition2(0, _1e18.mul(120), _1e6.mul(144000)) // price = 1200

        // Get amm over spread limit
        await oracle.setUnderlyingPrice(weth.address, _1e6.mul(700))
        expect(await amm.isOverSpreadLimit()).to.be.true

        // evaluate both MFs independently from the AMM
        const margin = await marginAccount.getNormalizedMargin(alice) // avaxMargin * avaxOraclePrice * .8 - tradeFee and no funding payments
        ;([
            { unrealizedPnl, notionalPosition },
            { marginFraction: oracleBasedMF },
            minAllowableMargin,
            maintenanceMargin,
        ] = await Promise.all([
            amm.getNotionalPositionAndUnrealizedPnl(alice),
            amm.getOracleBasedMarginFraction(alice, margin),
            clearingHouse.minAllowableMargin(),
            clearingHouse.maintenanceMargin()
        ]))
        const marginFraction = margin.add(unrealizedPnl).mul(_1e6).div(notionalPosition)

        // asserting that we have indeed created the conditions we are testing in this test case
        expect(marginFraction.lt(maintenanceMargin)).to.be.true
        expect(maintenanceMargin.lt(minAllowableMargin)).to.be.true
        expect(minAllowableMargin.lt(oracleBasedMF)).to.be.true

        // then assert that clearingHouse has indeed to oracle based pricing for liquidations but marginFraction for trades
        expect(
            await clearingHouse.calcMarginFraction(alice, true, 0)
        ).to.eq(oracleBasedMF)
        expect(
            await clearingHouse.calcMarginFraction(alice, true, 1)
        ).to.eq(marginFraction)

        // cannot make a trade
        await expect(
            clearingHouse.assertMarginRequirement(alice)
        ).to.be.revertedWith('CH: Below Minimum Allowable Margin')

        // However, when it comes to liquidation, oracle based pricing will kick in again
        expect(await clearingHouse.calcMarginFraction(alice, false, 0 /* Maintenance_Margin */)).to.eq(oracleBasedMF)
        await expect(
            clearingHouse.liquidate2(alice)
        ).to.be.revertedWith('CH: Above Maintenance Margin')

        // Finally, trader will be liquidable once both MFs are < maintenanceMargin
        await oracle.setUnderlyingPrice(weth.address, _1e6.mul(1500))
        ;({ marginFraction: oracleBasedMF } = await amm.getOracleBasedMarginFraction(alice, margin))
        expect(oracleBasedMF.lt(maintenanceMargin)).to.be.true
        await clearingHouse.liquidate2(alice)
    })

    // we will assert that oracle based pricing kicks in when lastPrice = ~998, indexPrice = 1300
    // oracleBasedMF < maintenanceMargin < minAllowableMargin < marginFraction
    it('amm isOverSpreadLimit on short side', async function() {
        expect(await amm.isOverSpreadLimit()).to.be.false
        await clearingHouse.openPosition2(0, _1e18.mul(-5), 0)

        await oracle.setUnderlyingPrice(weth.address, _1e6.mul(1300))
        expect(await amm.isOverSpreadLimit()).to.be.true

        // evaluate both MFs independently from the AMM
        let margin = await marginAccount.getNormalizedMargin(alice) // avaxMargin * avaxOraclePrice * .8 - tradeFee and no funding payments
        ;([
            { unrealizedPnl, notionalPosition },
            { marginFraction: oracleBasedMF },
            minAllowableMargin,
            maintenanceMargin,
        ] = await Promise.all([
            amm.getNotionalPositionAndUnrealizedPnl(alice),
            amm.getOracleBasedMarginFraction(alice, margin),
            clearingHouse.minAllowableMargin(),
            clearingHouse.maintenanceMargin()
        ]))
        let marginFraction = margin.add(unrealizedPnl).mul(_1e6).div(notionalPosition)

        // asserting that we have indeed created the conditions we are testing in this test case
        expect(oracleBasedMF.lt(maintenanceMargin)).to.be.true
        expect(maintenanceMargin.lt(minAllowableMargin)).to.be.true
        expect(minAllowableMargin.lt(marginFraction)).to.be.true // trade would be allowed based on amm alone

        // then assert that clearingHouse has indeed to oracle based pricing for trades but marginFraction for liquidations
        expect(
            await clearingHouse.calcMarginFraction(alice, true, 0)
        ).to.eq(marginFraction)
        expect(
            await clearingHouse.calcMarginFraction(alice, true, 1)
        ).to.eq(oracleBasedMF)

        // cannot make a trade
        await expect(
            clearingHouse.assertMarginRequirement(alice)
        ).to.be.revertedWith('CH: Below Minimum Allowable Margin')

        // can reduce position however (doesn't revert)
        await clearingHouse.callStatic.closePosition(0)

        // However, when it comes to liquidation, amm based marginFraction will kick in again
        expect(await clearingHouse.calcMarginFraction(alice, false, 0 /* Maintenance_Margin */)).to.eq(marginFraction)
        await expect(
            clearingHouse.liquidate2(alice)
        ).to.be.revertedWith('CH: Above Maintenance Margin')

        // Finally, trader will be liquidable once both MFs are < maintenanceMargin
        // dropping collateral price to make amm based MF fall below maintenanceMargin
        await oracle.setUnderlyingPrice(avax.address, _1e6.mul(30))
        margin = await marginAccount.getNormalizedMargin(alice)
        ;([
            { unrealizedPnl, notionalPosition },
            { marginFraction: oracleBasedMF }
        ] = await Promise.all([
            amm.getNotionalPositionAndUnrealizedPnl(alice),
            amm.getOracleBasedMarginFraction(alice, margin)
        ]))
        marginFraction = margin.add(unrealizedPnl).mul(_1e6).div(notionalPosition)
        // oracleBasedMF < marginFraction < maintenanceMargin
        expect(oracleBasedMF.lt(marginFraction)).to.be.true
        expect(marginFraction.lt(maintenanceMargin)).to.be.true

        await clearingHouse.liquidate2(alice)
    })
})

describe('Mark price spread check in single block', async function() {
    before(async function() {
        signers = await ethers.getSigners()
        ;([ alice ] = signers.map(s => s.address))

        contracts = await setupContracts()
        ;({ marginAccount, oracle, clearingHouse, amm, vusd, weth } = contracts)
        // addMargin
        await addMargin(signers[0], _1e12)
        await clearingHouse.openPosition2(0, _1e18.mul(-5), 0)

        // set maxPriceSpreadPerBlock = 1%
        await amm.setPriceSpreadParams(5 * 1e4, 1e4)
    })

    it.skip('does not allow trade if mark price move more than 1%', async function() {
        await expect(clearingHouse.openPosition2(0, _1e18.mul(20), _1e6.mul(20200))).to.be.revertedWith('AMM.single_block_price_slippage') // price 1010
        await expect(clearingHouse.openPosition2(0, _1e18.mul(-20), _1e6.mul(19800))).to.be.revertedWith('AMM.single_block_price_slippage') // price 990
    })

    it('allow trade if mark price movement is within 1%', async function() {
        await clearingHouse.openPosition2(0, _1e18.mul(20), _1e6.mul(20199))
        await clearingHouse.openPosition2(0, _1e18.mul(-20), _1e6.mul(20000))
    })
})

async function increaseEvmTime(timeInSeconds) {
    await network.provider.send('evm_setNextBlockTimestamp', [timeInSeconds]);
}
