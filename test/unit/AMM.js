const { expect } = require('chai');

const utils = require('../utils')
const {
    constants: { _1e6, _1e12, _1e18, ZERO },
    filterEvent,
    setupContracts,
    addMargin,
    gotoNextWithdrawEpoch,
    setupRestrictedTestToken,
    gotoNextUnbondEpoch
} = utils

const TRADE_FEE = 0.000567 * _1e6

describe('vAMM unit Tests', function() {
    beforeEach('contract factories', async function() {
        signers = await ethers.getSigners()
        alice = signers[0].address
        mockAmm = signers[1]
        ;({ swap, amm, clearingHouse, hubbleViewer } = await setupContracts({ tradeFee: TRADE_FEE }))
        await swap.setAMM(mockAmm.address)
    })

    describe('exchange[ExactOut]', function() {
        it('check initial setup', async () => {
            expect(await amm.getSnapshotLen()).to.eq(0)
            await expect(swap.initialize(
                alice, // owner
                alice, // math
                alice, // views
                54000, // A
                '3500000000000000', // gamma
                11000000, 0, 0, 0, // mid_fee = 0.11%, out_fee, allowed_extra_profit, fee_gamma
                '490000000000000', // adjustment_step
                0, // admin_fee
                600, // ma_half_time
            )).to.be.revertedWith('VAMM: contract is already initialized')
        })

        it('exchangeExactOut', async () => {
            const baseAssetQuantity = _1e18.mul(5)
            const amount = _1e6.mul(5025)
            const initialUSDTBalance = await swap.balances(0, {gasLimit: 100000});
            const initialETHBalance = await swap.balances(1, {gasLimit: 100000});

            await expect(swap.exchangeExactOut(0, 1, baseAssetQuantity, amount)).to.be.revertedWith('VAMM: OnlyAMM')
            const tx = await swap.connect(mockAmm).exchangeExactOut(0, 1, baseAssetQuantity, amount)
            transactionEvent = await filterEvent(tx, 'TokenExchange')
            const dx1 = transactionEvent.args[1];
            const vammFee = transactionEvent.args[4];

            const dx2 = await swap.get_dy(1, 0, baseAssetQuantity, {gasLimit: 100000})
            const fee = await swap.get_dy_fee(1, 0, baseAssetQuantity, {gasLimit: 100000})
            const finalUSDTBalance = await swap.balances(0, {gasLimit: 100000})

            expect(dx2).lt(dx1) // amount received less than deposited, loss to trader because of fee, profit to maker
            expect(dx2.add(fee)).gt(dx1.sub(vammFee)) // little more vUSD in the pool because of fee, hence the received amount without fee be a little more than deposited amount-fee
            expect((finalUSDTBalance.sub(initialUSDTBalance)).lte(amount)).to.be.true
            expect(initialETHBalance.sub((await swap.balances(1, {gasLimit: 100000})))).to.eq(baseAssetQuantity)
        })

        it('exchangeExactOut multiple transactions', async () => {
            const baseAssetQuantity = _1e18.mul(5)
            const amount = _1e6.mul(5500)
            const initialUSDTBalance = await swap.balances(0, {gasLimit: 100000});
            const initialETHBalance = await swap.balances(1, {gasLimit: 100000});

            const numberOfTransactions = 10
            let dx1 = ZERO
            let vammFee = ZERO
            for (let i = 0; i < numberOfTransactions; i++) {
                let tx = await swap.connect(mockAmm).exchangeExactOut(0, 1, baseAssetQuantity, amount)
                let transactionEvent = await filterEvent(tx, 'TokenExchange')
                dx1 = dx1.add(transactionEvent.args[1]);
                vammFee = vammFee.add(transactionEvent.args[4]);
            }

            const dx2 = await swap.get_dy(1, 0, baseAssetQuantity.mul(numberOfTransactions), {gasLimit: 100000})
            const fee = await swap.get_dy_fee(1, 0, baseAssetQuantity.mul(numberOfTransactions), {gasLimit: 100000})
            const finalUSDTBalance = await swap.balances(0, {gasLimit: 100000})

            expect(dx2).lt(dx1) // amount received less than deposited, loss to trader because of fee, profit to maker
            expect(dx2.add(fee)).gt(dx1.sub(vammFee)) // little more vUSD in the pool because of fee, hence the received amount without fee be a little more than deposited amount-fee
            expect((finalUSDTBalance.sub(initialUSDTBalance)).lte(amount.mul(numberOfTransactions))).to.be.true
            expect(initialETHBalance.sub((await swap.balances(1, {gasLimit: 100000})))).to.eq(baseAssetQuantity.mul(numberOfTransactions))
        })

        it('exchange', async () => {
            const baseAssetQuantity = _1e18.mul(5)
            const amount = _1e6.mul(4950)
            const initialUSDTBalance = await swap.balances(0, {gasLimit: 100000});
            const initialETHBalance = await swap.balances(1,{gasLimit: 100000});

            await expect(swap.exchange(1, 0, baseAssetQuantity, amount)).to.be.revertedWith('VAMM: OnlyAMM')
            let tx = await swap.connect(mockAmm).exchange(1, 0, baseAssetQuantity, amount)
            transactionEvent = await filterEvent(tx, 'TokenExchange')
            const dy1 = transactionEvent.args[3];
            const vammFee = transactionEvent.args[4];

            const dy2 = await swap.get_dx(0, 1, baseAssetQuantity, {gasLimit: 100000})
            const fee = await swap.get_dx_fee(0, 1, baseAssetQuantity, {gasLimit: 100000})

            expect(dy2).gt(dy1) // amount to deposit greater than received, loss to trader, profit to maker
            expect(dy2.sub(fee)).gt(dy1.add(vammFee)) // higher amount because of fee accumulation
            expect((initialUSDTBalance.sub((await swap.balances(0, {gasLimit: 100000})))).gte(amount)).to.be.true
            expect((await swap.balances(1, {gasLimit: 100000})).sub(initialETHBalance)).to.eq(baseAssetQuantity)
        })

        it('exchange multiple transactions', async () => {
            const baseAssetQuantity = _1e18.mul(5)
            const initialUSDTBalance = await swap.balances(0, {gasLimit: 100000});
            const initialETHBalance = await swap.balances(1, {gasLimit: 100000});

            const numberOfTransactions = 10
            let dy1 = ZERO
            let vammFee = ZERO
            let amount
            for (let i = 0; i < numberOfTransactions; i++) {
                amount = await hubbleViewer.getQuote(baseAssetQuantity.mul(-1), 0)
                let tx = await swap.connect(mockAmm).exchange(1, 0, baseAssetQuantity, amount)
                let transactionEvent = await filterEvent(tx, 'TokenExchange')
                dy1 = dy1.add(transactionEvent.args[4]);
                vammFee = vammFee.add(transactionEvent.args[5]);
            }

            const dy2 = await swap.get_dx(0, 1, baseAssetQuantity.mul(numberOfTransactions), {gasLimit: 100000})

            expect(dy2).gt(dy1) // amount to deposit greater than received, loss to trader, profit to maker
            expect((initialUSDTBalance.sub((await swap.balances(0, {gasLimit: 100000})))).gte(amount.mul(numberOfTransactions))).to.be.true
            expect((await swap.balances(1, {gasLimit: 100000})).sub(initialETHBalance)).to.eq(baseAssetQuantity.mul(numberOfTransactions))
        })
    })

    describe('Repegging Check', async function() {
        it('inital setup', async function() {
            expect(await swap.price_scale({gasLimit: 100000})).to.eq(_1e18.mul(1000)) // internal prices
            expect(await swap.price_oracle({gasLimit: 100000})).to.eq(_1e18.mul(1000)) // EMA
            expect(await swap.balances(0, {gasLimit: 100000})).to.eq(_1e6.mul(_1e6))
            expect(await swap.balances(1, {gasLimit: 100000})).to.eq(_1e18.mul(1000))
        })

        it('move pegged price up', async function() {
            for (let i = 0; i < 10; i++) {
                await swap.connect(mockAmm).exchangeExactOut(0, 1, _1e18.mul(15), ethers.constants.MaxUint256)
            }

            expect(await swap.price_scale({gasLimit: 100000})).to.gt(_1e18.mul(1000))
            expect(await swap.price_oracle({gasLimit: 100000})).to.gt(_1e18.mul(1000))
        })

        it('pegged price should not move much while adding liquidity in the ratio of price', async function() {
            await swap.setAMM(amm.address)
            // add a total of 500K usd and ~500 eth to the pool
            await addMargin(signers[0], _1e6.mul(4e5))
            for (let i = 0; i < 10; i++) {
               await clearingHouse.addLiquidity(0, _1e18.mul(50), 0)
            }
            expect((await swap.price_scale({gasLimit: 100000})).div(_1e6)).to.eq(_1e12.mul(1000)) // little price movement to due fee accumulation
            expect(await swap.balances(0, {gasLimit: 100000})).to.eq(_1e6.mul(1500000))
            expect(await swap.balances(1, {gasLimit: 100000})).to.eq(_1e18.mul(1500))
        })
    })
})

