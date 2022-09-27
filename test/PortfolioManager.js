const { expect } = require('chai');

const {
    setupContracts,
    setupRestrictedTestToken,
    addMargin,
    constants: { _1e6, _1e18, ZERO }
} = require('./utils')

describe('Swap Collateral Tests', function() {
    before('contract factories', async function() {
        signers = await ethers.getSigners()
        alice = signers[0].address
        ;({ swap, marginAccount, vusd, clearingHouse, amm, usdc, weth, oracle, registry } = await setupContracts())
        wavax = await setupRestrictedTestToken('wavax', 'wavax', 18)
        await oracle.setUnderlyingPrice(wavax.address, 1e6 * 20) // $20

        await marginAccount.whitelistCollateral(wavax.address, 8e5) // avax index = 1

        // setup mock yak router
        const MockYakRouter = await ethers.getContractFactory('MockYakRouter')
        mockYakRouter = await MockYakRouter.deploy()
        const seedAmount = 10000
        await Promise.all([
            usdc.mint(mockYakRouter.address, _1e6.mul(seedAmount)),
            wavax.mint(mockYakRouter.address, _1e18.mul(seedAmount)),
            weth.mint(mockYakRouter.address, _1e18.mul(seedAmount)),
            wavax.grantRole(ethers.utils.id('TRANSFER_ROLE'), mockYakRouter.address),
            weth.grantRole(ethers.utils.id('TRANSFER_ROLE'), mockYakRouter.address),
        ])

        // deploy portfolio manager
        const PortfolioManager = await ethers.getContractFactory('PortfolioManager')
        portfolioManager = await PortfolioManager.deploy(registry.address, mockYakRouter.address)
        await Promise.all([
            marginAccount.setPortfolioManager(portfolioManager.address),
            vusd.grantRole(ethers.utils.id('TRANSFER_ROLE'), portfolioManager.address)
        ])

        // add margin
        vusdMargin = _1e6.mul(1000)
        wavaxMargin = _1e18.mul(50)
        await Promise.all([
            addMargin(signers[0], vusdMargin),
            addMargin(signers[0], wavaxMargin, wavax, 1)
        ])
    })

    it('swap avax to vusd', async function() {
        trade = [
            wavaxMargin.add(1), // amountIn
            _1e6.mul(200), // amountOut
            [ wavax.address, signers[2].address, usdc.address ], // trade path
            []
        ]
        await expect(portfolioManager.swapCollateral(1, 0, trade)).to.be.revertedWith('Insufficient balance')
        await expect(portfolioManager.swapCollateral(0, 0, trade)).to.be.revertedWith('PM: Invalid input token')
        await expect(portfolioManager.swapCollateral(1, 1, trade)).to.be.revertedWith('PM: Invalid output token')

        trade[0] = _1e18.mul(10)
        await portfolioManager.swapCollateral(1, 0, trade)

        expect(await marginAccount.margin(0, alice)).to.eq(vusdMargin.add(trade[1]))
        expect(await marginAccount.margin(1, alice)).to.eq(wavaxMargin.sub(trade[0]))
        expect(await usdc.balanceOf(portfolioManager.address)).to.eq(ZERO)
        expect(await wavax.balanceOf(portfolioManager.address)).to.eq(ZERO)
    })

    it('swap vusd to avax', async function() {
        trade = [
            trade[1], // amountIn
            trade[0], // amountOut
            [ usdc.address, signers[2].address, wavax.address ], // trade path
            []
        ]
        await expect(portfolioManager.swapCollateral(1, 1, trade)).to.be.revertedWith('PM: Invalid input token')
        await expect(portfolioManager.swapCollateral(0, 0, trade)).to.be.revertedWith('PM: Invalid output token')

        await portfolioManager.swapCollateral(0, 1, trade)

        expect(await marginAccount.margin(0, alice)).to.eq(vusdMargin)
        expect(await marginAccount.margin(1, alice)).to.eq(wavaxMargin)
    })

    it('swap weth <-> vusd', async function() {
        await marginAccount.whitelistCollateral(weth.address, 8e5) // weth index = 2
        wethMargin = _1e18.mul(5)
        await addMargin(signers[0], wethMargin, weth, 2)

        // weth to vusd
        trade = [
            _1e18.mul(2), // amountIn
            _1e6.mul(2000), // amountOut
            [ weth.address, signers[2].address, usdc.address ], // trade path
            []
        ]
        await portfolioManager.swapCollateral(2, 0, trade)

        expect(await marginAccount.margin(0, alice)).to.eq(vusdMargin.add(trade[1]))
        expect(await marginAccount.margin(1, alice)).to.eq(wavaxMargin)
        expect(await marginAccount.margin(2, alice)).to.eq(wethMargin.sub(trade[0]))

        // vusd to weth
        trade = [
            trade[1], // amountIn
            trade[0], // amountOut
            [ usdc.address, signers[2].address, weth.address ], // trade path
            []
        ]
        await portfolioManager.swapCollateral(0, 2, trade)

        expect(await marginAccount.margin(0, alice)).to.eq(vusdMargin)
        expect(await marginAccount.margin(1, alice)).to.eq(wavaxMargin)
        expect(await marginAccount.margin(2, alice)).to.eq(wethMargin)
    })

    it('swap weth <-> wavax', async function() {
        // weth to wavax
        trade = [
            _1e18.mul(2), // amountIn
            _1e18.mul(10), // amountOut
            [ weth.address, wavax.address ], // trade path
            []
        ]
        await portfolioManager.swapCollateral(2, 1, trade)

        expect(await marginAccount.margin(0, alice)).to.eq(vusdMargin)
        expect(await marginAccount.margin(1, alice)).to.eq(wavaxMargin.add(trade[1]))
        expect(await marginAccount.margin(2, alice)).to.eq(wethMargin.sub(trade[0]))

        // wavax to weth
        trade = [
            trade[1], // amountIn
            trade[0], // amountOut
            [ wavax.address, weth.address ], // trade path
            []
        ]
        await portfolioManager.swapCollateral(1, 2, trade)

        expect(await marginAccount.margin(0, alice)).to.eq(vusdMargin)
        expect(await marginAccount.margin(1, alice)).to.eq(wavaxMargin)
        expect(await marginAccount.margin(2, alice)).to.eq(wethMargin)

        // no assets in portfolio manager
        expect(await usdc.balanceOf(portfolioManager.address)).to.eq(ZERO)
        expect(await wavax.balanceOf(portfolioManager.address)).to.eq(ZERO)
        expect(await weth.balanceOf(portfolioManager.address)).to.eq(ZERO)
        expect(await vusd.balanceOf(portfolioManager.address)).to.eq(ZERO)
    })
})
