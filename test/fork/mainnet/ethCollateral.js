const { expect } = require('chai')
const { ethers } = require('hardhat')
const { mainnetConfig: config } = require('../../../scripts/config')
const { impersonateAccount, constants: { _1e18, ZERO, _1e6 }, forkCChain } = require('../../utils')

const deployer = '0xF5c8E1eAFFD278A383C13061B4980dB7619479af'
const proxyAdminAddy = '0xddf407237BDe4d36287Be4De79D65c57AefBf8da'
const JoeRouter = '0x60aE616a2155Ee3d9A68541Ba4544862310933d4'
const Trader = '0xfDC8fEF169a0BC0E5A9C3C5297501EE3b3C75bB1' // vusd = -234.50, wavax = 15
const Weth = '0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB'
const ethUsdFeed = '0x976b3d034e162d8bd72d6b9c989d545b839003b0'
const WethWhale = '0x7Aad7840F119f3876EE3569e488C7C4135f695fa'
const usdcWhale = '0x7d0f7ad75687d0616701126ef6d0dc6e9725d435'

describe('(fork) eth collateral', async function() {
    let blockTag = 19246068
    before(async function() {
        await forkCChain(blockTag)
        await impersonateAccount(deployer)
        signer = ethers.provider.getSigner(deployer)

        ;([ clearingHouse, marginAccount, amm, proxyAdmin,
            vusd, wavax, usdc, oracle, weth
        ] = await Promise.all([
            ethers.getContractAt('ClearingHouse', config.contracts.ClearingHouse),
            ethers.getContractAt('MarginAccount', config.contracts.MarginAccount),
            ethers.getContractAt('AMM', config.contracts.amms[0].address),
            ethers.getContractAt('ProxyAdmin', proxyAdminAddy),
            ethers.getContractAt('IERC20', config.contracts.vusd),
            ethers.getContractAt('IERC20', config.contracts.collateral[1].address),
            ethers.getContractAt('IERC20', config.contracts.usdc),
            ethers.getContractAt('Oracle', config.contracts.Oracle),
            ethers.getContractAt('IERC20', Weth)
        ]))

        const BatchLiquidator = await ethers.getContractFactory('BatchLiquidator')
        batchLiquidator = await BatchLiquidator.deploy(
            clearingHouse.address,
            marginAccount.address,
            vusd.address,
            usdc.address,
            wavax.address,
            JoeRouter
        )
    })

    after(async function() {
        await network.provider.request({
            method: "hardhat_reset",
            params: [],
        });
    })

    it('add eth collateral', async function() {
        await marginAccount.connect(signer).whitelistCollateral(Weth, _1e6.mul(8).div(10))
        await oracle.connect(signer).setAggregator(Weth, ethUsdFeed)
        // console.log(await oracle.getUnderlyingPrice(Weth)) // 1477.61
        // console.log(await oracle.getUnderlyingPrice(wavax.address)) // 19.41
    })

    it('flash liquidate with eth', async function() {
        const wethMargin = _1e18.mul(6).div(100)

        await impersonateAccount(WethWhale)
        const wethWhale = ethers.provider.getSigner(WethWhale)
        await weth.connect(wethWhale).approve(marginAccount.address, wethMargin)
        await marginAccount.connect(wethWhale).addMarginFor(2, wethMargin, Trader)

        // decrease avax weigth to make margin account liquidable
        await marginAccount.connect(signer).changeCollateralWeight(1, _1e6.mul(4).div(10))
        expect((await marginAccount.isLiquidatable(Trader, true))[0]).to.eq(0) // IS_LIQUIDATABLE
        const vusdMarginBefore = await marginAccount.margin(0, Trader)

        const repay = _1e6.mul(50)
        const minProfit = _1e18.div(1000) // 0.001 eth
        await batchLiquidator.liquidateMarginAccount(Trader, repay, 2, minProfit)

        expect(await weth.balanceOf(batchLiquidator.address)).to.gt(minProfit)
        expect(await marginAccount.margin(0, Trader)).to.eq(vusdMarginBefore.add(repay))
        expect((await marginAccount.isLiquidatable(Trader, true))[0]).to.eq(0) // IS_LIQUIDABLE
        // console.log(await marginAccount.isLiquidatable(Trader, true))
    })

    it('liquidate and sell', async function() {
        let repay = _1e6.mul(30)
        await impersonateAccount(usdcWhale)
        await usdc.connect(ethers.provider.getSigner(usdcWhale)).transfer(batchLiquidator.address, repay)

        const vusdMarginBefore = await marginAccount.margin(0, Trader)
        const wethBalanceBefore = await weth.balanceOf(batchLiquidator.address)

        await batchLiquidator.liquidateMarginAccount(Trader, repay, 2, 0)

        expect(await marginAccount.margin(0, Trader)).to.eq(vusdMarginBefore.add(repay))
        expect((await marginAccount.isLiquidatable(Trader, true))[0]).to.eq(0) // IS_LIQUIDABLE
        const [ wethBalance, usdcBalance ] = await Promise.all([
            weth.balanceOf(batchLiquidator.address),
            usdc.balanceOf(batchLiquidator.address)
        ])
        expect(wethBalance).to.gt(wethBalanceBefore)
        expect(usdcBalance).to.eq(repay)
        expect(await wavax.balanceOf(batchLiquidator.address)).to.eq(ZERO)

        // seize avax
        repay = (await marginAccount.margin(0, Trader)).mul(-1)
        const minProfit = _1e18.mul(3).div(10) // 0.3 avax
        await batchLiquidator.liquidateMarginAccount(Trader, repay, 1, minProfit)

        expect(await marginAccount.margin(0, Trader)).to.eq(ZERO)
        expect(await wavax.balanceOf(batchLiquidator.address)).to.gt(minProfit)
        expect((await marginAccount.isLiquidatable(Trader, true))[0]).to.eq(2) // NO_DEBT
        expect(await weth.balanceOf(batchLiquidator.address)).to.eq(wethBalance)
        expect(await usdc.balanceOf(batchLiquidator.address)).to.eq(usdcBalance)
    })
})
