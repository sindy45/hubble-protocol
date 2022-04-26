const { expect } = require('chai')
const utils = require('../utils')

const { constants: { _1e6, ZERO } } = utils

describe('vUSD Unit Tests', function() {
    before('factories', async function() {
        signers = await ethers.getSigners()
        alice = signers[0].address
        admin = signers[11]

        ;([ ERC20Mintable, TransparentUpgradeableProxy, ProxyAdmin, VUSD ] = await Promise.all([
            ethers.getContractFactory('ERC20Mintable'),
            ethers.getContractFactory('TransparentUpgradeableProxy'),
            ethers.getContractFactory('ProxyAdmin'),
            ethers.getContractFactory('VUSD'),
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

        it('reverts when initializing again', async function() {
            await expect(vusd.initialize("dummy name", "DUM")).to.be.revertedWith('Initializable: contract is already initialized')
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

            const withdrawalQueue = await vusd.withdrawalQueue()
            expect(withdrawalQueue[0].usr).to.eq(alice)
            expect(withdrawalQueue[0].amount).to.eq(amount)
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

        it('too [smol/big] withdraw fails', async function () {
            await expect(
                vusd.withdraw(_1e6.mul(5).sub(1))
            ).to.be.revertedWith('min withdraw is 5 vusd')

            await expect(
                vusd.connect(signers[1]).withdraw(amount.add(1))
            ).to.be.revertedWith('ERC20: burn amount exceeds balance')
        })

        it('multiple withdrawals', async function () {
            for (let i = 1; i <= 10; i++) {
                await vusd.connect(signers[i]).withdraw(amount.mul(i))
                expect(await vusd.balanceOf(signers[i].address)).to.eq(ZERO)
            }
            expect(await vusd.totalSupply()).to.eq(ZERO)

            const withdrawalQueue = await vusd.withdrawalQueue()
            expect(withdrawalQueue.length).to.eq(10)
            expect(withdrawalQueue[0].usr).to.eq(signers[1].address)
            expect(withdrawalQueue[0].amount).to.eq(amount)
            expect(withdrawalQueue[1].usr).to.eq(signers[2].address)
            expect(withdrawalQueue[1].amount).to.eq(amount.mul(2))
            expect(withdrawalQueue[9].usr).to.eq(signers[10].address)
            expect(withdrawalQueue[9].amount).to.eq(amount.mul(10))
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

        it('process oldest withdrawal request when enough balance is available', async function () {
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

    async function setupVusd() {
        // bdw, not a proxy
        const vusd = await VUSD.deploy(usdc.address)
        await vusd.initialize('Hubble USD', 'hUSD')
        return vusd
    }
})
