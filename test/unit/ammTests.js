const { expect } = require('chai');
const { constants: { _1e6, _1e12, _1e18, ZERO }, filterEvent, setupContracts, addMargin } = require('../utils')
const TRADE_FEE = 0.000567 * _1e6

describe('AMM Tests', function() {
    beforeEach('contract factories', async function() {
        signers = await ethers.getSigners()
        alice = signers[0].address
        mockAmm = signers[1]
        ;({ swap, amm, clearingHouse, hubbleViewer } = await setupContracts(TRADE_FEE))
        await swap.setAMM(mockAmm.address)
    })

    describe('VAMM Unit Tests', function() {
        it('check initial setup', async () => {
            expect(await amm.getSnapshotLen()).to.eq(1)
            expect((await amm.reserveSnapshots(0)).quoteAssetReserve).to.eq(_1e6.mul(_1e6))
            expect((await amm.reserveSnapshots(0)).baseAssetReserve).to.eq(_1e18.mul(1000))
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
                _1e18.mul(500)
            )).to.be.revertedWith('VAMM: contract is already initialized')
        })

        it('exchangeExactOut', async () => {
            const baseAssetQuantity = _1e18.mul(5)
            const amount = _1e6.mul(5025) // ~5x leverage
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
            const amount = _1e6.mul(5500) // ~5x leverage
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
            const amount = _1e6.mul(4950) // ~5x leverage
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
            await addMargin(signers[0], _1e6.mul(2e5))
            for (let i = 0; i < 10; i++) {
               await clearingHouse.addLiquidity(0, _1e18.mul(50), 0)
            }
            expect((await swap.price_scale({gasLimit: 100000})).div(_1e6)).to.eq(_1e12.mul(1000)) // little price movement to due fee accumulation
            expect(await swap.balances(0, {gasLimit: 100000})).to.eq(_1e6.mul(1500000))
            expect(await swap.balances(1, {gasLimit: 100000})).to.eq(_1e18.mul(1500))
        })
    })
})

