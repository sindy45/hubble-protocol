const { expect } = require('chai')
const { ethers } = require('hardhat')
const { BigNumber } = require('ethers')
const { parseEther } = require('ethers/lib/utils')
const utils = require('../utils')

const lzChainIdForEthMainnet = 101
const lzChainIdForCchain = 106
const srcPoolIdForUSDCMainnet = 1
const avaxForkBlock = 32461637
const ethForkBlock = 17675415
const { constants: { _1e6, _1e12, _1e18, ZERO } } = utils

const {
    setupAvaxContracts,
    hubbleChainId,
    cchainId,
    ZERO_ADDRESS,
} = require('./bridgeUtils')

const MainnetStargateRouter = '0x8731d54E9D02c286767d56ac03e8037C07e01e98'
const MainnetStargateUSDCPool = '0xdf0770dF86a8034b3EFEf0A1Bb3c889B8332FF56'
const UsdcMainnet = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const UsdcWhaleMainnet = '0x79E2Ba942B0e8fDB6ff3d406e930289d10B49ADe' // for impersonate
const ETHStargateBridge = '0x296F55F8Fb28E498B858d0BcDA06D955B2Cb3f97'

const emptyAddressCchain = '0x19ae07eEc761427c8659cc5E62bd8673b39aEaf5' // 0 token balance
const USDCRichAddressAvax = '0x9f8c163cBA728e99993ABe7495F06c0A3c8Ac8b9'


