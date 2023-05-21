const { expect } = require('chai')
const utils = require('../utils')
const {
    setupContracts
} = utils
const { constants: { _1e6, ZERO } } = utils

describe('ClearingHouse Unit Tests', function() {
    before('factories', async function() {
        signers = await ethers.getSigners()
        alice = signers[0].address
        ;([ bob, mockClearingHouse, admin ] = signers.slice(10))
        ;({ marginAccount, vusd, oracle, clearingHouse, insuranceFund } = await setupContracts({ testClearingHouse: false }))
    })

    it('reverts when initializing again', async function() {
        await expect(clearingHouse.initialize(alice, alice, alice, alice, alice, alice)).to.be.revertedWith('Initializable: contract is already initialized')
    })

    it('governance things', async function() {
        expect(await clearingHouse.governance()).to.eq(alice)

        await expect(clearingHouse.connect(bob).setGovernace(bob.address)).to.be.revertedWith('ONLY_GOVERNANCE')
        await expect(clearingHouse.connect(bob).pause()).to.be.revertedWith('ONLY_GOVERNANCE')
        await expect(clearingHouse.connect(bob).unpause()).to.be.revertedWith('ONLY_GOVERNANCE')
        await expect(clearingHouse.connect(bob).whitelistAmm(alice)).to.be.revertedWith('ONLY_GOVERNANCE')
        await expect(clearingHouse.connect(bob).setParams(0, 0, 0, 0, 0, 0, 0)).to.be.revertedWith('ONLY_GOVERNANCE')

        await clearingHouse.setGovernace(bob.address)
        expect(await clearingHouse.governance()).to.eq(bob.address)
        // alice doesn't have priviledges now
        await expect(clearingHouse.setGovernace(bob.address)).to.be.revertedWith('ONLY_GOVERNANCE')

        await clearingHouse.connect(bob).setGovernace(alice)
        expect(await clearingHouse.governance()).to.eq(alice)
    })
})
