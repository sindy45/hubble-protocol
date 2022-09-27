const { expect } = require('chai')
const { ethers } = require('hardhat')
const { mainnetConfig: config } = require('../../../scripts/config')
const { impersonateAccount, constants: { _1e18, ZERO, _1e6 } } = require('../../utils')
const { getMAVars } = require('./utils')

const deployer = '0xF5c8E1eAFFD278A383C13061B4980dB7619479af'
const proxyAdminAddy = '0xddf407237BDe4d36287Be4De79D65c57AefBf8da'
const YakRouter = '0xC4729E56b831d74bBc18797e0e17A295fA77488c'
const Trader = '0x6D3Ee34A020e7565e78540C74300218104C8e4a9' // vusd = -85.97, wavax = 350, weth = 0
const Trader2 = '0xF0C6380E27752c6DdE17e9F5B629620084B9a196' // vusd = 1.73, wavax = 0, weth = 19.1
const gasLimit = 1e10

describe('(fork) yield yak swap - v1.3.0', async function() {
    let blockTag = 20129791
    before(async function() {
        await network.provider.request({
            method: "hardhat_reset",
            params: [{
                forking: {
                    jsonRpcUrl: 'https://api.avax.network/ext/bc/C/rpc',
                    blockNumber: blockTag
                }
            }]
        })
        await impersonateAccount(deployer)
        signer = ethers.provider.getSigner(deployer)
        ;([ clearingHouse, marginAccount, amm, proxyAdmin, yakRouter, vusd, wavax, weth, usdc ] = await Promise.all([
            ethers.getContractAt('ClearingHouse', config.contracts.ClearingHouse),
            ethers.getContractAt('MarginAccount', config.contracts.MarginAccount),
            ethers.getContractAt('AMM', config.contracts.amms[0].address),
            ethers.getContractAt('ProxyAdmin', proxyAdminAddy),
            ethers.getContractAt('IYakRouter', YakRouter),
            ethers.getContractAt('IERC20', config.contracts.vusd),
            ethers.getContractAt('IERC20', config.contracts.collateral[1].address),
            ethers.getContractAt('IERC20', config.contracts.collateral[2].address),
            ethers.getContractAt('IERC20', config.contracts.usdc)
        ]))
        gasPrice = await ethers.provider.getGasPrice()

        await impersonateAccount(Trader)
        await impersonateAccount(Trader2)
        trader = ethers.provider.getSigner(Trader)
        trader2 = ethers.provider.getSigner(Trader2)
    })

    after(async function() {
        await network.provider.request({
            method: "hardhat_reset",
            params: [],
        });
    })

    it('deploy portfolio manager', async function() {
        const PortfolioManager = await ethers.getContractFactory('PortfolioManager')
        portfolioManager = await PortfolioManager.deploy(config.contracts.Registry, YakRouter)
    })

    it('update MarginAccount', async function() {
        const MarginAccount = await ethers.getContractFactory('MarginAccount')
        const newMarginAccount = await MarginAccount.deploy('0xEd27FB82DAb4c5384B38aEe8d0Ab81B3b591C0FA') // trustedForwarder

        const vars1 = await getMAVars(marginAccount, Trader)
        await proxyAdmin.connect(signer).upgrade(config.contracts.MarginAccount, newMarginAccount.address)
        await marginAccount.connect(signer).setPortfolioManager(portfolioManager.address)

        const vars2 = await getMAVars(marginAccount, Trader)
        expect(vars2).to.deep.equal(vars1)
    })

    it('settle negative vusd', async function() {
        const sellAmount = _1e18.mul(50)
        const bestPath = await yakRouter.findBestPathWithGas(
            sellAmount,
            config.contracts.collateral[1].address, // wavax
            config.contracts.usdc,
            3, // max steps
            gasPrice
        )

        const trade = [
            bestPath.amounts[0],
            bestPath.amounts[bestPath.amounts.length - 1].mul(998).div(1000), // 0.2% slippage, min usdc to receive
            bestPath.path,
            bestPath.adapters
        ]

        // console.log({trade})
        // const trade = [
        //     "50000000000000000000",
        //     "874358206",
        //     [
        //       '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7',
        //       '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E'
        //     ],
        //     [
        //       '0xE5a6a4279D1517231a84Fae629E433b312fe89D7',
        //     ]
        // ]

        await clearingHouse.updatePositions(Trader) // to settle pending funding
        const [ maWavaxBalance, maVusdBalance, vusdMargin, wavaxMargin ] = await Promise.all([
            wavax.balanceOf(marginAccount.address),
            vusd.balanceOf(marginAccount.address),
            marginAccount.margin(0, Trader),
            marginAccount.margin(1, Trader)
        ])

        await portfolioManager.connect(trader).swapCollateral(1, 0, trade)

        const [ maWavaxBalanceAfter, maVusdBalanceAfter, vusdMarginAfter, wavaxMarginAfter ] = await Promise.all([
            wavax.balanceOf(marginAccount.address),
            vusd.balanceOf(marginAccount.address),
            marginAccount.margin(0, Trader),
            marginAccount.margin(1, Trader)
        ])

        expect(maWavaxBalanceAfter).to.eq(maWavaxBalance.sub(sellAmount))
        expect(maVusdBalanceAfter).to.gte(maVusdBalance.add(trade[1]))
        expect(vusdMarginAfter).to.gte(vusdMargin.add(trade[1]))
        expect(wavaxMarginAfter).to.eq(wavaxMargin.sub(sellAmount))
        expect(await usdc.balanceOf(portfolioManager.address)).to.eq(ZERO)
        expect(await vusd.balanceOf(portfolioManager.address)).to.eq(ZERO)
        expect(await wavax.balanceOf(portfolioManager.address)).to.eq(ZERO)
    })

    it('swap vusd to wavax', async function() {
        const sellAmount = _1e6.mul(100)
        const bestPath = await yakRouter.findBestPathWithGas(
            sellAmount,
            config.contracts.usdc,
            config.contracts.collateral[1].address, // wavax
            3, // max steps
            gasPrice
        )

        const trade = [
            bestPath.amounts[0],
            bestPath.amounts[bestPath.amounts.length - 1].mul(998).div(1000), // 0.2% slippage, min wavax to receive
            bestPath.path,
            bestPath.adapters
        ]

        // console.log({trade})
        // const trade = [
        //     "100000000",
        //     "5717760518477580252",
            // [
            //     '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
            //     '0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB',
            //     '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7'
            // ],
            // [
            //     '0xE5a6a4279D1517231a84Fae629E433b312fe89D7',
            //     '0x3614657EDc3cb90BA420E5f4F61679777e4974E3'
            // ]
        // ]

        const [ maWavaxBalance, maVusdBalance, vusdMargin, wavaxMargin ] = await Promise.all([
            wavax.balanceOf(marginAccount.address),
            vusd.balanceOf(marginAccount.address),
            marginAccount.margin(0, Trader),
            marginAccount.margin(1, Trader)
        ])

        await portfolioManager.connect(trader).swapCollateral(0, 1, trade)

        const [ maWavaxBalanceAfter, maVusdBalanceAfter, vusdMarginAfter, wavaxMarginAfter ] = await Promise.all([
            wavax.balanceOf(marginAccount.address),
            vusd.balanceOf(marginAccount.address),
            marginAccount.margin(0, Trader),
            marginAccount.margin(1, Trader)
        ])

        expect(maWavaxBalanceAfter).to.gte(maWavaxBalance.add(trade[1]))
        expect(maVusdBalanceAfter).to.eq(maVusdBalance.sub(sellAmount))
        expect(vusdMarginAfter).to.eq(vusdMargin.sub(sellAmount))
        expect(wavaxMarginAfter).to.gte(wavaxMargin.add(trade[1]))
        expect(await usdc.balanceOf(portfolioManager.address)).to.eq(ZERO)
        expect(await vusd.balanceOf(portfolioManager.address)).to.eq(ZERO)
        expect(await wavax.balanceOf(portfolioManager.address)).to.eq(ZERO)
    })

    it('cannot swap if vusd + pendingFunding < 0', async function() {
        const pendingFunding = await clearingHouse.getTotalFunding(Trader2)
        const vusdMargin = await marginAccount.margin(0, Trader2)
        expect(vusdMargin).to.gt(ZERO)
        expect(vusdMargin.sub(pendingFunding)).to.lt(ZERO)

        const bestPath = await yakRouter.findBestPathWithGas(
            vusdMargin,
            config.contracts.usdc,
            config.contracts.collateral[2].address, // weth
            1,
            gasPrice
        )

        const trade = [
            bestPath.amounts[0],
            bestPath.amounts[bestPath.amounts.length - 1],
            bestPath.path,
            bestPath.adapters
        ]

        await expect(portfolioManager.connect(trader2).swapCollateral(0, 2, trade)).to.be.revertedWith('Insufficient balance')
    })

    it('swap weth to vusd', async function() {
        await clearingHouse.updatePositions(Trader2)
        const sellAmount = _1e18.mul(2)
        const bestPath = await yakRouter.findBestPathWithGas(
            sellAmount,
            config.contracts.collateral[2].address, // weth
            config.contracts.usdc,
            3, // max steps
            gasPrice
        )

        const trade = [
            bestPath.amounts[0],
            bestPath.amounts[bestPath.amounts.length - 1].mul(998).div(1000), // 0.2% slippage,
            bestPath.path,
            bestPath.adapters
        ]

        const [ maWethBalance, maVusdBalance, vusdMargin, wethMargin ] = await Promise.all([
            weth.balanceOf(marginAccount.address),
            vusd.balanceOf(marginAccount.address),
            marginAccount.margin(0, Trader2),
            marginAccount.margin(2, Trader2)
        ])

        await portfolioManager.connect(trader2).swapCollateral(2, 0, trade)

        const [ maWethBalanceAfter, maVusdBalanceAfter, vusdMarginAfter, wethMarginAfter ] = await Promise.all([
            weth.balanceOf(marginAccount.address),
            vusd.balanceOf(marginAccount.address),
            marginAccount.margin(0, Trader2),
            marginAccount.margin(2, Trader2)
        ])

        expect(maWethBalanceAfter).to.eq(maWethBalance.sub(sellAmount))
        expect(maVusdBalanceAfter).to.gte(maVusdBalance.add(trade[1]))
        expect(vusdMarginAfter).to.gte(vusdMargin.add(trade[1]))
        expect(wethMarginAfter).to.eq(wethMargin.sub(sellAmount))
    })

    it('swap vusd to weth', async function() {
        const sellAmount = _1e6.mul(1000)
        const bestPath = await yakRouter.findBestPathWithGas(
            sellAmount,
            config.contracts.usdc,
            config.contracts.collateral[2].address, // weth
            3, // max steps
            gasPrice,
            { gasLimit }
        )

        const trade = [
            bestPath.amounts[0],
            bestPath.amounts[bestPath.amounts.length - 1].mul(998).div(1000), // 0.2% slippage,
            bestPath.path,
            bestPath.adapters
        ]

        const [ maWethBalance, maVusdBalance, vusdMargin, wethMargin ] = await Promise.all([
            weth.balanceOf(marginAccount.address),
            vusd.balanceOf(marginAccount.address),
            marginAccount.margin(0, Trader2),
            marginAccount.margin(2, Trader2)
        ])

        await portfolioManager.connect(trader2).swapCollateral(0, 2, trade)

        const [ maWethBalanceAfter, maVusdBalanceAfter, vusdMarginAfter, wethMarginAfter ] = await Promise.all([
            weth.balanceOf(marginAccount.address),
            vusd.balanceOf(marginAccount.address),
            marginAccount.margin(0, Trader2),
            marginAccount.margin(2, Trader2)
        ])

        expect(maWethBalanceAfter).to.gte(maWethBalance.add(trade[1]))
        expect(maVusdBalanceAfter).to.eq(maVusdBalance.sub(sellAmount))
        expect(vusdMarginAfter).to.eq(vusdMargin.sub(sellAmount))
        expect(wethMarginAfter).to.gte(wethMargin.add(trade[1]))
    })

    it('swap weth to wavax', async function() {
        const sellAmount = _1e18.mul(2)
        const bestPath = await yakRouter.findBestPathWithGas(
            sellAmount,
            config.contracts.collateral[2].address, // weth
            config.contracts.collateral[1].address, // wavax
            3, // max steps
            gasPrice
        )

        const trade = [
            bestPath.amounts[0],
            bestPath.amounts[bestPath.amounts.length - 1].mul(998).div(1000), // 0.2% slippage,
            bestPath.path,
            bestPath.adapters
        ]

        const [ maWethBalance, maWavaxBalance, wavaxMargin, wethMargin ] = await Promise.all([
            weth.balanceOf(marginAccount.address),
            wavax.balanceOf(marginAccount.address),
            marginAccount.margin(1, Trader2),
            marginAccount.margin(2, Trader2)
        ])

        await portfolioManager.connect(trader2).swapCollateral(2, 1, trade)

        const [ maWethBalanceAfter, maWavaxBalanceAfter, wavaxMarginAfter, wethMarginAfter ] = await Promise.all([
            weth.balanceOf(marginAccount.address),
            wavax.balanceOf(marginAccount.address),
            marginAccount.margin(1, Trader2),
            marginAccount.margin(2, Trader2)
        ])

        expect(maWethBalanceAfter).to.eq(maWethBalance.sub(sellAmount))
        expect(maWavaxBalanceAfter).to.gte(maWavaxBalance.add(trade[1]))
        expect(wavaxMarginAfter).to.gte(wavaxMargin.add(trade[1]))
        expect(wethMarginAfter).to.eq(wethMargin.sub(sellAmount))
    })

    it('swap wavax to weth', async function() {
        const sellAmount = _1e18.mul(50)
        const bestPath = await yakRouter.findBestPathWithGas(
            sellAmount,
            config.contracts.collateral[1].address, // wavax
            config.contracts.collateral[2].address, // weth
            3, // max steps
            gasPrice,
            { gasLimit }
        )

        const trade = [
            bestPath.amounts[0],
            bestPath.amounts[bestPath.amounts.length - 1].mul(998).div(1000), // 0.2% slippage
            bestPath.path,
            bestPath.adapters
        ]

        const [ maWethBalance, maWavaxBalance, wavaxMargin, wethMargin ] = await Promise.all([
            weth.balanceOf(marginAccount.address),
            wavax.balanceOf(marginAccount.address),
            marginAccount.margin(1, Trader2),
            marginAccount.margin(2, Trader2)
        ])

        await portfolioManager.connect(trader2).swapCollateral(1, 2, trade)

        const [ maWethBalanceAfter, maWavaxBalanceAfter, wavaxMarginAfter, wethMarginAfter ] = await Promise.all([
            weth.balanceOf(marginAccount.address),
            wavax.balanceOf(marginAccount.address),
            marginAccount.margin(1, Trader2),
            marginAccount.margin(2, Trader2)
        ])

        expect(maWethBalanceAfter).to.gte(maWethBalance.add(trade[1]))
        expect(maWavaxBalanceAfter).to.eq(maWavaxBalance.sub(sellAmount))
        expect(wavaxMarginAfter).to.eq(wavaxMargin.sub(sellAmount))
        expect(wethMarginAfter).to.gte(wethMargin.add(trade[1]))

        expect(await usdc.balanceOf(portfolioManager.address)).to.eq(ZERO)
        expect(await vusd.balanceOf(portfolioManager.address)).to.eq(ZERO)
        expect(await wavax.balanceOf(portfolioManager.address)).to.eq(ZERO)
        expect(await weth.balanceOf(portfolioManager.address)).to.eq(ZERO)
    })
})