describe('Multi-chain Deposits', async function () {

    // Deposit Hop1: anyEvmChain -> cchain
    describe('Deposit Hop1 using stargate', async function () {
        before(async function () {
            signers = await ethers.getSigners()
            ;[ alice, bob ] = signers.map((s) => s.address)
            await utils.forkNetwork('mainnet', ethForkBlock) // Fork Mainnet
            await utils.impersonateAccount(UsdcWhaleMainnet)
            usdcWhaleMainnet = await ethers.provider.getSigner(UsdcWhaleMainnet)
            ;([stargateRouter, stargateBridge, stargateUSDCPool, usdcMainnetInstnace] = await Promise.all([
                ethers.getContractAt('IStargateRouter', MainnetStargateRouter),
                ethers.getContractAt('IStarGateBridge', ETHStargateBridge),
                ethers.getContractAt('IStarGatePool', MainnetStargateUSDCPool),
                ethers.getContractAt('IERC20', UsdcMainnet),
            ]))

            adapterParams = ethers.utils.solidityPack(
                ['uint16', 'uint'],
                [1, _1e6] // adapter param - version and gasAmount (constant gas amount to charge for destination chain tx)
            )
        })

        after(async function() {
            await network.provider.request({
                method: "hardhat_reset",
                params: [],
            });
        })

        it('deposit using stargate for hop1', async () => {
            const depositAmount = _1e6.mul(2000) // 2000 usdc
            let [ sgPayload,, ] = buildDepositPayload(
                alice, bob, 0, depositAmount, 0 /** toGas */, false /* isInsuranceFund */, ZERO_ADDRESS, adapterParams
            )

            let l0Fee = await stargateRouter.quoteLayerZeroFee(
                lzChainIdForCchain,
                1, // function type: see Bridge.sol for all types
                ethers.utils.solidityPack(['address'], [ bob ]), // destination of tokens, random address for this test
                sgPayload,
                { dstGasForCall: 0, dstNativeAmount: 0, dstNativeAddr: '0x', }
            )

            const usdcBalBefore = await usdcMainnetInstnace.balanceOf(usdcWhaleMainnet._address)

            await usdcMainnetInstnace.connect(usdcWhaleMainnet).approve(stargateRouter.address, depositAmount)
            await expect(stargateRouter.connect(usdcWhaleMainnet).swap(
                lzChainIdForCchain,
                srcPoolIdForUSDCMainnet,
                1, // destPoolIdForUSDCAvax
                usdcWhaleMainnet._address,
                depositAmount,
                0,
                { dstGasForCall: 0, dstNativeAmount: 0, dstNativeAddr: '0x' },
                ethers.utils.solidityPack(['address'], [ bob ]),
                sgPayload,
                { value: l0Fee[0] }
            ))
            .to.emit(stargateUSDCPool, 'Swap')
            .to.emit(stargateUSDCPool, 'SendCredits')
            .to.emit(stargateBridge, 'SendMsg')

            const usdcBalAfter = await usdcMainnetInstnace.balanceOf(usdcWhaleMainnet._address)
            expect(depositAmount).to.eq(usdcBalBefore.sub(usdcBalAfter))
        })
    })

    // Deposit Hop2: stargate -> cchain -> hubbleNet
    describe('Deposit Hop2 using stargate and layerZero', async function () {
        before(async function () {
            signers = await ethers.getSigners()
            ;([, alice ] = signers.map((s) => s.address))
            await utils.forkCChain(avaxForkBlock) // Fork Avalanche
            bob = emptyAddressCchain;
            // deploy protocol contracts
            ;({ marginAccountHelper, proxyAdmin } = await utils.setupContracts({ mockOrderBook: false, testClearingHouse: false }))
            // deploy bridge contracts
            contracts = await setupAvaxContracts(proxyAdmin.address, marginAccountHelper.address)
            ;({ usdcAvaxInstance, hgtRemote, hgt, avaxPriceFeed, lzEndpointMockRemote, usdcPriceFeed } = contracts)

            // fund hgt with 1m gas token
            hgtBalance = ethers.utils.hexStripZeros(_1e18.mul(_1e6))
            await utils.setBalance(hgt.address, hgtBalance)
            hgtBalance = BigNumber.from(hgtBalance) // converted to BigNumber

            // fund hgtRemote with 100 avax to pay for gas
            hgtRemoteBalance = ethers.utils.hexStripZeros(_1e18.mul(100))
            await utils.setBalance(hgtRemote.address, hgtRemoteBalance)
            hgtRemoteBalance = BigNumber.from(hgtRemoteBalance) // converted to BigNumber

            depositAmount = _1e6.mul(1000) // 1000 usdc
            // simulate funds received from stargate to hgtRemote
            usdcWhale = await ethers.provider.getSigner(USDCRichAddressAvax)
            await utils.impersonateAccount(USDCRichAddressAvax)
            await usdcAvaxInstance.connect(usdcWhale).transfer( hgtRemote.address, depositAmount)
            // whitelist signer[0] as relayer
            await hgtRemote.setWhitelistRelayer(signers[0].address, true)
            aliceInitialBalance = await ethers.provider.getBalance(alice)

            adapterParams = ethers.utils.solidityPack(
                ['uint16', 'uint'],
                [1, _1e6] // adapter param - version and gasAmount (constant gas amount to charge for destination chain tx)
                // @todo need to find optimal gasAmount
            )
        })

        after(async function() {
            await network.provider.request({
                method: "hardhat_reset",
                params: [],
            });
        })

        it('alice deposits margin and gas token to bob\'s account using sg', async () => {
            const toGas = depositAmount.div(2)

            let [ sgPayload, lzPayload ] = buildDepositPayload(
                alice, bob, 0, depositAmount, toGas, false /* isInsuranceFund */, ZERO_ADDRESS, adapterParams
            )

            const nativeFee = await lzEndpointMockRemote.estimateFees(hubbleChainId, hgtRemote.address, lzPayload, false, adapterParams)

            // get avax and usdc price
            let latestAnswer = await avaxPriceFeed.latestRoundData()
            const avaxPrice = latestAnswer[1].div(100)
            latestAnswer = await usdcPriceFeed.latestRoundData()
            const usdcPrice = latestAnswer[1].div(100)
            const l0Fee = nativeFee[0].mul(avaxPrice).div(usdcPrice).div(_1e12)
            actualDepositAmount = depositAmount.sub(l0Fee)

            ;([, lzPayload, metadata] = buildDepositPayload(
                alice, bob, 0, actualDepositAmount, toGas, false /* isInsuranceFund */, ZERO_ADDRESS, adapterParams
            ))

            await expect(
                hgtRemote.sgReceive(
                    lzChainIdForEthMainnet,
                    ETHStargateBridge,
                    1,
                    usdcAvaxInstance.address,
                    depositAmount,
                    sgPayload
                )
            )
            .to.emit(hgtRemote, 'ReceivedFromStargate').withArgs(lzChainIdForEthMainnet, 1, usdcAvaxInstance.address, depositAmount, sgPayload)
            .to.emit(hgtRemote, 'SendToChain').withArgs(hubbleChainId, 1, lzPayload)
            .to.emit(hgt, 'ReceiveFromChain').withArgs(cchainId, bob, 0, actualDepositAmount, metadata, 1)

            // hubbleNet assertions
            // margin and gas token should be deposited to bob's account
            expect(await marginAccount.margin(0, bob)).to.eq(actualDepositAmount.sub(toGas))
            expect(await ethers.provider.getBalance(bob)).to.eq(toGas.mul(_1e12))
            expect(await usdcAvaxInstance.balanceOf(bob)).to.eq(ZERO)
            // no change in alice's balance
            expect(await marginAccount.margin(0, alice)).to.eq(ZERO)
            expect(await ethers.provider.getBalance(alice)).to.eq(aliceInitialBalance)
            expect(await usdcAvaxInstance.balanceOf(alice)).to.eq(ZERO)
            // hgt assertions
            expect(await ethers.provider.getBalance(hgt.address)).to.eq(hgtBalance.sub(actualDepositAmount.mul(_1e12)))
            expect(await hgt.circulatingSupply(0)).to.eq(actualDepositAmount.mul(_1e12))
            // hgtRemote assertions
            expect(await ethers.provider.getBalance(hgtRemote.address)).to.eq(hgtRemoteBalance.sub(nativeFee[0]))
            expect(await usdcAvaxInstance.balanceOf(hgtRemote.address)).to.eq(depositAmount)
            expect(await hgtRemote.feeCollected(0)).to.eq(l0Fee)
        })

        it('deposit hop2 fails due to higher l0 fee than deposited amount', async function () {
            smallAmount = _1e6.div(100)
            await usdcAvaxInstance.connect(usdcWhale).transfer( hgtRemote.address, smallAmount)
            let [ sgPayload, ] = buildDepositPayload(
                alice, bob, 0, smallAmount, 0, false, ZERO_ADDRESS, adapterParams
            )

            await expect(
                hgtRemote.sgReceive(
                    lzChainIdForEthMainnet,
                    ETHStargateBridge,
                    1,
                    usdcAvaxInstance.address,
                    smallAmount,
                    sgPayload
                )
            )
            .to.emit(hgtRemote, 'ReceivedFromStargate').withArgs(lzChainIdForEthMainnet, 1, usdcAvaxInstance.address, smallAmount, sgPayload)
            .to.emit(hgtRemote, 'DepositSecondHopFailure').withArgs(lzChainIdForEthMainnet, 1, bob, usdcAvaxInstance.address, smallAmount)

            expect(await hgtRemote.rescueFunds(usdcAvaxInstance.address, bob)).to.eq(smallAmount)
            expect(await usdcAvaxInstance.balanceOf(bob)).to.eq(ZERO)
            expect(await usdcAvaxInstance.balanceOf(alice)).to.eq(ZERO)
            expect(await usdcAvaxInstance.balanceOf(hgtRemote.address)).to.eq(depositAmount.add(smallAmount))
            // no change on hgt side
            expect(await ethers.provider.getBalance(hgt.address)).to.eq(hgtBalance.sub(actualDepositAmount.mul(_1e12)))
            expect(await hgt.circulatingSupply(0)).to.eq(actualDepositAmount.mul(_1e12))
        })

        it('deposit hop2 fails because of lz tx fail', async function () {
            await usdcAvaxInstance.connect(usdcWhale).transfer( hgtRemote.address, depositAmount)
            ;([ sgPayload, ] = buildDepositPayload(
                alice, bob, 0, depositAmount, 0, false, ZERO_ADDRESS, adapterParams
            ))
            // set hgtRemote gas balance very low to simulate lz tx fail
            await utils.setBalance(hgtRemote.address, ethers.utils.hexStripZeros(_1e6))

            await expect(
                hgtRemote.sgReceive(
                    lzChainIdForEthMainnet,
                    ETHStargateBridge,
                    1,
                    usdcAvaxInstance.address,
                    depositAmount,
                    sgPayload
                )
            )
            .to.emit(hgtRemote, 'ReceivedFromStargate').withArgs(lzChainIdForEthMainnet, 1, usdcAvaxInstance.address, depositAmount, sgPayload)
            .to.emit(hgtRemote, 'DepositSecondHopFailure').withArgs(lzChainIdForEthMainnet, 1, bob, usdcAvaxInstance.address, depositAmount)

            expect(await hgtRemote.rescueFunds(usdcAvaxInstance.address, bob)).to.eq(smallAmount.add(depositAmount))
            expect(await usdcAvaxInstance.balanceOf(bob)).to.eq(ZERO)
            expect(await usdcAvaxInstance.balanceOf(alice)).to.eq(ZERO)
            expect(await usdcAvaxInstance.balanceOf(hgtRemote.address)).to.eq(depositAmount.mul(2).add(smallAmount))
            // no change on hgt side
            expect(await ethers.provider.getBalance(hgt.address)).to.eq(hgtBalance.sub(actualDepositAmount.mul(_1e12)))
            expect(await hgt.circulatingSupply(0)).to.eq(actualDepositAmount.mul(_1e12))
        })

        it('Rescue funds', async function () {
            totalAmountToRescue = depositAmount.add(smallAmount)
            bob = ethers.provider.getSigner(bob)
            await utils.impersonateAccount(bob._address)
            // revert if amount rescuing is more than deposited
            await expect(
                hgtRemote.connect(bob).rescueMyFunds(usdcAvaxInstance.address, totalAmountToRescue.add(1))
            ).to.be.revertedWith('HGTRemote: Insufficient pending funds')

            // revert if not called by token owner
            await expect(
                hgtRemote.rescueMyFunds(usdcAvaxInstance.address, totalAmountToRescue)
            ).to.be.revertedWith('HGTRemote: Insufficient pending funds')

            // rescue funds
            await hgtRemote.connect(bob).rescueMyFunds(usdcAvaxInstance.address, totalAmountToRescue)
            expect(await usdcAvaxInstance.balanceOf(bob._address)).to.eq(totalAmountToRescue)
            expect(await usdcAvaxInstance.balanceOf(hgtRemote.address)).to.eq(depositAmount)
            expect(await hgtRemote.rescueFunds(usdcAvaxInstance.address, bob._address)).to.eq(ZERO)
        })

        it('setWhitelistRelayer', async () => {
            await expect(hgtRemote.connect(signers[1]).setWhitelistRelayer(alice, true)).to.be.revertedWith('Ownable: caller is not the owner')
            await hgtRemote.setWhitelistRelayer(alice, true)
            let isWhiteList = await hgtRemote.whitelistedRelayer(alice)
            expect(isWhiteList).to.eq(true)
            await hgtRemote.setWhitelistRelayer(alice, false)
            isWhiteList = await hgtRemote.whitelistedRelayer(alice)
            expect(isWhiteList).to.eq(false)
        })

        it('setStargateConfig', async () => {
            const testStargateAddress = lzEndpointMockRemote.address
            await expect(hgtRemote.connect(signers[1]).setStargateConfig(testStargateAddress)).to.be.revertedWith('Ownable: caller is not the owner')
            await hgtRemote.setStargateConfig(testStargateAddress)
            const stargateAddress = await hgtRemote.stargateRouter()
            expect(stargateAddress).to.eq(testStargateAddress)
        })

        it('sendLzMsg revert because of onlyMyself', async () => {
            await expect(hgtRemote.sendLzMsg(
                {
                    to: alice,
                    tokenIdx: 0,
                    amount: depositAmount,
                    toGas: BigNumber.from('0'),
                    isInsuranceFund: false,
                    refundAddress: alice,
                    zroPaymentAddress: ZERO_ADDRESS,
                    adapterParams: '0x',
                },
                metadata,
                parseEther('0.1')
            )).to.be.revertedWith('Only myself')
        })

        it('sgReceive revert because of wrong token address', async () => {
            await expect(hgtRemote.sgReceive(
                1,
                '0x',
                0,
                UsdcMainnet, /** Invalid usdc token(rightTokenAddress: usdcAvax) */
                depositAmount,
                sgPayload
            )).to.be.revertedWith('HGTRemote: token mismatch')
        })
    })
})


function buildDepositPayload(from, to, tokenIdx, amount, toGas, isInsuranceFund, zroPaymentAddress, adapterParams) {
    const abi = ethers.utils.defaultAbiCoder
    const sgPayload = abi.encode(
        [ 'address', 'address', 'uint256', 'uint256', 'uint256', 'bool', 'address', 'bytes' ],
        [ from, to, tokenIdx, amount, toGas, isInsuranceFund, zroPaymentAddress, adapterParams ]
    )

    const metadata = abi.encode([ 'uint256', 'bool' ], [ toGas, isInsuranceFund ])
    const lzPayload = abi.encode(
        [ 'uint256', 'address', 'uint256', 'uint256', 'bytes' ],
        [ 1 /**PT_SEND */, to, tokenIdx, amount, metadata ]
    )
    return [ sgPayload, lzPayload, metadata ]
}
