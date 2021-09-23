const { expect } = require('chai');

const { constants: { _1e6, _1e18, ZERO }, getTradeDetails, setupContracts } = require('./utils')

describe('Liquidation Tests', async function() {
    before('factories', async function() {
        signers = await ethers.getSigners()
        ;([ _, bob, liquidator1, liquidator2, admin ] = signers)
        alice = signers[0].address
        ;({ swap, marginAccount, marginAccountHelper, clearingHouse, amm, vusd, usdc, oracle, weth, insuranceFund } = await setupContracts())
    })

    it('addCollateral', async () => {
        await oracle.setPrice(weth.address, 1e6 * 2000) // $2k
        await marginAccount.addCollateral(weth.address, 0.7 * 1e6) // weight = 0.7
    })

    it('addMargin', async () => {
        wethAmount = _1e18.div(2)
        await weth.mint(alice, wethAmount)
        await weth.approve(marginAccount.address, wethAmount)
        await marginAccount.addMargin(1, wethAmount);
    })

    it('alice makes a trade', async function() {
        let tx = await clearingHouse.openPosition(0, _1e18.mul(-5), 0)
        ;({ fee: tradeFee } = await getTradeDetails(tx))
    })

    it('bob makes a counter-trade', async function() {
        const bob = signers[1]
        await addMargin(bob, _1e6.mul(10000))
        await clearingHouse.connect(bob).openPosition(0, _1e18.mul(45), _1e6.mul(50000))
    })

    it('alice\'s position is liquidated', async function() {
        expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.false
        ;({ unrealizedPnl, notionalPosition } = await amm.getNotionalPositionAndUnrealizedPnl(alice))

        await clearingHouse.connect(liquidator1).liquidate(alice)

        const liquidationPenalty = notionalPosition.mul(5e4).div(_1e6)
        expect(await marginAccount.margin(0, alice)).to.eq(
            unrealizedPnl.sub(liquidationPenalty).sub(tradeFee)
        )
    })

    it('alice is in liquidation zone B', async function() {
        const { weighted, spot } = await marginAccount.weightedAndSpotCollateral(alice)
        const repayAmount = (await marginAccount.margin(0, alice)).abs()
        expect(weighted.lt(ZERO)).to.be.true
        expect(spot.gt(ZERO)).to.be.true
    })

    it('alice\'s margin account is partially liquidated', async function() {
        // the vusd margin is ~ -742, whereas .5 eth at weight = 0.7 and price = 2k allows for $700 margin
        const aliceVusdMargin = await marginAccount.margin(0, alice)
        const repayAmount = aliceVusdMargin.abs().div(2) // 742 / 2 = 371

        await vusd.grantRole(await vusd.MINTER_ROLE(), admin.address)
        await vusd.connect(admin).mint(liquidator2.address, repayAmount)
        await vusd.connect(liquidator2).approve(marginAccount.address, repayAmount)

        const seizeAmount = repayAmount
            .mul(1e6 + 5e4 /* 5% liquidationIncentive */)
            .div(1e6 * 2000 /* eth price in the oracle */)
            .mul(_1e6.mul(_1e6)) // 12 decimals for eth

        await expect(
            marginAccount.connect(liquidator2).liquidate(alice, repayAmount, 1, seizeAmount.add(1) /* minSeizeAmount */)
        ).to.be.revertedWith('Not seizing enough')

        await marginAccount.connect(liquidator2).liquidate(alice, repayAmount, 1, seizeAmount /* minSeizeAmount */)

        expect(await weth.balanceOf(liquidator2.address)).to.eq(seizeAmount)
        expect(await vusd.balanceOf(liquidator2.address)).to.eq(ZERO)
        expect(await marginAccount.margin(0, alice)).to.eq(aliceVusdMargin.add(repayAmount))
        expect(await marginAccount.margin(1, alice)).to.eq(wethAmount.sub(seizeAmount))
    })

    it('alice is out of liquidation zone', async function() {
        const { weighted, spot } = await marginAccount.weightedAndSpotCollateral(alice)
        const repayAmount = (await marginAccount.margin(0, alice)).abs()
        expect(weighted.gt(ZERO)).to.be.true
        expect(spot.gt(ZERO)).to.be.true
    })

    it('alice\'s margin account is partially liquidated with incentivePerDollar < 5%', async function() {
        const aliceVusdMargin = await marginAccount.margin(0, alice) // ~ -371

        // alice has about 0.3 eth margin left over from the liquidation above
        // to fall in liquidation zone, where 0 < spot < |vUSD| * 1.05
        // 371 * 1.03 / .3 = $1273
        oraclePrice = 1e6 * 1250
        await oracle.setPrice(weth.address, oraclePrice)

        const repayAmount = aliceVusdMargin.abs().div(2) // 371 / 2 = 185
        await vusd.connect(admin).mint(liquidator2.address, repayAmount)
        await vusd.connect(liquidator2).approve(marginAccount.address, repayAmount)

        const { weighted, spot } = await marginAccount.weightedAndSpotCollateral(alice)
        expect(weighted.lt(ZERO)).to.be.true
        expect(spot.gt(ZERO)).to.be.true

        const incentivePerDollar = spot.mul(_1e6).div(aliceVusdMargin.abs())
        const seizeAmount = repayAmount
            .mul(_1e6.add(incentivePerDollar))
            .div(oraclePrice)
            .mul(_1e6.mul(_1e6)) // 12 decimals for eth
        await expect(
            marginAccount.connect(liquidator2).liquidate(alice, repayAmount, 1, seizeAmount.add(1) /* minSeizeAmount */)
        ).to.be.revertedWith('Not seizing enough')

        const [ wethLiquidator, wethAlice ] = await Promise.all([
            weth.balanceOf(liquidator2.address),
            marginAccount.margin(1, alice)
        ])
        await marginAccount.connect(liquidator2).liquidate(alice, repayAmount, 1, seizeAmount /* minSeizeAmount */)

        expect((await weth.balanceOf(liquidator2.address)).sub(wethLiquidator)).to.eq(seizeAmount)
        expect(await vusd.balanceOf(liquidator2.address)).to.eq(ZERO)
        expect(await marginAccount.margin(0, alice)).to.eq(aliceVusdMargin.add(repayAmount))
        expect(wethAlice.sub(await marginAccount.margin(1, alice))).to.eq(seizeAmount)
    })

    it('insurance fund settles alice\'s bad debt', async function() {
        const aliceVusdMargin = await marginAccount.margin(0, alice) // ~ -185
        const ethMargin = await marginAccount.margin(1, alice)

        // drop collateral value, so that we get bad debt
        await oracle.setPrice(weth.address, 1e6 * 1000)

        // console.log({
        //     aliceVusdMargin: aliceVusdMargin.toString(),
        //     ethMargin: ethMargin.toString(),
        //     getSpotCollateralValue: (await marginAccount.getSpotCollateralValue(alice)).toString()
        // })

        // provide insurance fund with enough vusd to cover deficit
        await vusd.connect(admin).mint(insuranceFund.address, aliceVusdMargin.abs())

        await marginAccount.settleBadDebt(alice)

        expect(await marginAccount.margin(0, alice)).to.eq(ZERO)
        expect(await marginAccount.margin(1, alice)).to.eq(ZERO)
        expect(await weth.balanceOf(insuranceFund.address)).to.eq(ethMargin)
        expect(await vusd.balanceOf(insuranceFund.address)).to.eq(ZERO)
    })

    async function addMargin(trader, margin) {
        await usdc.mint(trader.address, margin)
        await usdc.connect(trader).approve(marginAccountHelper.address, margin)
        await marginAccountHelper.connect(trader).addVUSDMarginWithReserve(margin)
    }
})
