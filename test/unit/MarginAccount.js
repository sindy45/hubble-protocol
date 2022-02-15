const { expect } = require('chai')
const utils = require('../utils')
const {
    setupContracts
} = utils
const { constants: { _1e6, ZERO } } = utils

describe('MarginAccount Unit Tests', function() {
    before('factories', async function() {
        signers = await ethers.getSigners()
        alice = signers[0].address
        ;([ bob, mockClearingHouse, admin ] = signers.slice(10))
        ;({ marginAccount, vusd, oracle, clearingHouse, insuranceFund } = await setupContracts({ amm: { initialLiquidity: 0 } }))
        await vusd.grantRole(await vusd.MINTER_ROLE(), admin.address)
    })

    it('reverts when initializing again', async function() {
        await expect(marginAccount.initialize(bob.address, vusd.address)).to.be.revertedWith('Initializable: contract is already initialized')
    })

    it('governance things', async function() {
        expect(await marginAccount.governance()).to.eq(alice)

        await expect(marginAccount.connect(bob).setGovernace(bob.address)).to.be.revertedWith('ONLY_GOVERNANCE')
        await expect(marginAccount.connect(bob).pause()).to.be.revertedWith('ONLY_GOVERNANCE')
        await expect(marginAccount.connect(bob).unpause()).to.be.revertedWith('ONLY_GOVERNANCE')
        await expect(marginAccount.connect(bob).syncDeps(alice, 0)).to.be.revertedWith('ONLY_GOVERNANCE')
        await expect(marginAccount.connect(bob).whitelistCollateral(alice, 0)).to.be.revertedWith('ONLY_GOVERNANCE')
        await expect(marginAccount.connect(bob).changeCollateralWeight(0, 0)).to.be.revertedWith('ONLY_GOVERNANCE')

        await marginAccount.setGovernace(bob.address)
        expect(await marginAccount.governance()).to.eq(bob.address)
        // alice doesn't have priviledges now
        await expect(marginAccount.setGovernace(bob.address)).to.be.revertedWith('ONLY_GOVERNANCE')

        await marginAccount.connect(bob).setGovernace(alice)
        expect(await marginAccount.governance()).to.eq(alice)
    })

    it('reverts when paused', async function() {
        await marginAccount.pause()
        await expect(marginAccount.addMargin(0, 1)).to.be.revertedWith('Pausable: paused')
        await expect(marginAccount.removeMargin(0, 1)).to.be.revertedWith('Pausable: paused')
        await expect(marginAccount.liquidateExactRepay(alice, 1, 1, 0)).to.be.revertedWith('Pausable: paused')
        await expect(marginAccount.liquidateExactSeize(alice, 1, 1, 0)).to.be.revertedWith('Pausable: paused')
        await expect(marginAccount.liquidateFlexible(alice, 1, [1])).to.be.revertedWith('Pausable: paused')
        await expect(marginAccount.settleBadDebt(alice)).to.be.revertedWith('Pausable: paused')
        await expect(marginAccount.liquidateFlexibleWithSingleSeize(alice, 1, 1)).to.be.revertedWith('Pausable: paused')
        await marginAccount.unpause()
    })

    it('realize fake pnl', async function() {
        await setClearingHouse(mockClearingHouse)
        expect(await vusd.balanceOf(marginAccount.address)).to.eq(0)
        pnl = _1e6.mul(123)
        await marginAccount.connect(mockClearingHouse).realizePnL(alice, pnl)
        expect(await marginAccount.margin(0, alice)).to.eq(pnl)
    })

    it('alice withdraws pnl', async function() {
        // but first we need to revert original clearingHouse, otherwise calls will revert
        await setClearingHouse(clearingHouse)
        expect(await vusd.balanceOf(alice)).to.eq(0)

        await marginAccount.removeMargin(0, pnl)

        expect(await vusd.balanceOf(alice)).to.eq(pnl)
        expect(await marginAccount.credit()).to.eq(pnl)
    })

    it('bob deposits margin which is used to settle credit partially', async function() {
        netDeposit = _1e6.mul(125)
        await vusd.connect(admin).mint(bob.address, netDeposit)
        await vusd.connect(bob).approve(marginAccount.address, netDeposit)

        deposit = _1e6.mul(48)
        await marginAccount.connect(bob).addMargin(0, deposit)

        expect(await vusd.balanceOf(bob.address)).to.eq(netDeposit.sub(deposit))
        expect(await vusd.balanceOf(marginAccount.address)).to.eq(ZERO)
        expect(await marginAccount.credit()).to.eq(pnl.sub(deposit))
    })

    it('bob deposits margin which is used to settle all credit', async function() {
        deposit = netDeposit.sub(deposit)
        await marginAccount.connect(bob).addMargin(0, deposit)

        expect(await vusd.balanceOf(bob.address)).to.eq(ZERO)
        expect(await vusd.balanceOf(marginAccount.address)).to.eq(netDeposit.sub(pnl))
        expect(await marginAccount.credit()).to.eq(ZERO)
    })
})

async function setClearingHouse(clearingHouse) {
    registry = await Registry.deploy(oracle.address, clearingHouse.address, insuranceFund.address, marginAccount.address, vusd.address)
    await marginAccount.syncDeps(registry.address, 5e4)
}
