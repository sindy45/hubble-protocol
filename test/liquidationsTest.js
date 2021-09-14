const { expect } = require('chai');

const { constants: { _1e6, _1e18, ZERO }, getTradeDetails, setupContracts } = require('./utils')

describe('Liquidation Tests', async function() {
    before('contract factories', async function() {
        signers = await ethers.getSigners()
        ;([ _, bob, liquidator1, liquidator2 ] = signers)
        alice = signers[0].address
        ;({ swap, marginAccount, marginAccountHelper, clearingHouse, amm, vusd, usdc, oracle, weth } = await setupContracts())
    })

    it('addCollateral', async () => {
        await oracle.setPrice(weth.address, 1e6 * 2000) // $2k
        await marginAccount.addCollateral(weth.address, 0.7 * 1e6) // weight = 0.7
    })

    it('addMargin', async () => {
        const amount = _1e18.div(2)
        await weth.mint(alice, amount)
        await weth.approve(marginAccount.address, amount)
        await marginAccount.addMargin(1, amount);
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

    it('alice\'s margin account is liquidated', async function() {
        const repayAmount = (await marginAccount.margin(0, alice)).abs()
        // the repayAmount is ~742, whereas .5 eth at weight = 0.7 and price = 2k allows for $700 margin
        // console.log({ repayAmount: repayAmount.toString() })

        await vusd.mint(liquidator2.address, repayAmount)
        await vusd.connect(liquidator2).approve(marginAccount.address, repayAmount)
        await marginAccount.connect(liquidator2).liquidate(alice, repayAmount, 1)

        const liquidationIncentive = _1e18.mul(108).div(100)
        const seizeAmount = repayAmount.mul(liquidationIncentive).div(1e6 * 2000);

        expect(await weth.balanceOf(liquidator2.address)).to.eq(seizeAmount)
        expect(await vusd.balanceOf(liquidator2.address)).to.eq(ZERO)
    })


    async function addMargin(trader, margin) {
        await usdc.mint(trader.address, margin)
        await usdc.connect(trader).approve(marginAccountHelper.address, margin)
        await marginAccountHelper.connect(trader).addVUSDMarginWithReserve(margin)
    }
})
