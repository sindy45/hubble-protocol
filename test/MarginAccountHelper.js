const { expect } = require('chai');
const { BigNumber } = require('ethers')

const {
    setupContracts,
    calcGasPaid,
    gotoNextIFUnbondEpoch,
    impersonateAccount,
    stopImpersonateAccount,
    forkCChain,
    setBalance,
    constants: { _1e6, _1e12, ZERO, _1e18 }
} = require('./utils')

const avaxForkBlock = 32461637
const {
    setupAvaxContracts,
    cchainId,
    ZERO_ADDRESS,
} = require('./bridge/bridgeUtils')

const emptyAddressCchain = '0x19ae07eEc761427c8659cc5E62bd8673b39aEaf5' // 0 token balance
const USDCRichAddressAvax = '0x9f8c163cBA728e99993ABe7495F06c0A3c8Ac8b9'


describe('Margin Account Helper Tests', function() {
    before('contract factories', async function() {
        signers = await ethers.getSigners()
        alice = signers[0].address
        ;({ marginAccount, marginAccountHelper, insuranceFund } = await setupContracts())
        initialHgtBalance = _1e18.mul(10000)
        await setBalance(alice, initialHgtBalance.toHexString().replace(/0x0+/, "0x"))
        gasPaid = ZERO
    })

    it('addVUSDMarginWithReserve', async () => {
        margin = _1e6.mul(2000)
        const tx = await marginAccountHelper.addVUSDMarginWithReserve(margin, alice, { value: _1e12.mul(margin) })
        gasPaid = gasPaid.add(await calcGasPaid(tx))

        expect(await marginAccount.margin(0, alice)).to.eq(margin)
        expect(await marginAccount.getNormalizedMargin(alice)).to.eq(margin)
        expect(await ethers.provider.getBalance(alice)).to.eq(initialHgtBalance.sub(_1e12.mul(margin)).sub(gasPaid))
        expect(await vusd.balanceOf(alice)).to.eq(ZERO)
        expect(await vusd.balanceOf(marginAccountHelper.address)).to.eq(ZERO)
    })

    it('removeMarginInUSD', async () => {
        const tx = await marginAccountHelper.removeMarginInUSD(margin)
        gasPaid = gasPaid.add(await calcGasPaid(tx))

        expect(await marginAccount.margin(0, alice)).to.eq(ZERO)
        expect(await marginAccount.getNormalizedMargin(alice)).to.eq(ZERO)
        expect(await ethers.provider.getBalance(alice)).to.eq(initialHgtBalance.sub(gasPaid))
        expect(await vusd.balanceOf(alice)).to.eq(ZERO)
        expect(await vusd.balanceOf(marginAccountHelper.address)).to.eq(ZERO)
    })

    it('depositToInsuranceFund', async () => {
        deposit = _1e6.mul(2000)
        const tx = await marginAccountHelper.depositToInsuranceFund(deposit, alice, { value: _1e12.mul(deposit) })
        gasPaid = gasPaid.add(await calcGasPaid(tx))

        expect(await ethers.provider.getBalance(alice)).to.eq(initialHgtBalance.sub(_1e12.mul(deposit)).sub(gasPaid))
        expect(await insuranceFund.balanceOf(alice)).to.eq(deposit)
        expect(await vusd.balanceOf(insuranceFund.address)).to.eq(deposit)
        expect(await vusd.balanceOf(alice)).to.eq(ZERO)
        expect(await vusd.balanceOf(marginAccountHelper.address)).to.eq(ZERO)
    })

    it('withdrawFromInsuranceFund', async () => {
        await expect(
            marginAccountHelper.estimateGas.withdrawFromInsuranceFund(deposit)
        ).to.be.revertedWith('withdrawing_more_than_unbond')

        let tx = await insuranceFund.unbondShares(deposit)
        gasPaid = gasPaid.add(await calcGasPaid(tx))

        await expect(
            marginAccountHelper.estimateGas.withdrawFromInsuranceFund(deposit)
        ).to.be.revertedWith('still_unbonding')

        await gotoNextIFUnbondEpoch(insuranceFund, alice)
        tx = await marginAccountHelper.withdrawFromInsuranceFund(deposit)
        gasPaid = gasPaid.add(await calcGasPaid(tx))

        expect(await ethers.provider.getBalance(alice)).to.eq(initialHgtBalance.sub(gasPaid))
        expect(await insuranceFund.balanceOf(alice)).to.eq(ZERO)
        expect(await vusd.balanceOf(insuranceFund.address)).to.eq(ZERO)
        expect(await vusd.balanceOf(alice)).to.eq(ZERO)
        expect(await vusd.balanceOf(marginAccountHelper.address)).to.eq(ZERO)
    })
})


