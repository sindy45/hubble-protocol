const { expect } = require('chai')
const utils = require('../utils')
const {
    setupContracts
} = utils
const { constants: { _1e6, ZERO } } = utils

describe('Insurance Fund Unit Tests', function() {
    before('factories', async function() {
        signers = await ethers.getSigners()
        alice = signers[0].address
        ;([ bob, mockMarginAccount, admin ] = signers.slice(10))
        ;({ marginAccount, vusd, oracle, clearingHouse, insuranceFund } = await setupContracts(0, { addLiquidity: false }))
        await vusd.grantRole(await vusd.MINTER_ROLE(), admin.address)
    })

    it('reverts when initializing again', async function() {
        await expect(insuranceFund.initialize(alice)).to.be.revertedWith('Initializable: contract is already initialized')
    })

    it('deposit', async function() {
        deposit = _1e6.mul(120)
        await vusd.connect(admin).mint(alice, deposit)
        await vusd.approve(insuranceFund.address, deposit)

        await insuranceFund.deposit(deposit)
        expect(await insuranceFund.balanceOf(alice)).to.eq(deposit)
        expect(await vusd.balanceOf(insuranceFund.address)).to.eq(deposit)
        expect(await vusd.balanceOf(alice)).to.eq(ZERO)
        expect(await insuranceFund.pricePerShare()).to.eq(_1e6)
        expect(await insuranceFund.totalSupply()).to.eq(deposit)
    })

    it('IF gets some fees', async function() {
        fee = _1e6.mul(60)
        // IF has 180 vusd now
        await vusd.connect(admin).mint(insuranceFund.address, fee)
        expect(await insuranceFund.pricePerShare()).to.eq(_1e6.mul(15).div(10))
    })

    it('partial withdraw', async function() {
        withdraw = _1e6.mul(60) // half their shares

        await insuranceFund.withdraw(withdraw)

        expect(await insuranceFund.balanceOf(alice)).to.eq(deposit.div(2))
        expect(await insuranceFund.totalSupply()).to.eq(deposit.div(2))
        // IF has 90 vusd now
        expect(await vusd.balanceOf(insuranceFund.address)).to.eq(_1e6.mul(90))
        expect(await vusd.balanceOf(alice)).to.eq(_1e6.mul(90))
        expect(await insuranceFund.pricePerShare()).to.eq(_1e6.mul(15).div(10)) // remains same
    })

    it('seizeBadDebt', async function() {
        await setMarginAccount(mockMarginAccount)
        debt = _1e6.mul(40)
        await expect(insuranceFund.seizeBadDebt(debt)).to.be.revertedWith('IF.only_margin_account')
        await insuranceFund.connect(mockMarginAccount).seizeBadDebt(debt)
        expect(await vusd.balanceOf(insuranceFund.address)).to.eq(_1e6.mul(50))
        expect(await vusd.balanceOf(mockMarginAccount.address)).to.eq(debt)
        expect(await insuranceFund.pricePerShare()).to.eq(_1e6.mul(50).mul(_1e6).div(_1e6.mul(60)))
        expect(await insuranceFund.pendingObligation()).to.eq(ZERO)
    })

    it('withdraws still possible', async function() {
        withdraw = _1e6.mul(15) // 25% their shares

        await insuranceFund.withdraw(withdraw)

        expect(await insuranceFund.balanceOf(alice)).to.eq(_1e6.mul(45))
        expect(await insuranceFund.totalSupply()).to.eq(_1e6.mul(45))
        expect(await vusd.balanceOf(insuranceFund.address)).to.eq(_1e6.mul(375).div(10)) // 50 * 3/4 = 37.5
        expect(await vusd.balanceOf(alice)).to.eq(_1e6.mul(1025).div(10)) // 90 + 50/4
    })

    it('seize more than IF has', async function() {
        seize = _1e6.mul(395).div(10) // 39.5
        await insuranceFund.connect(mockMarginAccount).seizeBadDebt(seize)
        expect(await vusd.balanceOf(insuranceFund.address)).to.eq(ZERO)
        expect(await vusd.balanceOf(mockMarginAccount.address)).to.eq(_1e6.mul(775).div(10)) // 40 + 37.5
        expect(await insuranceFund.pricePerShare()).to.eq(_1e6)
        expect(await insuranceFund.pendingObligation()).to.eq(_1e6.mul(2))
    })

    it('deposits/withdraws not possible', async function() {
        await expect(insuranceFund.deposit(1)).to.be.revertedWith('IF.deposit.pending_obligations')
        await expect(insuranceFund.withdraw(1)).to.be.revertedWith('IF.withdraw.pending_obligations')
    })

    it('IF gets some fees', async function() {
        await vusd.connect(admin).mint(insuranceFund.address, _1e6.mul(3))
        // (3-2) * precision / totalSupply=45
        expect(await insuranceFund.pricePerShare()).to.eq(_1e6.mul(_1e6).div(_1e6.mul(45)))

        await insuranceFund.settlePendingObligation()

        expect(await insuranceFund.pricePerShare()).to.eq(_1e6.mul(_1e6).div(_1e6.mul(45)))
        expect(await insuranceFund.pendingObligation()).to.eq(ZERO)
        expect(await vusd.balanceOf(mockMarginAccount.address)).to.eq(_1e6.mul(795).div(10)) // 40 + 37.5 + 2
    })

    it('deposits/withdraws active again', async function() {
        await vusd.connect(admin).mint(bob.address, 1)
        await vusd.connect(bob).approve(insuranceFund.address, 1)
        await insuranceFund.connect(bob).deposit(1) // pps = 1 / 45
        await insuranceFund.connect(bob).withdraw(45)
    })
})

async function setMarginAccount(marginAccount) {
    registry = await Registry.deploy(oracle.address, clearingHouse.address, insuranceFund.address, marginAccount.address, vusd.address)
    await insuranceFund.syncDeps(registry.address)
}
