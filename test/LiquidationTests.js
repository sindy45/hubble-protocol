const { expect } = require('chai');
const { BigNumber } = require('ethers')

const {
    constants: { _1e6, _1e18, ZERO },
    getTradeDetails,
    setupContracts,
    setupRestrictedTestToken,
    filterEvent,
    addMargin
} = require('./utils')

describe('Liquidation Tests', async function() {
    before(async function() {
        signers = await ethers.getSigners()
        ;([ _, bob, liquidator1, liquidator2, liquidator3, admin ] = signers)
        alice = signers[0].address
        ;({ swap, marginAccount, marginAccountHelper, clearingHouse, amm, vusd, usdc, oracle, weth, insuranceFund, hubbleViewer } = await setupContracts())

        await vusd.grantRole(await vusd.MINTER_ROLE(), admin.address) // will mint vusd to liquidators account
        await clearingHouse.setParams(
            1e5 /** maintenance margin */,
            1e5 /** minimum allowable margin */,
            5e2 /** tradeFee */,
            5e4 /** liquidationPenalty */
        )
        await amm.setMaxLiquidationRatio(100)
    })

    it('addCollateral', async () => {
        oraclePrice = 1e6 * 1000 // $1k
        await oracle.setUnderlyingPrice(weth.address, oraclePrice)
        await marginAccount.whitelistCollateral(weth.address, 0.7 * 1e6) // weight = 0.7
        expect((await marginAccount.isLiquidatable(alice, true))[0]).to.eq(2)
    })

    it('addMargin', async () => {
        wethMargin = _1e18
        await weth.mint(alice, wethMargin)
        await weth.approve(marginAccount.address, wethMargin)

        // being lazy, adding a pausability test here
        await marginAccount.pause()
        await expect(
            marginAccount.addMargin(1, wethMargin)
        ).to.be.revertedWith('Pausable: paused')
        await marginAccount.unpause()

        await marginAccount.addMargin(1, wethMargin)
        expect((await marginAccount.isLiquidatable(alice, true))[0]).to.eq(2)
    })

    it('alice makes a trade', async function() {
        // being lazy, adding a pausability test here
        await clearingHouse.pause()
        await expect(
            clearingHouse.openPosition(0, _1e18.mul(-5), 0)
        ).to.be.revertedWith('Pausable: paused')
        await clearingHouse.unpause()

        let tx = await clearingHouse.openPosition(0, _1e18.mul(-5), 0)
        ;({ fee: tradeFee } = await getTradeDetails(tx))
        expect((await marginAccount.isLiquidatable(alice, true))[0]).to.eq(1)

        const userInfo = await hubbleViewer.userInfo(alice)
        expect(userInfo[0]).to.eq(tradeFee.mul(-1)) // vUSD margin = 0 - tradeFee
        expect(userInfo[1]).to.eq(wethMargin)
    })

    it('bob makes a counter-trade', async function() {
        await addMargin(bob, _1e6.mul(20000))
        await clearingHouse.connect(bob).openPosition(0, _1e18.mul(70), ethers.constants.MaxUint256)
    })

    it('alice\'s position is liquidated', async function() {
        expect((await marginAccount.isLiquidatable(alice, true))[0]).to.eq(1)

        expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.false
        ;({ unrealizedPnl, notionalPosition } = await amm.getNotionalPositionAndUnrealizedPnl(alice))

        const ifVusdBal = await vusd.balanceOf(insuranceFund.address)

        // being lazy, adding a pausability test here
        await clearingHouse.pause()
        await expect(
            clearingHouse.connect(liquidator1).liquidateTaker(alice)
        ).to.be.revertedWith('Pausable: paused')
        await clearingHouse.unpause()

        await clearingHouse.connect(liquidator1).liquidateTaker(alice)

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
        expect(_isLiquidatable).to.eq(0) // IS_LIQUIDATABLE
    })

    it('liquidateExactSeize (incentivePerDollar = 5%)', async function() {
        // the alice's debt is ~ -968, whereas 1 eth at weight = 0.7 and price = 1k allows for $700 margin
        const seizeAmount = _1e18.mul(2).div(10) // 0.2 ETH

        // .2 * 1000 / (1 + .05) = ~190
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
        expect(_isLiquidatable).to.eq(0) // IS_LIQUIDATABLE
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
        expect((await marginAccount.isLiquidatable(alice, true))[0]).to.eq(2) // NO_DEBT
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
        ;([ _, bob, liquidator1, liquidator2, liquidator3, admin, charlie ] = signers)
        alice = signers[0].address
        ;({ swap, marginAccount, marginAccountHelper, clearingHouse, amm, vusd, usdc, oracle, weth, insuranceFund } = await setupContracts())
        await vusd.grantRole(await vusd.MINTER_ROLE(), admin.address) // will mint vusd to liquidators account
        await clearingHouse.setParams(
            1e5 /** maintenance margin */,
            1e5 /** minimum allowable margin */,
            5e2 /** tradeFee */,
            5e4 /** liquidationPenalty */
        )

        await amm.setMaxLiquidationRatio(100)

        // addCollateral
        avax = await setupRestrictedTestToken('AVAX', 'AVAX', 6)
        await avax.grantRole(ethers.utils.id('TRANSFER_ROLE'), insuranceFund.address)
        oraclePrice = 1e6 * 1000 // $1k
        avaxOraclePrice = 1e6 * 50 // $50
        await Promise.all([
            oracle.setUnderlyingPrice(weth.address, oraclePrice),
            oracle.setUnderlyingPrice(avax.address, avaxOraclePrice),
        ])
        await marginAccount.whitelistCollateral(weth.address, 0.7 * 1e6), // weight = 0.7
        await marginAccount.whitelistCollateral(avax.address, 0.8 * 1e6) // weight = 0.8
        expect((await marginAccount.isLiquidatable(alice, true))[0]).to.eq(2) // NO_DEBT

        // addMargin
        wethMargin = _1e18.div(2) // $500
        avaxMargin = _1e6.mul(10) // $500
        await Promise.all([
            weth.mint(alice, wethMargin),
            weth.approve(marginAccount.address, wethMargin),
            avax.mint(alice, avaxMargin),
            avax.approve(marginAccount.address, avaxMargin),
        ])
        await marginAccount.addMargin(1, wethMargin)
        await marginAccount.addMargin(2, avaxMargin)
        expect((await marginAccount.isLiquidatable(alice, true))[0]).to.eq(2) // NO_DEBT

        // alice makes a trade
        let tx = await clearingHouse.openPosition(0, _1e18.mul(-5), 0)
        ;({ fee: tradeFee } = await getTradeDetails(tx))
        expect((await marginAccount.isLiquidatable(alice, true))[0]).to.eq(1) // OPEN_POSITIONS

        // bob makes a counter-trade
        await addMargin(bob, _1e6.mul(20000))
        await clearingHouse.connect(bob).openPosition(0, _1e18.mul(70), ethers.constants.MaxUint256)
    })

    it('alice\'s position is liquidated', async function() {
        expect((await marginAccount.isLiquidatable(alice, true))[0]).to.eq(1) // OPEN_POSITIONS

        expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.false
        ;({ unrealizedPnl, notionalPosition } = await amm.getNotionalPositionAndUnrealizedPnl(alice))

        const ifVusdBal = await vusd.balanceOf(insuranceFund.address)
        await clearingHouse.connect(liquidator1).liquidateTaker(alice)

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
        expect(_isLiquidatable).to.eq(0) // IS_LIQUIDATABLE
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
        expect(_isLiquidatable).to.eq(0) // IS_LIQUIDATABLE
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
        expect(_isLiquidatable).to.eq(0) // IS_LIQUIDATABLE
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
        avaxMargin = await marginAccount.margin(2, alice) // 5.8063

        // drop collateral value, so that we get bad debt
        oraclePrice = _1e6.mul(40)
        await oracle.setUnderlyingPrice(avax.address, oraclePrice)

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
        expect(await insuranceFund.isAuctionOngoing(avax.address)).to.eq(false)

        const tx = await marginAccount.settleBadDebt(alice)
        auctionTimestamp = (await ethers.provider.getBlock(tx.blockNumber)).timestamp

        expect(await marginAccount.margin(0, alice)).to.eq(ZERO)
        expect(await marginAccount.margin(1, alice)).to.eq(ZERO)
        expect(await marginAccount.margin(2, alice)).to.eq(ZERO)
        expect(await avax.balanceOf(insuranceFund.address)).to.eq(avaxMargin)
        expect(await vusd.balanceOf(insuranceFund.address)).to.eq(ZERO)
        expect((await marginAccount.isLiquidatable(alice, true))[0]).to.eq(2) // NO_DEBT
        // avax auction started
        const avaxAuction = await insuranceFund.auctions(avax.address)
        auctionDuration = await insuranceFund.auctionDuration()
        startPrice = oraclePrice.mul(105).div(100)
        expect(avaxAuction.startedAt).to.eq(auctionTimestamp)
        // endTime = start + auction duration
        expect(avaxAuction.expiryTime).to.eq(auctionDuration.add(auctionTimestamp))
        // startPrice = oraclePrice * 1.05
        expect(avaxAuction.startPrice).to.eq(startPrice)
        expect(await insuranceFund.isAuctionOngoing(avax.address)).to.eq(true)
    })

    it('buy an auction', async function() {
        // increase time by 1 hour
        let elapsedTime = 3600
        await network.provider.send('evm_setNextBlockTimestamp', [auctionTimestamp + elapsedTime]);
        // buy price = startPrice * (auctionDuration - elapsedTime) / auctionDuration
        let buyPrice = startPrice.mul(auctionDuration.sub(elapsedTime)).div(auctionDuration)
        const vusdAmount = buyPrice.mul(avaxMargin).div(1e6)

        // charlie buys auction
        await vusd.connect(charlie).approve(insuranceFund.address, vusdAmount)
        expect(await insuranceFund.getAuctionPrice(avax.address)).to.eq(buyPrice)

        await vusd.connect(admin).mint(charlie.address, vusdAmount)
        await expect(insuranceFund.connect(charlie).buyCollateralFromAuction(avax.address, avaxMargin.add(1))
        ).to.revertedWith('panic code 0x11 (Arithmetic operation underflowed or overflowed outside of an unchecked block)')

        let seizeAmount = avaxMargin.div(4)
        let tx = await insuranceFund.connect(charlie).buyCollateralFromAuction(avax.address, seizeAmount)
        let blockTime = BigNumber.from((await ethers.provider.getBlock(tx.blockNumber)).timestamp)
        buyPrice = await insuranceFund.getAuctionPrice(avax.address)
        let ifVusdBal = buyPrice.mul(seizeAmount).div(1e6)

        expect(buyPrice).to.eq(startPrice.sub(startPrice.mul(blockTime.sub(auctionTimestamp)).div(auctionDuration)))
        expect(await avax.balanceOf(insuranceFund.address)).to.eq(avaxMargin.sub(seizeAmount))
        expect(await vusd.balanceOf(insuranceFund.address)).to.eq(ifVusdBal)
        expect(await insuranceFund.isAuctionOngoing(avax.address)).to.eq(true)
        avaxMargin = avaxMargin.sub(seizeAmount)
        // increase time by 30 min
        await network.provider.send('evm_setNextBlockTimestamp', [ blockTime.add(1800).toNumber() ]);
    })

    it('deposit to IF during auction', async function() {
        deposit = _1e6.mul(500)
        await vusd.connect(admin).mint(alice, deposit)
        await vusd.approve(insuranceFund.address, deposit)

        // test when totalSupply is zero, governance gets all previously available vusd
        const ifVusdBal = await vusd.balanceOf(insuranceFund.address)
        await insuranceFund.deposit(deposit)
        expect(await insuranceFund.balanceOf(alice)).to.eq(deposit)
        expect(await vusd.balanceOf(insuranceFund.address)).to.eq(deposit)
        expect(await vusd.balanceOf(alice)).to.eq(ifVusdBal)
        expect(await insuranceFund.totalSupply()).to.eq(deposit)

        const poolSpotValue = deposit.add(avaxMargin.mul(oraclePrice).div(1e6))

        // test when totalSupply is non-zero
        await vusd.connect(admin).mint(bob.address, deposit)
        await vusd.connect(bob).approve(insuranceFund.address, deposit)

        await insuranceFund.connect(bob).deposit(deposit)

        const bobShares = deposit.mul(deposit).div(poolSpotValue) // amount * totalSupply / spotValue
        expect(await insuranceFund.balanceOf(bob.address)).to.eq(bobShares)
        expect(await vusd.balanceOf(insuranceFund.address)).to.eq(deposit.mul(2))
        expect(await insuranceFund.totalSupply()).to.eq(deposit.add(bobShares))
    })

    it('buying all collateral closes the auction', async function() {
        // charlie seizes rest of the assets
        expect(await insuranceFund.isAuctionOngoing(avax.address)).to.eq(true)
        let ifVusdBal = await vusd.balanceOf(insuranceFund.address)
        let tx = await insuranceFund.connect(charlie).buyCollateralFromAuction(avax.address, avaxMargin)
        let blockTime = BigNumber.from((await ethers.provider.getBlock(tx.blockNumber)).timestamp)
        let buyPrice = startPrice.sub(startPrice.mul(blockTime.sub(auctionTimestamp)).div(auctionDuration))
        ifVusdBal = ifVusdBal.add(buyPrice.mul(avaxMargin).div(1e6))

        expect(await avax.balanceOf(insuranceFund.address)).to.eq(ZERO)
        expect(await vusd.balanceOf(insuranceFund.address)).to.eq(ifVusdBal)
        expect(await insuranceFund.isAuctionOngoing(avax.address)).to.eq(false)
    })

    async function addMargin(trader, margin) {
        await usdc.mint(trader.address, margin)
        await usdc.connect(trader).approve(marginAccountHelper.address, margin)
        await marginAccountHelper.connect(trader).addVUSDMarginWithReserve(margin)
    }
})

