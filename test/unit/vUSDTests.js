const { expect } = require('chai')
const utils = require('../utils')

const { constants: { _1e6, ZERO } } = utils

describe('vUSD Unit Tests', function() {
    before('factories', async function() {
        signers = await ethers.getSigners()
        alice = signers[0].address
        admin = signers[11]

        ;([ ERC20Mintable, TransparentUpgradeableProxy, ProxyAdmin ] = await Promise.all([
            ethers.getContractFactory('ERC20Mintable'),
            ethers.getContractFactory('TransparentUpgradeableProxy'),
            ethers.getContractFactory('ProxyAdmin')
        ]))
        proxyAdmin = await ProxyAdmin.deploy()

        amount = _1e6.mul(123)
    })

    describe('minter role', async function() {
        before('deploy vUSD', async function() {
            usdc = await ERC20Mintable.deploy('usdc', 'usdc', 6)
            vusd = await setupVusd()
            minterRole = await vusd.MINTER_ROLE()
        })

        it('mint fails without minter role', async function() {
            expect(await vusd.hasRole(minterRole, admin.address)).to.be.false
            await expect(
                vusd.connect(admin).mint(alice, amount)
            ).to.be.revertedWith('ERC20PresetMinterPauser: must have minter role to mint')
        })

        it('grant minter role', async function() {
            await vusd.grantRole(minterRole, admin.address)
            expect(await vusd.hasRole(minterRole, admin.address)).to.be.true
        })

        it('minter can freely mint', async function() {
            await vusd.connect(admin).mint(alice, amount)
            expect(await vusd.balanceOf(alice)).to.eq(amount)
        })

        it('revoke minter role', async function() {
            await vusd.revokeRole(minterRole, admin.address)
            expect(await vusd.hasRole(minterRole, admin.address)).to.be.false
        })

        it('mint fails after minter role is revoked', async function() {
            await expect(
                vusd.connect(admin).mint(alice, amount)
            ).to.be.revertedWith('ERC20PresetMinterPauser: must have minter role to mint')
        })
    })

    describe('withdrawal Q', async function() {
        before('deploy vUSD', async function() {
            usdc = await ERC20Mintable.deploy('usdc', 'usdc', 6)
            vusd = await setupVusd()
        })

        it('mintWithReserve', async function() {
            await usdc.mint(alice, amount)
            await usdc.approve(vusd.address, amount)
            await vusd.mintWithReserve(alice, amount)
            expect(await vusd.balanceOf(alice)).to.eq(amount)
            expect(await usdc.balanceOf(vusd.address)).to.eq(amount)
        })

        it('alice withdraws', async function() {
            await vusd.withdraw(amount)
            expect(await vusd.balanceOf(alice)).to.eq(ZERO)
            expect(await vusd.totalSupply()).to.eq(ZERO)
        })

        it('processWithdrawals', async function() {
            await vusd.processWithdrawals()
            expect(await usdc.balanceOf(alice)).to.eq(amount)
            expect(await usdc.balanceOf(vusd.address)).to.eq(ZERO)
        })

        it('multiple mintWithReserve', async function () {
            let trader, _amount;
            for (let i = 1; i <= 10; i++) {
                trader = signers[i]
                _amount = amount.mul(i)
                await mintVusdWithReserve(trader, _amount)
                expect(await vusd.balanceOf(trader.address)).to.eq(_amount)
            }
            expect(await usdc.balanceOf(vusd.address)).to.eq(_1e6.mul(6765))
        })

        it('multiple withdrawals', async function () {
            for (let i = 1; i <= 10; i++) {
                await vusd.connect(signers[i]).withdraw(amount.mul(i))
                expect(await vusd.balanceOf(signers[i].address)).to.eq(ZERO)
            }
            expect(await vusd.totalSupply()).to.eq(ZERO)
        })

        it('process multiple withdrawals', async function () {
            await vusd.processWithdrawals()
            for (let i = 1; i <= 10; i++) {
                expect(await usdc.balanceOf(signers[i].address)).to.eq(amount.mul(i))
            }
            expect(await usdc.balanceOf(vusd.address)).to.eq(ZERO)
        })
    })

    describe('partial withdrawals', async function() {
        before('deploy vUSD', async function() {
            usdc = await ERC20Mintable.deploy('usdc', 'usdc', 6)
            vusd = await setupVusd()
        })

        it('process partial withdrawals', async function () {
            let _amount
            for (let i = 1; i <= 5; i++) {
                _amount = amount.mul(i)
                await mintVusdWithReserve(signers[i], _amount)
                await vusd.connect(signers[i]).withdraw(_amount)
                expect(await usdc.balanceOf(signers[i].address)).to.eq(ZERO)
            }

            // free mints will cause usdc balance enough for only first 5 withdrawals
            await vusd.grantRole(await vusd.MINTER_ROLE(), admin.address)
            for (let i = 6; i <= 10; i++) {
                _amount = amount.mul(i)
                await vusd.connect(admin).mint(signers[i].address, _amount)
                await vusd.connect(signers[i]).withdraw(_amount)
            }
            const spareUsdc = _1e6.mul(20)
            await usdc.mint(vusd.address, spareUsdc)

            await vusd.processWithdrawals()

            for (let i = 1; i <= 5; i++) {
                expect(await usdc.balanceOf(signers[i].address)).to.eq(amount.mul(i))
            }
            for (let i = 6; i <= 10; i++) {
                expect(await usdc.balanceOf(signers[i].address)).to.eq(ZERO)
            }
            expect(await usdc.balanceOf(vusd.address)).to.eq(spareUsdc)
        })

        it('revert if not enough balance', async function () {
            await expect(vusd.processWithdrawals()).to.be.revertedWith('Cannot process withdrawals at this time: Not enough balance')
        })

        it('prcess oldest withdrawal request when enough balance is available', async function () {
            await usdc.mint(vusd.address, _1e6.mul(800))

            // minimum required = 123*6 = 738
            await vusd.processWithdrawals()
            expect(await usdc.balanceOf(signers[6].address)).to.eq(_1e6.mul(738))
            expect(await usdc.balanceOf(signers[7].address)).to.eq(ZERO)

            expect(await usdc.balanceOf(vusd.address)).to.eq(_1e6.mul(82)) //  20 (initial) + 800 (deposited) - 738 (withdrawn)
        })
    })

    async function mintVusdWithReserve(trader, _amount) {
        await usdc.mint(trader.address, _amount)
        await usdc.connect(trader).approve(vusd.address, _amount)
        await vusd.connect(trader).mintWithReserve(trader.address, _amount)
    }

    function setupVusd() {
        return utils.setupUpgradeableProxy(
            'VUSD',
            proxyAdmin.address,
            [ admin.address ],
            [ usdc.address ]
        )
    }
})
