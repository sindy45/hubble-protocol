
const { expect } = require('chai');

const {
    constants: { _1e6, _1e18, ZERO },
    setupContracts,
    impersonateAccount,
    stopImpersonateAccount,
    forkCChain,
    setBalance,
    setDefaultClearingHouseParams,
    bnToFloat,
    BigNumber
} = require('../utils')

const Wavax = '0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7'
const Weth = '0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB'
const Usdc = '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e'
const JoeRouter = '0x60aE616a2155Ee3d9A68541Ba4544862310933d4'
const wethWhale = '0xf3c9861425c32fe81229cebc53fea58fd8cb07cc' // 9428 weth

describe.skip('Atomic liquidations, Arb auction', async function() {
    before(async function() {
        await forkCChain(19644700)
        signers = await ethers.getSigners()
        ;([ _, bob, liquidator1, liquidator2, liquidator3, admin, charlie ] = signers)
        alice = signers[0].address
        wavax = await ethers.getContractAt('IERC20', Wavax)
        usdc = await ethers.getContractAt('IERC20', Usdc)

        // gimme some usdc
        usdc = await ethers.getContractAt('IUSDC', usdc.address)
        const masterMinter = await usdc.masterMinter()
        await setBalance(masterMinter, '0xDE0B6B3A7640000') // 1e18, to pay for gas fee
        await impersonateAccount(masterMinter)
        await usdc.connect(ethers.provider.getSigner(masterMinter)).configureMinter(alice, _1e18, { gasPrice: 25e9 })
        await stopImpersonateAccount(masterMinter)

        ;({ marginAccount, clearingHouse, vusd, oracle, marginAccountHelper, hubbleViewer } = await setupContracts({ reserveToken: usdc.address, wavaxAddress: wavax.address }))

        await vusd.grantRole(await vusd.MINTER_ROLE(), admin.address) // will mint vusd to liquidators account
        await setDefaultClearingHouseParams(clearingHouse)

        await amm.setLiquidationParams(1e6, 1e6)
        const BatchLiquidator = await ethers.getContractFactory('BatchLiquidator')
        batchLiquidator = await BatchLiquidator.deploy(
            clearingHouse.address,
            marginAccount.address,
            vusd.address,
            Usdc,
            Wavax,
            JoeRouter
        )

        weth = await ethers.getContractAt('IERC20', Weth)

        // addCollateral
        avaxOraclePrice = 1e6 * 18.5 // joe pool price at forked block
        wethOraclePrice = 1e6 * 1538 // joe pool price at forked block
        await oracle.setUnderlyingPrice(Wavax, avaxOraclePrice),
        await marginAccount.whitelistCollateral(Wavax, 0.8 * 1e6) // weight = 0.8
        await oracle.setUnderlyingPrice(Weth, wethOraclePrice),
        await marginAccount.whitelistCollateral(Weth, 0.8 * 1e6) // weight = 0.8
    })

    after(async function() {
        await network.provider.request({
            method: "hardhat_reset",
            params: [],
        });
    })

    it('add margin with avax', async function() {
        const avaxMargin = _1e18.mul(500 * 1e6).div(avaxOraclePrice) // $500, decimals = 18
        const wethMargin = _1e18.mul(500 * 1e6).div(wethOraclePrice) // $500, decimals = 18
        // console.log(bnToFloat(avaxMargin, 18), bnToFloat(wethMargin, 18)) // 27.02 avax and .32 weth
        await impersonateAccount(wethWhale)
        await weth.connect(ethers.provider.getSigner(wethWhale)).transfer(alice, wethMargin)
        await weth.approve(marginAccount.address, wethMargin)
        await Promise.all([
            marginAccountHelper.addMarginWithAvax({value: avaxMargin}),
            marginAccount.addMargin(2, wethMargin),
            marginAccountHelper.connect(charlie).addMarginWithAvax({value: avaxMargin.mul(2)})
        ])
        expect(await marginAccount.margin(1, alice)).to.eq(avaxMargin)
        expect(await marginAccount.margin(2, alice)).to.eq(wethMargin)
        expect(await marginAccount.margin(1, charlie.address)).to.eq(avaxMargin.mul(2))
    })

    it('liquidate alice position', async function() {
        // alice makes a trade
        await clearingHouse.openPosition2(0, _1e18.mul(-5), 0)
        expect((await marginAccount.isLiquidatable(alice, true))[0]).to.eq(1) // OPEN_POSITIONS
        await clearingHouse.connect(charlie).openPosition2(0, _1e18.mul(-5), 0)

        // bob makes a counter-trade
        const vusdMargin = _1e6.mul(20000)
        await vusd.connect(admin).mint(bob.address, vusdMargin)
        await vusd.connect(bob).approve(marginAccount.address, vusdMargin)
        await marginAccount.connect(bob).addMargin(0, vusdMargin)
        await clearingHouse.connect(bob).openPosition2(0, _1e18.mul(70), ethers.constants.MaxUint256)

        // liquidate alice position
        expect(await clearingHouse.isAboveMaintenanceMargin(alice)).to.be.false
        expect(await clearingHouse.isAboveMaintenanceMargin(charlie.address)).to.be.false
        await clearingHouse.connect(liquidator1).liquidate2(alice)
        expect((await marginAccount.isLiquidatable(alice, true))[0]).to.eq(0) // IS_LIQUIDATABLE
    })

    it('liquidateAndSell avax', async function() {
        const debt = await marginAccount.margin(0, alice)
        // console.log({ debt: bnToFloat(debt) }) // -903.206
        repay = debt.div(-4) // repay 20% - this value is also used in the next test
        const minProfit = repay.div(20).mul(_1e6).div(avaxOraclePrice) // / 20 == 5% profit
        await vusd.connect(admin).mint(batchLiquidator.address, repay)
        expect(await usdc.balanceOf(batchLiquidator.address)).to.eq(ZERO)

        await batchLiquidator.liquidateAndSell(alice, repay, 1, minProfit)

        remainingDebt = debt.add(repay)
        expect((await wavax.balanceOf(batchLiquidator.address)).gt(minProfit)).to.be.true
        expect(await usdc.balanceOf(batchLiquidator.address)).to.eq(repay) // vusd was used to repay but collateral was sold for usdc
        expect(await vusd.balanceOf(batchLiquidator.address)).to.eq(ZERO)
        expect(await marginAccount.margin(0, alice)).to.eq(remainingDebt)
        // console.log(bnToFloat(await marginAccount.margin(1, alice), 18)) // 14.2
        // console.log(bnToFloat(await marginAccount.margin(2, alice), 18)) // 0.32
        // alice is still liquidable
        expect((await marginAccount.isLiquidatable(alice, true))[0]).to.eq(0) // IS_LIQUIDATABLE
    })

    it('liquidateAndSell weth', async function() {
        const debt = await marginAccount.margin(0, alice)
        // console.log({ debt: bnToFloat(debt) }) // -677.404
        expect(await weth.balanceOf(batchLiquidator.address)).to.eq(ZERO)
        const minProfit = repay.div(20).mul(_1e6).div(wethOraclePrice) // / 20 == 5% profit

        // contract has usdc from previous test, it will be used to minted vusd to repay debt in the following call
        await batchLiquidator.liquidateMarginAccount(alice, repay, 2, minProfit)

        remainingDebt = debt.add(repay)
        expect((await weth.balanceOf(batchLiquidator.address)).gt(minProfit)).to.be.true // made a profit
        expect(await usdc.balanceOf(batchLiquidator.address)).to.eq(repay) // we will get usdc back again
        expect(await vusd.balanceOf(batchLiquidator.address)).to.eq(ZERO)
        expect(await marginAccount.margin(0, alice)).to.eq(remainingDebt)
        // console.log(bnToFloat(await marginAccount.margin(1, alice), 18)) // 14.2
        // console.log(bnToFloat(await marginAccount.margin(2, alice), 18)) // 0.1709
        // alice is still liquidable
        expect((await marginAccount.isLiquidatable(alice, true))[0]).to.eq(0) // IS_LIQUIDATABLE
    })

    it('withdraw coins', async function() {
        let [ usdcBal, avaxBal, wethBal ] = await Promise.all([
            usdc.balanceOf(batchLiquidator.address),
            wavax.balanceOf(batchLiquidator.address),
            weth.balanceOf(batchLiquidator.address),
        ])
        expect(usdcBal.gt(ZERO)).to.be.true
        expect(avaxBal.gt(ZERO)).to.be.true
        expect(wethBal.gt(ZERO)).to.be.true
        await batchLiquidator.execute(
            [ usdc.address, wavax.address, weth.address, ],
            [
                usdc.interface.encodeFunctionData('transfer', [alice, usdcBal]),
                wavax.interface.encodeFunctionData('transfer', [alice, avaxBal]),
                weth.interface.encodeFunctionData('transfer', [alice, wethBal]),
            ]
        )

        ;([ usdcBal, avaxBal, wethBal, vusdBal ] = await Promise.all([
            usdc.balanceOf(batchLiquidator.address),
            wavax.balanceOf(batchLiquidator.address),
            weth.balanceOf(batchLiquidator.address),
            vusd.balanceOf(batchLiquidator.address),
        ]))
        const [ usdcBalAlice, avaxBalAlice, wethBalAlice ] = await Promise.all([
            usdc.balanceOf(batchLiquidator.address),
            wavax.balanceOf(batchLiquidator.address),
            weth.balanceOf(batchLiquidator.address),
        ])
        expect(usdcBal).to.eq(ZERO)
        expect(avaxBal).to.eq(ZERO)
        expect(wethBal).to.eq(ZERO)
        expect(vusdBal).to.eq(ZERO)
        expect(usdcBalAlice).to.eq(usdcBal)
        expect(avaxBalAlice).to.eq(avaxBal)
        expect(wethBalAlice).to.eq(wethBal)
    })

    it('liquidateMulti (flashLiquidate)', async function() {
        // repay whole debt
        const debt = await marginAccount.margin(0, alice)
        const avaxRepay = debt.div(4).abs() // trying to repay all debt, causes ABOVE_THRESHOLD in the first liquidation, defeating the purpose of this test
        // we will pay exactly the amount to seize all weth collateral
        const wethRepay = (await marginAccount.margin(2, alice)).mul(wethOraclePrice).div(BigNumber.from(10).pow(16).mul(105))
        // console.log({ debt: bnToFloat(debt), avaxRepay: bnToFloat(avaxRepay), wethRepay: bnToFloat(wethRepay) }) // -451, 112, 250
        const avaxMinProfit = avaxRepay.div(20).mul(_1e6).div(avaxOraclePrice)
        const wethMinProfit = ZERO // repay.div(20).mul(_1e6).div(wethOraclePrice)

        await batchLiquidator.liquidateMulti(alice, [avaxRepay, wethRepay], [1, 2], [avaxMinProfit, wethMinProfit])

        // for debugging
        // await batchLiquidator.liquidateMulti(alice, [avaxRepay], [1], [avaxMinProfit])
        // console.log(bnToFloat(await marginAccount.margin(1, alice), 18))
        // console.log(bnToFloat(await marginAccount.margin(2, alice), 18))
        // console.log(bnToFloat(await marginAccount.margin(0, alice)))


        // await batchLiquidator.liquidateMulti(alice, [wethRepay], [2], [wethMinProfit])
        // console.log(bnToFloat(await marginAccount.margin(1, alice), 18))
        // console.log(bnToFloat(await marginAccount.margin(2, alice), 18))
        // console.log(bnToFloat(await marginAccount.margin(0, alice)))

        expect(await usdc.balanceOf(batchLiquidator.address)).to.eq(ZERO)
        expect(await wavax.balanceOf(batchLiquidator.address)).to.gte(avaxMinProfit)
        expect(await weth.balanceOf(batchLiquidator.address)).to.gte(wethMinProfit)
        expect((await marginAccount.isLiquidatable(alice, true))[0]).to.eq(3) // ABOVE_THRESHOLD
    })

    it('remove margin', async function() {
        // we settle the remaining debt and assert remove margin works as expected
        let [ vusdMargin, wavaxMargin, wethMargin, avaxBalAlice, wethBalAlice ] = await Promise.all([
            marginAccount.margin(0, alice),
            marginAccount.margin(1, alice),
            marginAccount.margin(2, alice),
            wavax.balanceOf(alice),
            weth.balanceOf(alice),
        ])
        vusdMargin = vusdMargin.abs()
        await vusd.connect(admin).mint(alice, vusdMargin)
        await vusd.approve(marginAccount.address, vusdMargin)
        await marginAccount.addMargin(0, vusdMargin)

        await marginAccount.removeMargin(2, wethMargin)

        const avaxBalance = await ethers.provider.getBalance(alice)
        const removeAmount = _1e18.mul(3)
        let tx = await marginAccount.removeAvaxMargin(removeAmount)
        tx = await tx.wait()
        const txFee = tx.cumulativeGasUsed.mul(tx.effectiveGasPrice)

        expect(await ethers.provider.getBalance(alice)).to.eq(avaxBalance.add(removeAmount).sub(txFee))
        expect(await marginAccount.margin(1, alice)).to.eq(wavaxMargin.sub(removeAmount))
        expect(await marginAccount.margin(2, alice)).to.eq(ZERO)
        expect(await wavax.balanceOf(alice)).to.eq(avaxBalAlice) // no change
        expect(await weth.balanceOf(alice)).to.eq(wethBalAlice.add(wethMargin))
    })

    it('flash buy IF auction', async function() {
        // flush batchLiquidator balances
        let [ usdcBal, avaxBal, wethBal ] = await Promise.all([
            usdc.balanceOf(batchLiquidator.address),
            wavax.balanceOf(batchLiquidator.address),
            weth.balanceOf(batchLiquidator.address),
        ])
        await batchLiquidator.execute(
            [ usdc.address, wavax.address, weth.address, ],
            [
                usdc.interface.encodeFunctionData('transfer', [alice, usdcBal]),
                wavax.interface.encodeFunctionData('transfer', [alice, avaxBal]),
                weth.interface.encodeFunctionData('transfer', [alice, wethBal]),
            ]
        )

        // real test starts
        // create bad debt
        await clearingHouse.connect(bob).openPosition2(0, _1e18.mul(10), ethers.constants.MaxUint256)
        await clearingHouse.connect(liquidator1).liquidate2(charlie.address)
        const { spot } = await marginAccount.weightedAndSpotCollateral(charlie.address)
        expect(spot).to.lt(ZERO)

        // settle bad debt
        const tx = await marginAccount.settleBadDebt(charlie.address)
        const auctionTimestamp = (await ethers.provider.getBlock(tx.blockNumber)).timestamp
        // increase time by 15 min
        await network.provider.send('evm_setNextBlockTimestamp', [auctionTimestamp + 900]);

        // arb auction
        const minProfit = _1e18.mul(2)
        const ifAvaxBalance = await wavax.balanceOf(insuranceFund.address)
        await batchLiquidator.arbIFAuction(1, ifAvaxBalance, minProfit)

        expect(await wavax.balanceOf(batchLiquidator.address)).to.gt(minProfit)
        expect(await usdc.balanceOf(batchLiquidator.address)).to.eq(ZERO)
        expect(await vusd.balanceOf(batchLiquidator.address)).to.eq(ZERO)
        expect(await insuranceFund.isAuctionOngoing(wavax.address)).to.eq(false)
        expect(await wavax.balanceOf(insuranceFund.address)).to.eq(ZERO)
    })
})