describe('Twap Price Tests', function() {
    /*
        Test data
        spot price (scaled by 6 demicals) | timestamp
        1002151330 1645010600
        1000985181 1645010560739
        999515051 1645010560767
        1002487284 1645010560795
        1001398222 1645010560809
        999978228 1645010560837
        1002868390 1645010560865
        1001725466 1645010560879
        1000386352 1645010560907
        1003238539 1645010560935
        1002057404 1645010560949
        1000795971 1645010560977
        1003612087 1645010561005
        1002394631 1645010561019
        1001070244 1645010561047
        1003739258 1645010561075
        1002399371 1645010561089
        1001071546 1645010561117
        1003742288 1645010561145
        1002404121 1645010561159
        1001072851 1645010561187
        1003745325 1645010561215
        1002408884 1645010561229
        1001074159 1645010561257
        1003748370 1645010561285
        1002413657 1645010561299
        1001075469 1645010561327
        1003751421 1645010561355
        1002418442 1645010561369
        1001076782 1645010561397
    */

    before('generate sample snapshots', async function() {
        signers = await ethers.getSigners()
        alice = signers[0].address
        ;({ swap, amm } = await setupContracts({ tradeFee: TRADE_FEE }))
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
                await clearingHouse.openPosition(0, baseAssetQuantity.mul(2), ethers.constants.MaxUint256)
                timestamp += 14
                await increaseEvmTime(timestamp)
            } else {
                await clearingHouse.openPosition(0, baseAssetQuantity.mul(-1), ZERO)
                timestamp += 28
                await increaseEvmTime(timestamp)
            }
        }
    })

    it('get TWAP price', async () => {
        // latest spot price is not considered in the calcualtion as delta t is 0
        // total snapshots in 420 seconds = 18
        // (
        //  (1003612087+1003739258+1003742288+1003745325+1003748370+1003751421)*14 +
        //  (1000795971+1002394631+1001070244+1002399371+1001071546+1002404121+1001072851+1002408884+1001074159+1002413657+1001075469+1002418442)*28
        // )/420 = 1002.13

        const twap = await amm.getTwapPrice(420)
        expect((twap.toNumber() / 1e6).toFixed(2)).to.eq('1002.12')
    })

    it('the timestamp of latest snapshot=now, the latest snapshot wont have any effect', async () => {
        await clearingHouse.openPosition(0, baseAssetQuantity.mul(-1), ZERO)

        // Shaving off 20 secs from the 420s window would mean dropping the first 1003 snapshot and 6 secs off the 1002 reading.
        // twap = (1003 * 5 snapshots * 14 sec + 1002 * 22 sec + 1002*5*28 + 1001*6*28)/400 = 1002.x
        const twap = await amm.getTwapPrice(400)
        expect((twap.toNumber() / 1e6).toFixed(2)).to.eq('1002.08')
    })

    it('asking interval more than the snapshots', async () => {
        // total 31 snapshots, out of which latest doesn't count
        // twap = (1003 * 10 snapshots * 14 sec + 1002*10*28 + 1001*10*28)/700 ~ 1001.x

        const twap = await amm.getTwapPrice(900)
        expect((twap.toNumber() / 1e6).toFixed(2)).to.eq('1001.86')
    })

    it('asking interval less than latest snapshot, return latest price directly', async () => {
        // price is 1000.4
        await increaseEvmTime(Date.now() + 500)
        await clearingHouse.openPosition(0, baseAssetQuantity.mul(-1), ZERO) // add a delay of 500 seconds

        const twap = await amm.getTwapPrice(420)
        expect((twap.toNumber() / 1e6).toFixed(2)).to.eq('1000.42')
    })

    it('price with interval 0 should be the same as spot price', async () => {
        expect(await amm.getTwapPrice(0)).to.eq(await amm.lastPrice())
    })
})

