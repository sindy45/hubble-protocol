const { expect } = require('chai');
const { constants: { _1e6, _1e12, _1e18, ZERO }, filterEvent, setupContracts } = require('../utils')
const TRADE_FEE = 0.000567 * _1e6

describe('AMM Unit Tests', function() {
    beforeEach('contract factories', async function() {
        signers = await ethers.getSigners()
        alice = signers[0].address
        ;({ swap, amm } = await setupContracts(TRADE_FEE))
    })

    it('check initial setup', async () => {
        expect(await amm.getSnapshotLen()).to.eq(1)
        expect((await amm.reserveSnapshots(0)).quoteAssetReserve).to.eq(_1e18.mul(_1e6))
        expect((await amm.reserveSnapshots(0)).baseAssetReserve).to.eq(_1e18.mul(1000))
    })

    it('exchangeExactOut', async () => {
        const baseAssetQuantity = _1e18.mul(5)
        const amount = _1e18.mul(5025) // ~5x leverage
        const initialUSDTBalance = await swap.balances(0);
        const initialETHBalance = await swap.balances(2);

        const tx = await swap.exchangeExactOut(0, 2, baseAssetQuantity, amount)
        transactionEvent = await filterEvent(tx, 'TokenExchange')
        const dx1 = transactionEvent.args[2];

        const dx2 = await swap.get_dy(2, 0, baseAssetQuantity, {gasLimit: 100000})
        const finalUSDTBalance = await swap.balances(0)
        const latestSnapshot = await amm.reserveSnapshots(1)
        // expect(dx1).to.eq(dx2) not exactly equal in wei as newton's methon may converge to a slightly different equilibrium point
        expect(dx1.div(_1e12)).to.eq(dx2.div(_1e12))
        expect((finalUSDTBalance.sub(initialUSDTBalance)).lte(amount)).to.be.true
        expect(initialETHBalance.sub((await swap.balances(2)))).to.eq(baseAssetQuantity)
        expect(await amm.getSnapshotLen()).to.eq(2)
        expect(latestSnapshot.quoteAssetReserve).to.eq(finalUSDTBalance)
        expect(latestSnapshot.baseAssetReserve).to.eq(initialETHBalance.sub(baseAssetQuantity))
    })

    it('exchangeExactOut multiple transactions', async () => {
        const baseAssetQuantity = _1e18.mul(5)
        const amount = _1e18.mul(5300) // ~5x leverage
        const initialUSDTBalance = await swap.balances(0);
        const initialETHBalance = await swap.balances(2);

        const numberOfTransactions = 10
        var dx1 = ZERO
        for (let i = 0; i < numberOfTransactions; i++) {
            let tx = await swap.exchangeExactOut(0, 2, baseAssetQuantity, amount)
            let transactionEvent = await filterEvent(tx, 'TokenExchange')
            dx1 = dx1.add(transactionEvent.args[2]);
        }

        const dx2 = await swap.get_dy(2, 0, baseAssetQuantity.mul(numberOfTransactions), {gasLimit: 100000})
        const finalUSDTBalance = await swap.balances(0)
        const latestSnapshot = await amm.reserveSnapshots(numberOfTransactions) // total snapshots = numberOfTransactions + 1 (add_liquidity)
        expect(dx1.div(_1e12)).to.eq(dx2.div(_1e12))
        expect((finalUSDTBalance.sub(initialUSDTBalance)).lte(amount.mul(numberOfTransactions))).to.be.true
        expect(initialETHBalance.sub((await swap.balances(2)))).to.eq(baseAssetQuantity.mul(numberOfTransactions))
        expect(await amm.getSnapshotLen()).to.eq(numberOfTransactions+1)
        expect(latestSnapshot.quoteAssetReserve).to.eq(finalUSDTBalance)
        expect(latestSnapshot.baseAssetReserve).to.eq(initialETHBalance.sub(baseAssetQuantity.mul(numberOfTransactions)))
    })

    it('exchange', async () => {
        const baseAssetQuantity = _1e18.mul(5)
        const amount = _1e18.mul(4950) // ~5x leverage
        const initialUSDTBalance = await swap.balances(0);
        const initialETHBalance = await swap.balances(2);

        let tx = await swap.exchange(2, 0, baseAssetQuantity, amount)
        transactionEvent = await filterEvent(tx, 'TokenExchange')
        const dy1 = transactionEvent.args[4];

        const dy2 = await swap.get_dx(0, 2, baseAssetQuantity, {gasLimit: 100000})
        const latestSnapshot = await amm.reserveSnapshots(1)
        expect(dy1.div(_1e12)).to.eq(dy2.div(_1e12))
        expect((initialUSDTBalance.sub((await swap.balances(0)))).gte(amount)).to.be.true
        expect((await swap.balances(2)).sub(initialETHBalance)).to.eq(baseAssetQuantity)
        expect(await amm.getSnapshotLen()).to.eq(2)
        expect(latestSnapshot.quoteAssetReserve).to.eq(initialUSDTBalance.sub(dy1))
        expect(latestSnapshot.baseAssetReserve).to.eq(initialETHBalance.add(baseAssetQuantity))
    })

    it('exchange multiple transactions', async () => {
        const baseAssetQuantity = _1e18.mul(5)
        const amount = _1e18.mul(4700) // ~5x leverage
        const initialUSDTBalance = await swap.balances(0);
        const initialETHBalance = await swap.balances(2);

        const numberOfTransactions = 10
        var dy1 = ZERO
        for (let i = 0; i < numberOfTransactions; i++) {
            let tx = await swap.exchange(2, 0, baseAssetQuantity, amount)
            let transactionEvent = await filterEvent(tx, 'TokenExchange')
            dy1 = dy1.add(transactionEvent.args[4]);
        }

        const dy2 = await swap.get_dx(0, 2, baseAssetQuantity.mul(numberOfTransactions), {gasLimit: 100000})
        const latestSnapshot = await amm.reserveSnapshots(numberOfTransactions)
        expect(dy1.div(_1e12)).to.eq(dy2.div(_1e12))
        expect((initialUSDTBalance.sub((await swap.balances(0)))).gte(amount.mul(numberOfTransactions))).to.be.true
        expect((await swap.balances(2)).sub(initialETHBalance)).to.eq(baseAssetQuantity.mul(numberOfTransactions))
        expect(await amm.getSnapshotLen()).to.eq(numberOfTransactions+1)
        expect(latestSnapshot.quoteAssetReserve).to.eq(initialUSDTBalance.sub(dy1))
        expect(latestSnapshot.baseAssetReserve).to.eq(initialETHBalance.add(baseAssetQuantity.mul(numberOfTransactions)))
    })
})