describe('Partial Liquidation Threshold', async function() {
    beforeEach(async function() {
        signers = await ethers.getSigners()
        ;([ _, bob, liquidator1, liquidator2, liquidator3, admin ] = signers)
        alice = signers[0].address

        contracts = await setupContracts()
        ;({ registry, marginAccount, marginAccountHelper, clearingHouse, amm, vusd, weth, usdc, swap, hubbleViewer, oracle } = contracts)

        // add margin
        margin = _1e6.mul(2000)
        await addMargin(signers[0], margin)
    })

    it('short -> liquidation -> liquidation', async function() {
        // alice shorts
        const baseAssetQuantity = _1e18.mul(-5)
        await clearingHouse.openPosition(0, baseAssetQuantity, 0)

        let position = await amm.positions(alice)
        expect(position.liquidationThreshold).to.eq(baseAssetQuantity.mul(25).div(100).abs())

        // bob longs
        await addMargin(bob, _1e6.mul(40000))
        await oracle.setUnderlyingPrice(weth.address, _1e6.mul(1100))
        await clearingHouse.connect(bob).openPosition(0, _1e18.mul(130), ethers.constants.MaxUint256)

        // alice is in liquidation zone
        expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.false
        let tx = await clearingHouse.connect(liquidator1).liquidateTaker(alice)
        let liquidationEvent = (await filterEvent(tx, 'PositionLiquidated')).args

        const markPrice = await amm.lastPrice()
        await oracle.setUnderlyingPrice(weth.address, markPrice) // to make amm under spread limit
        // alice has 75% position left
        position = await amm.positions(alice)
        expect(position.size).to.eq(baseAssetQuantity.mul(75).div(100))
        expect(position.liquidationThreshold).to.eq(baseAssetQuantity.mul(25).div(100).abs())

        const liquidationPenalty = liquidationEvent.quoteAsset.mul(5e4).div(_1e6)
        const toInsurance = liquidationPenalty.div(2)
        expect(await vusd.balanceOf(liquidator1.address)).to.eq(liquidationPenalty.sub(toInsurance))

        // alice is still in liquidation zone
        expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.false
        await clearingHouse.connect(liquidator1).liquidateTaker(alice)
        // alice has 50% position left
        position = await amm.positions(alice)
        expect(position.size).to.eq(baseAssetQuantity.mul(50).div(100))
        expect(position.liquidationThreshold).to.eq(baseAssetQuantity.mul(25).div(100).abs())
        // alice is out of liquidation zone
        await expect(clearingHouse.connect(liquidator1).liquidateTaker(alice)).to.be.revertedWith(
            'CH: Above Maintenance Margin'
        )
    })

    it('long -> liquidation -> short', async function() {
        // alice longs
        let baseAssetLong = _1e18.mul(7)
        await clearingHouse.openPosition(0, baseAssetLong, ethers.constants.MaxUint256)

        let position = await amm.positions(alice)
        expect(position.liquidationThreshold).to.eq(baseAssetLong.mul(25).div(100))

        // bob shorts
        await addMargin(bob, _1e6.mul(40000))
        await oracle.setUnderlyingPrice(weth.address, _1e6.mul(900))
        await clearingHouse.connect(bob).openPosition(0, _1e18.mul(-140), 0)

        // alice is in liquidation zone
        expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.false
        let tx = await clearingHouse.connect(liquidator1).liquidateTaker(alice)
        let liquidationEvent = (await filterEvent(tx, 'PositionLiquidated')).args

        // alice has 75% position left
        position = await amm.positions(alice)
        expect(position.liquidationThreshold).to.eq(baseAssetLong.mul(25).div(100))
        baseAssetLong = baseAssetLong.mul(75).div(100)
        expect(position.size).to.eq(baseAssetLong)

        const liquidationPenalty = liquidationEvent.quoteAsset.mul(5e4).div(_1e6)
        const toInsurance = liquidationPenalty.div(2)
        expect(await vusd.balanceOf(liquidator1.address)).to.eq(liquidationPenalty.sub(toInsurance))

        // alice is still in liquidation zone
        expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.false
        await clearingHouse.connect(liquidator1).callStatic.liquidateTaker(alice) // doesn't throw exception

        // alice shorts
        const baseAssetShort = _1e18.mul(-2)
        await clearingHouse.openPosition(0, baseAssetShort, 0)

        // alice is out of liquidation zone
        expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.true
        await expect(clearingHouse.connect(liquidator1).liquidateTaker(alice)).to.be.revertedWith(
            'CH: Above Maintenance Margin'
        )

        // liquidation threshold updated
        position = await amm.positions(alice)
        expect(position.size).to.eq(baseAssetLong.add(baseAssetShort))
        expect(position.liquidationThreshold).to.eq(position.size.mul(25).div(100))
    })
})
