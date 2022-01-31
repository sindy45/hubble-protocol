const { expect } = require('chai');

const {
    constants: { _1e6, _1e18, ZERO },
    getTradeDetails,
    setupContracts,
    setupRestrictedTestToken
} = require('./utils')

describe('Liquidation Tests', async function() {
    before(async function() {
        signers = await ethers.getSigners()
        ;([ _, bob, liquidator1, liquidator2, liquidator3, admin ] = signers)
        alice = signers[0].address
        ;({ swap, marginAccount, marginAccountHelper, clearingHouse, amm, vusd, usdc, oracle, weth, insuranceFund, hubbleViewer } = await setupContracts())

        await vusd.grantRole(await vusd.MINTER_ROLE(), admin.address) // will mint vusd to liquidators account
    })

    it('addCollateral', async () => {
        oraclePrice = 1e6 * 2000 // $2k
        await oracle.setUnderlyingPrice(weth.address, oraclePrice)
        await marginAccount.whitelistCollateral(weth.address, 0.7 * 1e6) // weight = 0.7
        expect((await marginAccount.isLiquidatable(alice, true))[0]).to.be.false
    })

    it('addMargin', async () => {
        wethMargin = _1e18.div(2)
        await weth.mint(alice, wethMargin)
        await weth.approve(marginAccount.address, wethMargin)
        await marginAccount.addMargin(1, wethMargin)
        expect((await marginAccount.isLiquidatable(alice, true))[0]).to.be.false
    })

    it('alice makes a trade', async function() {
        let tx = await clearingHouse.openPosition(0, _1e18.mul(-5), 0)
        ;({ fee: tradeFee } = await getTradeDetails(tx))
        expect((await marginAccount.isLiquidatable(alice, true))[0]).to.be.false

        const userInfo = await hubbleViewer.userInfo(alice)
        expect(userInfo[0]).to.eq(tradeFee.mul(-1)) // vUSD margin = 0 - tradeFee
        expect(userInfo[1]).to.eq(wethMargin)
    })

    it('bob makes a counter-trade', async function() {
        await addMargin(bob, _1e6.mul(20000))
        await clearingHouse.connect(bob).openPosition(0, _1e18.mul(70), ethers.constants.MaxUint256)
    })

    it('alice\'s position is liquidated', async function() {
        expect((await marginAccount.isLiquidatable(alice, true))[0]).to.be.false // notionalPosition should be 0

        expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.false
        ;({ unrealizedPnl, notionalPosition } = await amm.getNotionalPositionAndUnrealizedPnl(alice))

        const ifVusdBal = await vusd.balanceOf(insuranceFund.address)
        await clearingHouse.connect(liquidator1).liquidate(alice)

        const liquidationPenalty = notionalPosition.mul(5e4).div(_1e6)
        expect(await marginAccount.margin(0, alice)).to.eq(
            unrealizedPnl.sub(liquidationPenalty).sub(tradeFee)
        )

        const toInsurace = liquidationPenalty.div(2)
        expect(
            (await vusd.balanceOf(insuranceFund.address)).sub(ifVusdBal)
        ).to.eq(toInsurace)
        expect(
            await vusd.balanceOf(liquidator1.address)
        ).to.eq(liquidationPenalty.sub(toInsurace))
    })

    it('alice is in liquidation zone B', async function() {
        const { weighted, spot } = await marginAccount.weightedAndSpotCollateral(alice)
        expect(weighted.lt(ZERO)).to.be.true
        expect(spot.gt(ZERO)).to.be.true
        ;({ _isLiquidatable, incentivePerDollar } = await marginAccount.isLiquidatable(alice, true))
        expect(incentivePerDollar.toNumber() / 1e6).to.eq(1.032325)
        expect(_isLiquidatable).to.be.true
    })

    it('liquidateExactSeize (incentivePerDollar = 5%)', async function() {
        // the alice's debt is ~ -968, whereas .5 eth at weight = 0.7 and price = 2k allows for $700 margin
        const seizeAmount = _1e18.div(10) // 0.1 ETH

        // .1 * 2000 / (1 + .05) = ~190
        const repayAmount = seizeAmount.mul(oraclePrice).div(_1e18).mul(_1e6).div(incentivePerDollar)
        await vusd.connect(admin).mint(liquidator2.address, repayAmount)
        await vusd.connect(liquidator2).approve(marginAccount.address, repayAmount)

        await marginAccount.connect(liquidator2).liquidateExactSeize(alice, ethers.constants.MaxUint256, 1, seizeAmount)
        expect(await weth.balanceOf(liquidator2.address)).to.eq(seizeAmount)
        expect(await vusd.balanceOf(liquidator2.address)).to.eq(ZERO)
    })

    it('liquidateFlexible (liquidateExactRepay branch, incentivePerDollar = 5%)', async function() {
        // the vusd margin is -774.x, whereas .4 eth at weight = 0.7 and price = 2k allows for $560 (= .4*.7*2000) margin
        const [
            { weighted, spot },
            { _isLiquidatable, repayAmount, incentivePerDollar },
            wethMargin
        ] = await Promise.all([
            marginAccount.weightedAndSpotCollateral(alice),
            marginAccount.isLiquidatable(alice, true),
            marginAccount.margin(1, alice)
        ])
        expect(parseInt(weighted.toNumber() / 1e6)).to.eq(-214) // .4 * 2000 * .7 - 774.x
        expect(parseInt(spot.toNumber() / 1e6)).to.eq(25) // .4 * 2000 - 774.x
        expect(_isLiquidatable).to.be.true
        expect(incentivePerDollar.toNumber() / 1e6).to.eq(1.032326) // max incentive was (spot + repayAmount) / repayAmount

        await vusd.connect(admin).mint(liquidator3.address, repayAmount)
        await vusd.connect(liquidator3).approve(marginAccount.address, repayAmount)

        // liquidateExactRepay part of if-else is called
        await marginAccount.connect(liquidator3).liquidateFlexible(alice, ethers.constants.MaxUint256, [1])

        const seizeAmount = repayAmount.mul(incentivePerDollar).mul(_1e6.mul(_1e6)).div(oraclePrice) // 12 decimals for eth
        expect(await weth.balanceOf(liquidator3.address)).to.eq(seizeAmount)
        expect(await vusd.balanceOf(liquidator3.address)).to.eq(ZERO)
        expect(await marginAccount.margin(0, alice)).to.eq(ZERO)
        expect(await marginAccount.margin(1, alice)).to.eq(wethMargin.sub(seizeAmount))
    })

    it('alice is out of liquidation zone', async function() {
        const { weighted, spot } = await marginAccount.weightedAndSpotCollateral(alice)
        expect(weighted.gt(ZERO)).to.be.true
        expect(spot.gt(ZERO)).to.be.true
        expect((await marginAccount.isLiquidatable(alice, true))[0]).to.be.false
    })

    async function addMargin(trader, margin) {
        await usdc.mint(trader.address, margin)
        await usdc.connect(trader).approve(marginAccountHelper.address, margin)
        await marginAccountHelper.connect(trader).addVUSDMarginWithReserve(margin)
    }
})