describe.skip('Atomic liquidations supernova', async function() {
    before(async function() {
        await network.provider.request({
            method: "hardhat_reset",
            params: [{
                forking: {
                    jsonRpcUrl: 'https://api.avax-test.network/ext/bc/C/rpc',
                    blockNumber: 10884594
                }
            }]
        })
        wavax = await ethers.getContractAt('ERC20Mintable', '0x1860619494CdC768949521f488E68da9D10De7E6') // hAVAX
        const BatchLiquidator = await ethers.getContractFactory('BatchLiquidator')
        batchLiquidator = await BatchLiquidator.deploy(
            '0xdAb9110f9ba395f72B6D6eB12F687E0DFBb1fb85', // clearingHouse
            '0x4BFC1482ecbbc0d448920ee471312E28f85ab903', // marginAccount
            '0xaE778F08a9bDA83Dd2143405642885a722aaE190', // vusd
            '0x56F959EB63855c179a9022D53DD547dB1C523fFc', // usdc
            wavax.address,
            '0xd7f655E3376cE2D7A2b08fF01Eb3B1023191A901' // joeRouter
        )
        alice = '0x2eE09408782ea5121A2cEE931793d998cF85CEBE'
        repay = _1e6.mul(100)

        hubbleViewer = await ethers.getContractAt('HubbleViewer', '0x03F075fA17aCc799606F78DB1f17CB0d0f0e2e48')
        marginAccount = await ethers.getContractAt('MarginAccount', '0x4BFC1482ecbbc0d448920ee471312E28f85ab903')
        clearingHouse = await ethers.getContractAt('ClearingHouse', '0xdAb9110f9ba395f72B6D6eB12F687E0DFBb1fb85')
    })

    after(async function() {
        await network.provider.request({
            method: "hardhat_reset",
            params: [],
        });
    })

    it('flash loan and liquidate', async function() {
        // console.log(await marginAccount.weightedAndSpotCollateral(alice))
        const b4 = await hubbleViewer.userInfo(alice)

        // const liquidator = '0x3C4904418a53b22BD1b6aA69694E29d55bdab398'
        // await impersonateAccount(liquidator)
        // await marginAccount.connect(ethers.provider.getSigner(liquidator)).liquidateExactRepay(alice, debt, 1, 0)

        // await batchLiquidator.flashLiquidateWithAvax(alice, debt, 0)
        await batchLiquidator.liquidateMulti(alice, [repay], [1], [0])
        const after = await hubbleViewer.userInfo(alice)

        expect(b4[0].add(repay)).to.eq(after[0])
        expect(await wavax.balanceOf(batchLiquidator.address)).to.gt(ZERO)
        expect(b4[1]).to.gt(after[1])
    })
})
