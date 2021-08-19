const { expect } = require('chai');

const { setupContracts, constants: { _1e6, _1e18, ZERO } } = require('./utils')

describe('Margin Account Tests', function() {
    before('contract factories', async function() {
        signers = await ethers.getSigners()
        alice = signers[0].address
        ;({ swap, marginAccount, clearingHouse, amm, vUSD, usdc } = await setupContracts())
    })

    it('addUSDCMargin', async () => {
        margin = _1e6.mul(2000)
        await usdc.mint(alice, margin)
        await usdc.approve(marginAccount.address, margin)
        await marginAccount.addUSDCMargin(margin);

        expect(await marginAccount.vUSDBalance(alice)).to.eq(margin)
        expect(await marginAccount.getNormalizedMargin(alice)).to.eq(margin)
    })

    it('withdrawVusd', async () => {
        margin = margin.div(2)
        await marginAccount.withdrawVusd(margin, false /* redeemForUSDC */);

        expect(await marginAccount.vUSDBalance(alice)).to.eq(margin)
        expect(await marginAccount.getNormalizedMargin(alice)).to.eq(margin)
    })

    it('addCollateral', async () => {
        const Oracle = await ethers.getContractFactory('Oracle')
        weth = await ERC20Mintable.deploy('weth', 'weth', 18)
        const oracle = await Oracle.deploy()

        await marginAccount.addCollateral(weth.address, oracle.address)

        const supportedCollateral = await marginAccount.supportedCollateral(0);
        expect(supportedCollateral.token).to.eq(weth.address)
        expect(supportedCollateral.oracle).to.eq(oracle.address)
        expect(supportedCollateral.decimals).to.eq(18)
    })

    it('addMargin', async () => {
        const amount = _1e18
        await weth.mint(alice, amount)
        await weth.approve(marginAccount.address, amount)
        await marginAccount.addMargin(0, amount);

        expect(await marginAccount.vUSDBalance(alice)).to.eq(margin)
        expect(await marginAccount.getNormalizedMargin(alice)).to.eq(_1e6.mul(2000).add(margin))
    })

    it('removeMargin', async () => {
        const amount = _1e18.div(2)
        await marginAccount.removeMargin(0, amount);

        expect(await marginAccount.vUSDBalance(alice)).to.eq(margin)
        expect(await marginAccount.getNormalizedMargin(alice)).to.eq(_1e6.mul(2000).div(2).add(margin))
    })
})