describe('AMM unit tests', async function() {
    before(async function() {
        signers = await ethers.getSigners()
        ;([ alice ] = signers.map(s => s.address))
        maker = signers[9]

        contracts = await setupContracts({ amm: { initialLiquidity: 0, ammState: 0 }})
        ;({ registry, marginAccount, marginAccountHelper, clearingHouse, amm, vusd, weth, usdc, swap, hubbleViewer } = contracts)

        // add margin
        margin = _1e6.mul(2000)
        await addMargin(signers[0], margin)
    })

    it('[commit,unbond]Liquidity/openPosition fails when ammState=InActive', async () => {
        await expect(
            clearingHouse.commitLiquidity(0, 1)
        ).to.be.revertedWith('Array accessed at an out-of-bounds or negative index')

        // CH doesn't know about the AMM yet
        await expect(
            clearingHouse.openPosition(0, -1, 0)
        ).to.be.revertedWith('Array accessed at an out-of-bounds or negative index')

        await expect(
            amm.unbondLiquidity(1)
        ).to.be.revertedWith('amm_not_active')
    })

    it('set ammState to Ignition', async () => {
        expect(await clearingHouse.getAmmsLength()).to.eq(0)
        let markets = await hubbleViewer.markets()
        expect(markets.length).to.eq(0)

        await clearingHouse.whitelistAmm(amm.address)

        expect(await clearingHouse.getAmmsLength()).to.eq(1)
        markets = await hubbleViewer.markets()
        expect(markets.length).to.eq(1)
        expect(markets[0].amm).to.eq(amm.address)
        expect(markets[0].underlying).to.eq(weth.address)
        expect(await amm.ammState()).to.eq(1)
    })

    it('commitLiquidity works when ammState=Ignition', async () => {
        const initialLiquidity = 1000 // eth
        const rate = 1000 // $1k
        vUSD = _1e6.mul(initialLiquidity * rate)
        await utils.addMargin(maker, vUSD)
        const { expectedMarginFraction } = await hubbleViewer.getMakerExpectedMFAndLiquidationPrice(maker.address, 0, vUSD, false)
        expect(expectedMarginFraction).to.eq('500000')
        await clearingHouse.connect(maker).commitLiquidity(0, vUSD.mul(2))
    })

    it('ignition liquidity is honored when ammState=Ignition', async () => {
        const ml = await hubbleViewer.getMakerLiquidity(maker.address, 0)
        // console.log(await hubbleViewer.getMakerPositionAndUnrealizedPnl(maker.address, 0))
        expect(ml.vUSD).to.eq(vUSD.mul(2))
        expect(ml.totalDeposited).to.eq(vUSD.mul(2))
    })

    it('openPosition,unbondLiquidity fails when ammState=Ignition', async () => {
        await expect(
            clearingHouse.openPosition(0, -1, 0)
        ).to.be.revertedWith('amm_not_active')

        await expect(
            amm.unbondLiquidity(1)
        ).to.be.revertedWith('amm_not_active')
    })

    it('set ammState=Active', async () => {
        await amm.liftOff()
        expect(await amm.ammState()).to.eq(2)
    })

    it('ignition liquidity is honored when ammState=Active', async () => {
        expect((await hubbleViewer.getMakerLiquidity(maker.address, 0)).dToken.gt(0)).to.be.true
        const { notionalPosition, unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(maker.address)
        expect(notionalPosition).to.eq(vUSD.mul(2))
        expect(unrealizedPnl).to.eq(ZERO)
    })

    it('[add,unbond]Liquidity/openPosition work when ammState=Active', async () => {
        await clearingHouse.connect(maker).addLiquidity(0, _1e18, 0)

        await clearingHouse.openPosition(0, _1e18.mul(-1), 0)

        dToken = (await amm.makers(maker.address)).dToken
        await expect(
            amm.unbondLiquidity(0)
        ).to.be.revertedWith('unbonding_0')
        await expect(
            amm.unbondLiquidity(dToken.add(1))
        ).to.be.revertedWith('unbonding_too_much')

        await amm.connect(maker).unbondLiquidity(dToken)
        expect((await amm.makers(maker.address)).unbondAmount).to.eq(dToken)
    })

    it('add 2nd amm', async () => {
        avax = await utils.setupRestrictedTestToken('avax', 'avax', 6)
        ;({ amm: avaxAmm } = await utils.setupAmm(
            alice,
            [ 'AVAX-PERP', avax.address, oracle.address, 100 /* min size = 100 wei */ ],
            {
                initialRate: 65,
                initialLiquidity: 0,
                ammState: 0 // Inactive
            }
        ))
        // assert that AMM hasn't been whitelisted as yet
        expect(await clearingHouse.getAmmsLength()).to.eq(1)
    })

    it('other amms will work as usual when 1 amm is inactive', async () => {
        await oracle.setUnderlyingTwapPrice(weth.address, _1e6.mul(900))
        await utils.gotoNextFundingTime(amm)

        await ops()

        expect((await amm.cumulativePremiumFraction()).gt(0)).to.be.true
        expect(await avaxAmm.cumulativePremiumFraction()).to.eq(0)
    })

    it('other amms will work as usual when 1 amm is in ignition', async () => {
        await clearingHouse.whitelistAmm(avaxAmm.address)

        expect(await clearingHouse.getAmmsLength()).to.eq(2)
        const markets = await hubbleViewer.markets()
        expect(markets.length).to.eq(2)
        expect(markets[0].amm).to.eq(amm.address)
        expect(markets[0].underlying).to.eq(weth.address)
        expect(markets[1].amm).to.eq(avaxAmm.address)
        expect(markets[1].underlying).to.eq(avax.address)

        await utils.gotoNextFundingTime(amm)
        await ops()
    })

    it('other amms will work as usual when last amm is made active', async () => {
        await avaxAmm.liftOff()
        await utils.gotoNextFundingTime(avaxAmm)

        // reverts because reserveSnapshots.length == 0
        await expect(
            clearingHouse.settleFunding()
        ).to.reverted
        await utils.addLiquidity(1, 1e4, 65)

        // opening small positions will fail
        await expect(
            clearingHouse.openPosition(0, -99, 0)
        ).to.be.revertedWith('trading_too_less')
        await expect(
            clearingHouse.openPosition(0, 99, 0)
        ).to.be.revertedWith('trading_too_less')
        await expect(
            clearingHouse.addLiquidity(1, 99, 0)
        ).to.be.revertedWith('adding_too_less')
        await clearingHouse.openPosition(1, -10000, 0)

        await ops()
    })

    // this test has been deliberately placed at the end because it moves the times forward by quite a lot
    // which messes with other time sensitive tests
    it('can only removeLiquidity after unbond and during withdrawal', async () => {
        await expect(
            clearingHouse.connect(maker).removeLiquidity(0, dToken, 0, 0)
        ).to.be.revertedWith('still_unbonding')

        await gotoNextUnbondEpoch(amm, maker.address)

        // assert the fail scenarios
        await expect(
            clearingHouse.connect(maker).removeLiquidity(0, dToken.add(1), 0, 0)
        ).to.be.revertedWith('withdrawing_more_than_unbonded')
        await expect(
            clearingHouse.connect(maker).removeLiquidity(0, 0, 0, 0)
        ).to.be.revertedWith('liquidity_being_removed_should_be_non_0')
        await expect(
            clearingHouse.connect(maker).removeLiquidity(0, dToken.sub(1), 0, 0)
        ).to.be.revertedWith('leftover_liquidity_is_too_less')
        await expect(
            clearingHouse.connect(maker).removeLiquidity(0, 1, 0, 0)
        ).to.be.revertedWith('removing_very_small_liquidity')

        const remove = dToken.div(2) // removing 1/2 to avoid leftover_liquidity_is_too_less
        leftOver = dToken.sub(remove)
        await clearingHouse.connect(maker).removeLiquidity(0, remove, 0, 0)
        expect((await amm.makers(maker.address)).dToken).to.eq(leftOver)

        await gotoNextWithdrawEpoch(amm, maker.address)
        await expect(
            clearingHouse.connect(maker).removeLiquidity(0, 1, 0, 0)
        ).to.be.revertedWith('withdraw_period_over')
    })

    it('can unbond again and then withdraw', async () => {
        await amm.connect(maker).unbondLiquidity(leftOver)
        await gotoNextUnbondEpoch(amm, maker.address)
        await clearingHouse.connect(maker).removeLiquidity(0, leftOver, 0, 0)
        expect((await amm.makers(maker.address)).dToken).to.eq(0)
    })

    async function ops() {
        return Promise.all([
            clearingHouse.settleFunding(),
            clearingHouse.updatePositions(alice),
            clearingHouse.openPosition(0, _1e18.mul(-1), 0)
        ])
    }
})

describe('Price Spread Check', async function() {
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
    })

    it('only longs allowed when markPrice is below price spread', async function() {
        // markPrice = 1000, indexPrice = 1000/0.8 = 1250
        await oracle.setUnderlyingPrice(weth.address, _1e6.mul(1250))
        expect(await amm.isOverSpreadLimit()).to.be.true
        await expect(
            clearingHouse.openPosition(0, _1e18.mul(-5), 0)
        ).to.be.revertedWith('VAMM._short: shorts not allowed')

        // longs allowed
        await clearingHouse.openPosition(0, _1e18.mul(5), ethers.constants.MaxUint256)
    })

    it('only shorts allowed when markPrice is above price spread', async function() {
        // markPrice = 1000, indexPrice = 1000/1.2 = 833
        await oracle.setUnderlyingPrice(weth.address, _1e6.mul(833))
        expect(await amm.isOverSpreadLimit()).to.be.true
        await expect(
            clearingHouse.openPosition(0, _1e18.mul(5), ethers.constants.MaxUint256)
        ).to.be.revertedWith('VAMM._long: longs not allowed')

        // shorts allowed
        await clearingHouse.openPosition(0, _1e18.mul(-5), 0)
    })

    // marginFraction < maintenanceMargin < minAllowableMargin < oracleBasedMF
    it('amm isOverSpreadLimit on long side', async function() {
        expect(await amm.isOverSpreadLimit()).to.be.false
        await clearingHouse.openPosition(0, _1e18.mul(-5), 0)

        // bob makes counter-trade to drastically reduce amm based marginFraction
        avaxMargin = _1e6.mul(2000)
        await Promise.all([
            avax.mint(bob.address, avaxMargin),
            avax.connect(bob).approve(marginAccount.address, avaxMargin),
        ])
        await marginAccount.connect(bob).addMargin(1, avaxMargin)
        await clearingHouse.connect(bob).openPosition(0, _1e18.mul(120), ethers.constants.MaxUint256)

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
            clearingHouse.liquidate(alice)
        ).to.be.revertedWith('CH: Above Maintenance Margin')

        // Finally, trader will be liquidable once both MFs are < maintenanceMargin
        await oracle.setUnderlyingPrice(weth.address, _1e6.mul(1500))
        ;({ marginFraction: oracleBasedMF } = await amm.getOracleBasedMarginFraction(alice, margin))
        expect(oracleBasedMF.lt(maintenanceMargin)).to.be.true
        await clearingHouse.liquidate(alice)
    })

    // we will assert that oracle based pricing kicks in when lastPrice = ~998, indexPrice = 1300
    // oracleBasedMF < maintenanceMargin < minAllowableMargin < marginFraction
    it('amm isOverSpreadLimit on short side', async function() {
        expect(await amm.isOverSpreadLimit()).to.be.false
        await clearingHouse.openPosition(0, _1e18.mul(-5), 0)

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
        await clearingHouse.callStatic.closePosition(0, ethers.constants.MaxUint256)

        // However, when it comes to liquidation, amm based marginFraction will kick in again
        expect(await clearingHouse.calcMarginFraction(alice, false, 0 /* Maintenance_Margin */)).to.eq(marginFraction)
        await expect(
            clearingHouse.liquidate(alice)
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

        await clearingHouse.liquidate(alice)
    })
})

async function increaseEvmTime(timeInSeconds) {
    await network.provider.send('evm_setNextBlockTimestamp', [timeInSeconds]);
}