describe('TWAP Price', function() {
    before('generate sample snapshots', async function() {
        signers = await ethers.getSigners()
        alice = signers[0].address
        ;({ swap, amm } = await setupContracts(TRADE_FEE))

        baseAssetQuantity = _1e18.mul(5)

        // spot price after long : 1020 (1010092.1/990)
        // spot price after first short : 1010 (1005022.5/995)
        // spot price after second short : 1000 (100000/1000)
        let timestamp = (await amm.reserveSnapshots(0)).timestamp
        timestamp = timestamp.add(14)
        await increaseEvmTime(timestamp.toNumber())
        for (let i = 0; i < 30; i++) {
            if (i % 3 == 0) {
                await swap.exchangeExactOut(0, 2, baseAssetQuantity.mul(2), ethers.constants.MaxUint256)
                timestamp = timestamp.add(14)
                await increaseEvmTime(timestamp.toNumber())
            } else {
                await swap.exchange(2, 0, baseAssetQuantity, ZERO)
                timestamp = timestamp.add(28)
                await increaseEvmTime(timestamp.toNumber())
            }
        }
    })

    it('get TWAP price', async () => {
        // latest spot price is not considered in the calcualtion as delta t is 0
        // total snapshots in 420 seconds = 18
        // twap = (1020 * 6 snapshots * 14 sec + 1010*6*28 + 1000*6*28)/420 = 1008

        const twap = await amm.getTwapPrice(420)
        expect(twap).to.eq('1008071531')
    })

    it('the timestamp of latest snapshot is now, the latest snapshot wont have any effect', async () => {
        // price is 990 (995022.3/1005) but time weighted is zero
        await swap.exchange(2, 0, baseAssetQuantity, ZERO)

        // Shaving off 20 secs from the 420s window would mean dropping the first 1020 snapshot and 6 secs off the 1010 reading.
        // twap = (1020 * 5 snapshots * 14 sec + 1010 * 22 sec + 1010*5*28 +  + 1000*6*28)/400 = 1007
        const twap = await amm.getTwapPrice(400)
        expect(twap).to.eq('1007615851')
    })

    it('asking interval more than the snapshots', async () => {
        // total 32 snapshots, out of which latest doesn't count
        // twap = (1020 * 10 snapshots * 14 sec + 1010*10*28 + 1000*11*28)/728 = 1007

        const twap = await amm.getTwapPrice(900)
        expect(twap).to.eq('1007913266')
    })

    it('asking interval less than latest snapshot, return latest price directly', async () => {
        // price is 990
        await increaseEvmTime(Date.now() + 500)
        await swap.exchange(2, 0, baseAssetQuantity, ZERO) // add a delay of 500 seconds

        const twap = await amm.getTwapPrice(420)
        expect(twap).to.eq('990058671')
    })

    it('price with interval 0 should be the same as spot price', async () => {
        expect(await amm.getTwapPrice(0)).to.eq(await amm.getSpotPrice())
    })
})

async function increaseEvmTime(timeInSeconds) {
    await network.provider.send('evm_setNextBlockTimestamp', [timeInSeconds]);
}
