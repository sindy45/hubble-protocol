const { expect } = require('chai')
const utils = require('../utils')
const {
    setupContracts
} = utils
const { constants: { _1e6, ZERO } } = utils

describe('Margin Account Unit Tests', function() {
    before('factories', async function() {
        signers = await ethers.getSigners()
        alice = signers[0].address
        ;([ bob, mockClearingHouse, admin ] = signers.slice(10))
        ;({ marginAccount, vusd, oracle, clearingHouse, insuranceFund } = await setupContracts(0, { addLiquidity: false }))
        await vusd.grantRole(await vusd.MINTER_ROLE(), admin.address)
    })

    it('reverts when initializing again', async function() {
        await expect(marginAccount.initialize(alice, alice, alice)).to.be.revertedWith('Initializable: contract is already initialized')
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
