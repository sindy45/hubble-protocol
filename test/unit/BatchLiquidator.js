
const { expect } = require('chai');

const {
    constants: { _1e6, _1e18, ZERO },
    setupContracts,
    impersonateAcccount,
    forkCChain
} = require('../utils')

const JoeFactory = '0x9Ad6C38BE94206cA50bb0d90783181662f0Cfa10'
const Wavax = '0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7'
const Usdc = '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e'
const JoeRouter = '0x60aE616a2155Ee3d9A68541Ba4544862310933d4'
const wavaxWhale = '0x9d1968765e37f5cbd4f1c99a012cf0b5b07067ae' // 381 wavax
// const usdcWhale = '0x7d0f7ad75687d0616701126ef6d0dc6e9725d435' // 100k usdc

describe('Atomic liquidations', async function() {
    before(async function() {
        await forkCChain(16010497)
        signers = await ethers.getSigners()
        ;([ _, bob, liquidator1, liquidator2, liquidator3, admin, charlie ] = signers)
        alice = signers[0].address
        wavax = await ethers.getContractAt('IERC20', Wavax)
        usdc = await ethers.getContractAt('IERC20', Usdc)
        ;({ marginAccount, clearingHouse, vusd, oracle, marginAccountHelper } = await setupContracts({ reserveToken: usdc.address }))
        await vusd.grantRole(await vusd.MINTER_ROLE(), admin.address) // will mint vusd to liquidators account
        await clearingHouse.setParams(
            1e5 /** maintenance margin */,
            1e5 /** minimum allowable margin */,
            5e2 /** tradeFee */,
            5e4 /** liquidationPenalty */
        )

        await amm.setLiquidationParams(100, 1e6)
        const BatchLiquidator = await ethers.getContractFactory('BatchLiquidator')
        batchLiquidator = await BatchLiquidator.deploy(
            clearingHouse.address,
            marginAccount.address,
            vusd.address,
            Usdc,
            Wavax,
            JoeRouter,
            JoeFactory
        )

        // addCollateral
        const avaxOraclePrice = 1e6 * 17 // joe pool price at forked block
        await oracle.setUnderlyingPrice(Wavax, avaxOraclePrice),
        await marginAccount.whitelistCollateral(Wavax, 0.8 * 1e6) // weight = 0.8

        // addMargin
        const avaxMargin = _1e18.mul(1000 * 1e6).div(avaxOraclePrice) // $1000, decimals = 18
        await impersonateAcccount(wavaxWhale)
        await wavax.connect(ethers.provider.getSigner(wavaxWhale)).transfer(alice, avaxMargin)
        await wavax.approve(marginAccount.address, avaxMargin),
        await marginAccount.addMargin(1, avaxMargin)

        // alice makes a trade
        await clearingHouse.openPosition(0, _1e18.mul(-5), 0)
        expect((await marginAccount.isLiquidatable(alice, true))[0]).to.eq(1) // OPEN_POSITIONS

        // bob makes a counter-trade
        const vusdMargin = _1e6.mul(20000)
        await vusd.connect(admin).mint(bob.address, vusdMargin)
        await vusd.connect(bob).approve(marginAccount.address, vusdMargin)
        await marginAccount.connect(bob).addMargin(0, vusdMargin)
        await clearingHouse.connect(bob).openPosition(0, _1e18.mul(70), ethers.constants.MaxUint256)

        // liquidate alice position
        expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.false
        await clearingHouse.connect(liquidator1).liquidateTaker(alice)
        expect((await marginAccount.isLiquidatable(alice, true))[0]).to.eq(0) // IS_LIQUIDATABLE
    })

    it('liquidate and sell avax', async function() {
        // repay 50%
        const debt = await marginAccount.margin(0, alice)
        const repay = debt.div(-2)
        await vusd.connect(admin).mint(batchLiquidator.address, repay)
        expect(await usdc.balanceOf(batchLiquidator.address)).to.eq(ZERO)

        const minUsdcOut = repay.add(repay.mul(3).div(100)) // min 3% profit
        await batchLiquidator.liquidateAndSellAvax(alice, repay, minUsdcOut)

        remainingDebt = debt.add(repay)
        expect(await usdc.balanceOf(batchLiquidator.address)).to.gte(minUsdcOut)
        expect(await wavax.balanceOf(batchLiquidator.address)).to.eq(ZERO)
        expect(await vusd.balanceOf(batchLiquidator.address)).to.eq(ZERO)
        expect(await marginAccount.margin(0, alice)).to.eq(remainingDebt)
        // alice is still liquidable
        expect((await marginAccount.isLiquidatable(alice, true))[0]).to.eq(0) // IS_LIQUIDATABLE
    })

    it('flash loan and liquidate', async function() {
        // withdraw usdc from batchLiquidator
        await batchLiquidator.withdraw(usdc.address)
        expect(await usdc.balanceOf(batchLiquidator.address)).to.eq(ZERO)

        // repay whole debt
        const minProfit = _1e18.mul(9).div(10) // min 0.9 avax profit
        await batchLiquidator.flashLiquidateWithAvax(alice, remainingDebt.mul(-1), minProfit)

        expect(await usdc.balanceOf(batchLiquidator.address)).to.eq(ZERO)
        expect(await wavax.balanceOf(batchLiquidator.address)).to.gte(minProfit)
        expect(await vusd.balanceOf(batchLiquidator.address)).to.eq(ZERO)
        expect(await marginAccount.margin(0, alice)).to.eq(ZERO)
        expect((await marginAccount.isLiquidatable(alice, true))[0]).to.eq(2) // NO_DEBT
    })
})