describe('TWAP Price', function() {
    /*
        Test data
        quoteAssetBalance | baseAssetBalance | spot price (scaled by 6 demicals) | timestamp
        1010053427054307313321447 990000000000000000000 1020255986 1637924441
        1005032058729707709727446 995000000000000000000 1010082471 1637924455
        1000028529693144790497446 1000000000000000000000 1000028529 1637924483
        1010082076940516452696405 990000000000000000000 1020284926 1637924511
        1005060658056196985279396 995000000000000000000 1010111214 1637924525
        1000057077533931916820771 1000000000000000000000 1000057077 1637924553
        1010110745082215441315419 990000000000000000000 1020313883 1637924581
        1005089275604747011951309 995000000000000000000 1010139975 1637924595
        1000084081395588348180123 1000000000000000000000 1000084081 1637924623
        1010140725545006156756904 990000000000000000000 1020344167 1637924651
        1005117619163502837732109 995000000000000000000 1010168461 1637924665
        1000112373857536434204341 1000000000000000000000 1000112373 1637924693
        1010169137032252887651586 990000000000000000000 1020372865 1637924721
        1005145980609509432015311 995000000000000000000 1010196965 1637924735
        1000140684188538459419394 1000000000000000000000 1000140684 1637924763
        1010200439924510353734181 990000000000000000000 1020404484 1637924791
        1005175643637315883037223 995000000000000000000 1010226777 1637924805
        1000168734649604704043797 1000000000000000000000 1000168734 1637924833
        1010228608201806171493164 990000000000000000000 1020432937 1637924861
        1005203762390927267425973 995000000000000000000 1010255037 1637924875
        1000196802649143789309603 1000000000000000000000 1000196802 1637924903
        1010256794122000023747073 990000000000000000000 1020461408 1637924931
        1005231898756458958964489 995000000000000000000 1010283315 1637924945
        1000223332448828683087890 1000000000000000000000 1000223332 1637924973
        1010286319189500895458420 990000000000000000000 1020491231 1637925001
        1005259786777048596382171 995000000000000000000 1010311343 1637925015
        1000251170049914974449775 1000000000000000000000 1000251170 1637925043
        1010314273553693213213179 990000000000000000000 1020519468 1637925071
        1005287692073526114885135 995000000000000000000 1010339389 1637925085
        1000279024910132451563961 1000000000000000000000 1000279024 1637925113
    */

    before('generate sample snapshots', async function() {
        signers = await ethers.getSigners()
        alice = signers[0].address
        ;({ swap, amm } = await setupContracts(TRADE_FEE))
        // add margin
        margin = _1e6.mul(10000)
        await addMargin(signers[0], margin)

        baseAssetQuantity = _1e18.mul(5)

        // spot price after long ~ 1020
        // spot price after first short ~ 1010
        // spot price after second short ~ 1000
        let timestamp = (await amm.reserveSnapshots(0)).timestamp
        timestamp = timestamp.add(14)
        await increaseEvmTime(timestamp.toNumber())
        for (let i = 0; i < 30; i++) {
            if (i % 3 == 0) {
                await clearingHouse.openPosition(0, baseAssetQuantity.mul(2), ethers.constants.MaxUint256)
                timestamp = timestamp.add(14)
                await increaseEvmTime(timestamp.toNumber())
            } else {
                await clearingHouse.openPosition(0, baseAssetQuantity.mul(-1), ZERO)
                timestamp = timestamp.add(28)
                await increaseEvmTime(timestamp.toNumber())
            }
        }
    })

    it('get TWAP price', async () => {
        // latest spot price is not considered in the calcualtion as delta t is 0
        // total snapshots in 420 seconds = 18
        // ((1010196965+ 1010226777+ 1010255037+ 1010283315+ 1010311343+ 1010339389)*28 + (1020372865+1020404484+1020432937+1020461408+1020491231+1020519468)*14 + (1000112373+1000140684+1000168734+1000196802+1000223332+1000251170)*28)/420 = 1008269807

        const twap = await amm.getTwapPrice(420)
        expect(parseInt(twap.toNumber() / 1e6)).to.eq(1008)
    })

    it('the timestamp of latest snapshot is now, the latest snapshot wont have any effect', async () => {
        // price is 990 but time weighted is zero
        await clearingHouse.openPosition(0, baseAssetQuantity.mul(-1), ZERO)

        // Shaving off 20 secs from the 420s window would mean dropping the first 1020 snapshot and 6 secs off the 1010 reading.
        // twap = (1020 * 5 snapshots * 14 sec + 1010 * 22 sec + 1010*5*28 +  + 1000*6*28)/400 = 1007
        const twap = await amm.getTwapPrice(400)
        expect(parseInt(twap.toNumber() / 1e6)).to.eq(1007)
    })

    it('asking interval more than the snapshots', async () => {
        // total 32 snapshots, out of which latest doesn't count
        // twap = (1020 * 10 snapshots * 14 sec + 1010*10*28 + 1000*10*28 + 1000*14)/714 ~ 1008

        const twap = await amm.getTwapPrice(900)
        expect(parseInt(twap.toNumber() / 1e6)).to.eq(1008)
    })

    it('asking interval less than latest snapshot, return latest price directly', async () => {
        // price is 990
        await increaseEvmTime(Date.now() + 500)
        await clearingHouse.openPosition(0, baseAssetQuantity.mul(-1), ZERO) // add a delay of 500 seconds

        const twap = await amm.getTwapPrice(420)
        expect(parseInt(twap.toNumber() / 1e6)).to.eq(990)
    })

    it('price with interval 0 should be the same as spot price', async () => {
        expect(await amm.getTwapPrice(0)).to.eq(await amm.getSpotPrice())
    })
})

async function increaseEvmTime(timeInSeconds) {
    await network.provider.send('evm_setNextBlockTimestamp', [timeInSeconds]);
}
