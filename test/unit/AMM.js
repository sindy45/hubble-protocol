const { expect } = require('chai');

const utils = require('../utils')
const {
    constants: { _1e6, _1e12, _1e18, ZERO },
    filterEvent,
    setupContracts,
    addMargin,
    commitLiquidity,
    gotoNextWithdrawEpoch,
    gotoNextUnbondEpoch
} = utils

const TRADE_FEE = 0.000567 * _1e6

describe('AMM unit Tests', function() {
    beforeEach('contract factories', async function() {
        signers = await ethers.getSigners()
        alice = signers[0].address
        mockAmm = signers[1]
        ;({ swap, amm, clearingHouse, hubbleViewer } = await setupContracts({ tradeFee: TRADE_FEE }))
        await swap.setAMM(mockAmm.address)
    })

    describe('VAMM Unit Tests', function() {
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
            const dx1 = transactionEvent.args[2];
            const vammFee = transactionEvent.args[5];

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
                dx1 = dx1.add(transactionEvent.args[2]);
                vammFee = vammFee.add(transactionEvent.args[5]);
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
            const dy1 = transactionEvent.args[4];
            const vammFee = transactionEvent.args[5];

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

describe('AMM states', async function() {
    before(async function() {
        signers = await ethers.getSigners()
        ;([ alice ] = signers.map(s => s.address))

        contracts = await setupContracts({ amm: { initialLiquidity: 0, ammState: 0 }})
        ;({ registry, marginAccount, marginAccountHelper, clearingHouse, amm, vusd, weth, usdc, swap, hubbleViewer } = contracts)

        // add margin
        margin = _1e6.mul(2000)
        await addMargin(signers[0], margin)
    })

    it('[commit,unbond]Liquidity/openPosition fails when ammState=InActive', async () => {
        await expect(
            commitLiquidity(0, 1000, 1000)
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
    })

    it('commitLiquidity works when ammState=Ignition', async () => {
        await clearingHouse.connect(maker).commitLiquidity(0, _1e6.mul(_1e6).mul(2)) // 2 mil
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
    })

    it('[add,unbond]Liquidity/openPosition works when ammState=Active', async () => {
        await clearingHouse.connect(maker).addLiquidity(0, _1e18, 0)

        await clearingHouse.openPosition(0, -10000, 0)

        dToken = (await amm.makers(maker.address)).dToken
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
            [ registry.address, avax.address, 'AVAX-PERP' ],
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
        await expect(
            clearingHouse.connect(maker).removeLiquidity(0, dToken.add(1), 0, 0)
        ).to.be.revertedWith('Arithmetic operation underflowed or overflowed outside of an unchecked block')
        await clearingHouse.connect(maker).removeLiquidity(0, dToken.sub(1), 0, 0)
        expect((await amm.makers(maker.address)).dToken).to.eq(1)

        await gotoNextWithdrawEpoch(amm, maker.address)
        await expect(
            clearingHouse.connect(maker).removeLiquidity(0, 1, 0, 0)
        ).to.be.revertedWith('withdraw_period_over')
        expect((await amm.makers(maker.address)).dToken).to.eq(1)
    })

    it('can unbond again and then withdraw', async () => {
        await amm.connect(maker).unbondLiquidity(1)
        await gotoNextUnbondEpoch(amm, maker.address)
        await clearingHouse.connect(maker).removeLiquidity(0, 1, 0, 0)
        expect((await amm.makers(maker.address)).dToken).to.eq(0)
    })

    async function ops() {
        return Promise.all([
            clearingHouse.settleFunding(),
            clearingHouse.updatePositions(alice),
            clearingHouse.openPosition(0, -10000, 0)
        ])
    }
})

async function increaseEvmTime(timeInSeconds) {
    await network.provider.send('evm_setNextBlockTimestamp', [timeInSeconds]);
}