describe('Multi-chain withdrawals from margin/IF', async function () {
    describe('Withdraw to cchain', async function () {
        before(async function () {
            signers = await ethers.getSigners()
            ;([, alice ] = signers.map((s) => s.address))
            await forkCChain(avaxForkBlock) // Fork Avalanche
            bob = await ethers.provider.getSigner(emptyAddressCchain)
            // deploy protocol contracts
            ;({ marginAccountHelper, proxyAdmin, insuranceFund } = await setupContracts({ mockOrderBook: false, testClearingHouse: false }))
            // deploy bridge contracts
            contracts = await setupAvaxContracts(proxyAdmin.address, marginAccountHelper.address)
            ;({ usdcAvaxInstance, hgtRemote, hgt, avaxPriceFeed, lzEndpointMockRemote, lzEndpointMockBase, usdcPriceFeed } = contracts)

            // fund hgt with 1m gas token
            hgtBalance = ethers.utils.hexStripZeros(_1e18.mul(_1e6))
            await setBalance(hgt.address, hgtBalance)
            hgtBalance = BigNumber.from(hgtBalance) // converted to BigNumber

            // fund hgtRemote with 100 avax to pay for gas
            hgtRemoteBalance = ethers.utils.hexStripZeros(_1e18.mul(100))
            await setBalance(hgtRemote.address, hgtRemoteBalance)
            hgtRemoteBalance = BigNumber.from(hgtRemoteBalance) // converted to BigNumber
        })

        after(async function() {
            await network.provider.request({
                method: "hardhat_reset",
                params: [],
            });
        })

        it('deposit margin to bob\'s account', async () => {
            depositAmount = _1e6.mul(1000) // 1000 usdc
            usdcWhale = await ethers.provider.getSigner(USDCRichAddressAvax)
            await impersonateAccount(usdcWhale._address)
            await usdcAvaxInstance.connect(usdcWhale).approve(hgtRemote.address, depositAmount)

            adapterParams = ethers.utils.solidityPack(
                ['uint16', 'uint'],
                [1, _1e6] // adapter param - version and gasAmount (constant gas amount to charge for destination chain tx)
            )
            toGas = depositAmount.div(10) // deposit 10% as gas token
            const depositVars = {
                to: bob._address,
                tokenIdx: 0,
                amount: depositAmount,
                toGas: toGas,
                isInsuranceFund: false,
                refundAddress: usdcWhale._address,
                zroPaymentAddress: ZERO_ADDRESS,
                adapterParams: adapterParams
            }
            const l0Fee = await hgtRemote.estimateSendFee(depositVars)
            await hgtRemote.connect(usdcWhale).deposit(depositVars, { value: l0Fee[0] })
            await stopImpersonateAccount(usdcWhale._address)

            expect(await ethers.provider.getBalance(bob._address)).to.eq(toGas.mul(_1e12))
            expect(await marginAccount.margin(0, bob._address)).to.eq(depositAmount.sub(toGas))
            expect(await usdcAvaxInstance.balanceOf(alice)).to.eq(ZERO)
            expect(await usdcAvaxInstance.balanceOf(bob._address)).to.eq(ZERO)
            expect(await usdcAvaxInstance.balanceOf(hgtRemote.address)).to.eq(depositAmount)
        })

        // withdraw margin hubbleNet -> cchain
        it('Withdraw margin using direct bridge', async () => {
            // bob withdraws funds to alice account
            let withdrawAmount = await marginAccount.margin(0, bob._address) // withdraw all
            const withdrawVars = {
                dstChainId: cchainId,
                secondHopChainId: 0,
                dstPoolId: 0,
                to: alice,
                tokenIdx: 0,
                amount: withdrawAmount,
                amountMin: withdrawAmount,
                refundAddress: bob._address,
                zroPaymentAddress: ZERO_ADDRESS,
                adapterParams
            }

            await impersonateAccount(bob._address)
            const l0Fee = await hgt.estimateSendFee(withdrawVars)
            await marginAccountHelper.connect(bob).withdrawMarginToChain(alice, withdrawAmount, 0, cchainId, 0, withdrawAmount, 0, adapterParams, { value: l0Fee[0] })

            // assert on hubbleNet
            expect(await marginAccount.margin(0, bob._address)).to.eq(ZERO)
            expect(await ethers.provider.getBalance(marginAccountHelper.address)).to.eq(ZERO)

            // assert on cchain
            expect(await usdcAvaxInstance.balanceOf(alice)).to.eq(withdrawAmount)
            expect(await usdcAvaxInstance.balanceOf(hgtRemote.address)).to.eq(depositAmount.sub(withdrawAmount))
        })

        it('bob deposits to insurace fund', async () => {
            depositAmount = _1e6.mul(1000) // 1000 usdc
            await impersonateAccount(usdcWhale._address)
            await usdcAvaxInstance.connect(usdcWhale).approve(hgtRemote.address, depositAmount)

            const depositVars = {
                to: bob._address,
                tokenIdx: 0,
                amount: depositAmount,
                toGas: ZERO,
                isInsuranceFund: true,
                refundAddress: usdcWhale._address,
                zroPaymentAddress: ZERO_ADDRESS,
                adapterParams: adapterParams
            }
            const l0Fee = await hgtRemote.estimateSendFee(depositVars)
            await hgtRemote.connect(usdcWhale).deposit(depositVars, { value: l0Fee[0] })
            await stopImpersonateAccount(usdcWhale._address)

            expect(await insuranceFund.balanceOf(bob._address)).to.eq(depositAmount)
            expect(await marginAccount.margin(0, bob._address)).to.eq(ZERO)
            expect(await usdcAvaxInstance.balanceOf(bob._address)).to.eq(ZERO)
        })

        it('bob withdraws from insurance fund', async () => {
            let withdrawAmount = depositAmount
            const withdrawVars = {
                dstChainId: cchainId,
                secondHopChainId: 0,
                dstPoolId: 0,
                to: alice,
                tokenIdx: 0,
                amount: withdrawAmount,
                amountMin: withdrawAmount,
                refundAddress: bob._address,
                zroPaymentAddress: ZERO_ADDRESS,
                adapterParams
            }

            await impersonateAccount(bob._address)
            // unbond shares
            await insuranceFund.connect(bob).unbondShares(depositAmount)
            await gotoNextIFUnbondEpoch(insuranceFund, bob._address)

            const l0Fee = await hgt.estimateSendFee(withdrawVars)
            await marginAccountHelper.connect(bob).withdrawFromInsuranceFundToChain(bob._address, withdrawAmount, cchainId, 0, withdrawAmount, 0, adapterParams, { value: l0Fee[0] })

            // assert on hubbleNet
            expect(await insuranceFund.balanceOf(bob._address)).to.eq(ZERO)
            expect(await marginAccount.margin(0, bob._address)).to.eq(ZERO)
            expect(await ethers.provider.getBalance(marginAccountHelper.address)).to.eq(ZERO)

            // assert on cchain
            expect(await usdcAvaxInstance.balanceOf(bob._address)).to.eq(withdrawAmount)
        })
    })
})