describe('Multi-collateral Liquidation Tests', async function() {
    before(async function() {
        signers = await ethers.getSigners()
        ;([ _, bob, liquidator1, liquidator2, liquidator3, admin ] = signers)
        alice = signers[0].address
        ;({ swap, marginAccount, marginAccountHelper, clearingHouse, amm, vusd, usdc, oracle, weth, insuranceFund } = await setupContracts())
        await vusd.grantRole(await vusd.MINTER_ROLE(), admin.address) // will mint vusd to liquidators account

        // addCollateral
        avax = await setupRestrictedTestToken('AVAX', 'AVAX', 6)
        oraclePrice = 1e6 * 2000 // $2k
        avaxOraclePrice = 1e6 * 50 // $50
        await Promise.all([
            oracle.setUnderlyingPrice(weth.address, oraclePrice),
            oracle.setUnderlyingPrice(avax.address, avaxOraclePrice),
        ])
        await marginAccount.whitelistCollateral(weth.address, 0.7 * 1e6), // weight = 0.7
        await marginAccount.whitelistCollateral(avax.address, 0.8 * 1e6) // weight = 0.8
        expect((await marginAccount.isLiquidatable(alice, true))[0]).to.be.false

        // addMargin
        wethMargin = _1e18.div(4) // $500
        avaxMargin = _1e6.mul(10) // $500
        await Promise.all([
            weth.mint(alice, wethMargin),
            weth.approve(marginAccount.address, wethMargin),
            avax.mint(alice, avaxMargin),
            avax.approve(marginAccount.address, avaxMargin),
        ])
        await marginAccount.addMargin(1, wethMargin)
        await marginAccount.addMargin(2, avaxMargin)
        expect((await marginAccount.isLiquidatable(alice, true))[0]).to.be.false

        // alice makes a trade
        let tx = await clearingHouse.openPosition(0, _1e18.mul(-5), 0)
        ;({ fee: tradeFee } = await getTradeDetails(tx))
        expect((await marginAccount.isLiquidatable(alice, true))[0]).to.be.false

        // bob makes a counter-trade
        await addMargin(bob, _1e6.mul(20000))
        await clearingHouse.connect(bob).openPosition(0, _1e18.mul(70), ethers.constants.MaxUint256)
    })

    it('alice\'s position is liquidated', async function() {
        expect((await marginAccount.isLiquidatable(alice, true))[0]).to.be.false // notionalPosition should be 0

        expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.false
        ;({ unrealizedPnl, notionalPosition } = await amm.getNotionalPositionAndUnrealizedPnl(alice))

        const ifVusdBal = await vusd.balanceOf(insuranceFund.address)
        await clearingHouse.connect(liquidator1).liquidate(alice)

        const liquidationPenalty = notionalPosition.mul(5e4).div(_1e6)
        expect(await marginAccount.margin(0, alice)).to.eq(
            unrealizedPnl.sub(liquidationPenalty).sub(tradeFee)
        )

        const toInsurace = liquidationPenalty.div(2)
        expect(
            (await vusd.balanceOf(insuranceFund.address)).sub(ifVusdBal)
        ).to.eq(toInsurace)
        expect(
            await vusd.balanceOf(liquidator1.address)
        ).to.eq(liquidationPenalty.sub(toInsurace))
    })

    it('alice is in liquidation zone B', async function() {
        const { weighted, spot } = await marginAccount.weightedAndSpotCollateral(alice)
        expect(weighted.lt(ZERO)).to.be.true
        expect(spot.gt(ZERO)).to.be.true
        ;({ _isLiquidatable, incentivePerDollar } = await marginAccount.isLiquidatable(alice, true))
        expect(_isLiquidatable).to.be.true
    })

    it('liquidateFlexible (_liquidateExactSeize branch, incentivePerDollar < 5%)', async function() {
        // the alice's debt is -968.x, margin = .25*2000*.7 + 10*50*.8 = $750, spot = .25*2000 + 10*50 = $1000
        const [
            { weighted, spot },
            { _isLiquidatable, repayAmount, incentivePerDollar },
            wethMargin
        ] = await Promise.all([
            marginAccount.weightedAndSpotCollateral(alice),
            marginAccount.isLiquidatable(alice, true),
            marginAccount.margin(1, alice)
        ])
        expect(parseInt(weighted.toNumber() / 1e6)).to.eq(-218) // 750 - 968.x
        expect(parseInt(spot.toNumber() / 1e6)).to.eq(31) // 1000 - 968.x
        expect(_isLiquidatable).to.be.true
        expect(incentivePerDollar.toNumber() / 1e6).to.eq(1.032325) // min(1.05, 1000/968.48)

        await vusd.connect(admin).mint(liquidator3.address, repayAmount)
        await vusd.connect(liquidator3).approve(marginAccount.address, repayAmount)

        // _liquidateExactSeize part of if-else is called
        await marginAccount.connect(liquidator3).liquidateFlexible(alice, ethers.constants.MaxUint256, [1])

        expect(await weth.balanceOf(liquidator3.address)).to.eq(wethMargin)
        expect((await marginAccount.margin(0, alice)).lt(ZERO)).to.be.true // still unpaid
        expect(await marginAccount.margin(1, alice)).to.eq(ZERO)
    })

    it('liquidateExactRepay (incentivePerDollar < 5%)', async function() {
        // the alice's debt is -484.x, margin = 10*50*.8 = $400, spot = 10*50 = $500
        const [
            { weighted, spot },
            { _isLiquidatable, repayAmount, incentivePerDollar },
            avaxMargin
        ] = await Promise.all([
            marginAccount.weightedAndSpotCollateral(alice),
            marginAccount.isLiquidatable(alice, true),
            marginAccount.margin(2, alice)
        ])
        expect(parseInt(weighted.toNumber() / 1e6)).to.eq(-84) // 400 - 484.x
        expect(parseInt(spot.toNumber() / 1e6)).to.eq(15) // 500 - 484.x
        expect(_isLiquidatable).to.be.true
        expect(incentivePerDollar.toNumber() / 1e6).to.eq(1.032326) // min(1.05, 500/484.34)

        const repay = _1e6.mul(200) // < 484
        await vusd.connect(admin).mint(liquidator2.address, repay)
        await vusd.connect(liquidator2).approve(marginAccount.address, repay)

        const seizeAmount = repay.mul(incentivePerDollar).div(avaxOraclePrice)
        await expect(
            marginAccount.connect(liquidator2).liquidateExactRepay(alice, repay, 2, seizeAmount.add(1) /* minSeizeAmount */)
        ).to.be.revertedWith('Not seizing enough')

        await marginAccount.connect(liquidator2).liquidateExactRepay(alice, repay, 2, seizeAmount)
        // console.log((await marginAccount.margin(0, alice)).toString())

        expect(await avax.balanceOf(liquidator2.address)).to.eq(seizeAmount)
        expect(await vusd.balanceOf(liquidator2.address)).to.eq(ZERO)
        expect(await marginAccount.margin(0, alice)).to.eq(repayAmount.sub(repay).mul(-1))
        expect(await marginAccount.margin(2, alice)).to.eq(avaxMargin.sub(seizeAmount))
    })

    it('insurance fund settles alice\'s bad debt', async function() {
        const aliceVusdMargin = await marginAccount.margin(0, alice) // ~ -260.91
        const avaxMargin = await marginAccount.margin(2, alice) // 5.8063

        // drop collateral value, so that we get bad debt
        await oracle.setUnderlyingPrice(avax.address, 1e6 * 40)

        // console.log({
        //     aliceVusdMargin: aliceVusdMargin.toString(),
        //     avaxMargin: avaxMargin.toString(),
        //     getSpotCollateralValue: (await marginAccount.getSpotCollateralValue(alice)).toString()
        // })

        // provide insurance fund with enough vusd to cover deficit
        const bal = await vusd.balanceOf(insuranceFund.address) // trade and liquidation fee
        if (bal.lt(aliceVusdMargin.abs())) {
            await vusd.connect(admin).mint(insuranceFund.address, aliceVusdMargin.abs().sub(bal))
        }
        expect(await vusd.balanceOf(insuranceFund.address)).to.eq(aliceVusdMargin.abs())

        await marginAccount.settleBadDebt(alice)

        expect(await marginAccount.margin(0, alice)).to.eq(ZERO)
        expect(await marginAccount.margin(1, alice)).to.eq(ZERO)
        expect(await marginAccount.margin(2, alice)).to.eq(ZERO)
        expect(await avax.balanceOf(insuranceFund.address)).to.eq(avaxMargin)
        expect(await vusd.balanceOf(insuranceFund.address)).to.eq(ZERO)
        expect((await marginAccount.isLiquidatable(alice, true))[0]).to.be.false
    })

    it('liquidateFlexible with >=2 collateral excluding vusd');

    async function addMargin(trader, margin) {
        await usdc.mint(trader.address, margin)
        await usdc.connect(trader).approve(marginAccountHelper.address, margin)
        await marginAccountHelper.connect(trader).addVUSDMarginWithReserve(margin)
    }
})
