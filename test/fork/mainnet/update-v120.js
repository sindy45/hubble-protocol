
const { expect } = require('chai')
const { ethers } = require('hardhat')
const fs = require('fs')

const {
    impersonateAccount,
    getTradeDetails,
    setBalance,
    constants: { _1e18, _1e6 }
} = require('../../utils')
const { getVAMMVars, getCHVars } = require('./utils')
const { mainnetConfig: config } = require('../../../scripts/config')

const deployer = '0xF5c8E1eAFFD278A383C13061B4980dB7619479af'
const proxyAdminAddy = '0xddf407237BDe4d36287Be4De79D65c57AefBf8da'
const trader = '0x562574AF66836b1d30e69815bDf0740A7BD7C437' // has open position at block 19525098, uses a referral code
const traderReferrer = '0x08256cF2B4630F995e7c07de4Ba89ba900581F34'
const trader2 = '0xb3d00071ACaE3B256d415DeB44976f244488E931' // doesn't use a referral code

describe('v1.2.0 update', async function() {
    const blockTag = 19702159 // at this block, trader's pending funding is fully settled, which is an assumption for 1 of the tests
    before(async function() {
        await network.provider.request({
            method: "hardhat_reset",
            params: [{
                forking: {
                    jsonRpcUrl: 'https://api.avax.network/ext/bc/C/rpc',
                    blockNumber: blockTag // having a consistent block number speeds up the tests across runs
                }
            }]
        })
        await impersonateAccount(deployer)
        signer = ethers.provider.getSigner(deployer)
        ;([ clearingHouse, marginAccount, amm, proxyAdmin, hubbleViewer, hUSD ] = await Promise.all([
            ethers.getContractAt('ClearingHouse', config.contracts.ClearingHouse),
            ethers.getContractAt('MarginAccount', config.contracts.MarginAccount),
            ethers.getContractAt('AMM', config.contracts.amms[0].address),
            ethers.getContractAt('ProxyAdmin', proxyAdminAddy),
            ethers.getContractAt('HubbleViewer', config.contracts.HubbleViewer_0),
            ethers.getContractAt('VUSD', config.contracts.collateral[0].address)
        ]))
    })

    after(async function() {
        await network.provider.request({
            method: "hardhat_reset",
            params: [],
        });
    })

    // was used for v1.1.0 upgrade, not required for v1.2.0
    it.skip('update AMM', async function() {
        const vars1 = await getAMMVars(amm, trader)

        const AMM = await ethers.getContractFactory('AMM')
        const newAMM = await AMM.deploy(config.contracts.ClearingHouse, 86400)
        await proxyAdmin.connect(signer).upgrade(config.contracts.amms[0].address, newAMM.address)

        const vars2 = await getAMMVars(amm, trader)
        expect(vars2).to.deep.equal(vars1)
    })

    it('update vAMM fee', async function() {
        vammAbiAndBytecode = fs.readFileSync('contracts/curve-v2/Swap.txt').toString().split('\n').filter(Boolean)
        Swap = new ethers.ContractFactory(JSON.parse(vammAbiAndBytecode[0]), vammAbiAndBytecode[1], signer)
        vamm = Swap.attach(config.contracts.amms[0].vamm)
        const vars1 = await getVAMMVars(vamm)
        const gasLimit = 1e6
        expect((await vamm.mid_fee({gasLimit})).toString()).to.eq('5000000')

        const newVAMM = await Swap.deploy()
        await proxyAdmin.connect(signer).upgrade(config.contracts.amms[0].vamm, newVAMM.address)
        const newFee = '7500000' // 7.5 bps
        await vamm.setNewParameters(newFee)

        const vars2 = await getVAMMVars(vamm)
        expect(vars2).to.deep.equal(vars1)
        expect((await vamm.mid_fee({gasLimit})).toString()).to.eq(newFee)
    })

    it('update ClearingHouse', async function() {
        await clearingHouse.connect(signer).setParams(
            100000, // maintenanceMargin
            200000, // minAllowableMargin
            250, // tradeFee
            50000, // liquidationPenalty
            50, // referralShare
            100 // tradingFeeDiscount
        )
        const vars1 = await getCHVars(clearingHouse)
        const ClearingHouse = await ethers.getContractFactory('ClearingHouse')
        const newClearingHouse = await ClearingHouse.deploy('0xEd27FB82DAb4c5384B38aEe8d0Ab81B3b591C0FA') // trustedForwarder
        await proxyAdmin.connect(signer).upgrade(config.contracts.ClearingHouse, newClearingHouse.address)

        const vars2 = await getCHVars(clearingHouse)
        expect(vars2).to.deep.equal(vars1)
    })

    it('trade with referral', async function() {
        const ifBal = await hUSD.balanceOf(config.contracts.InsuranceFund)
        const referredHusdBal = await marginAccount.margin(0, traderReferrer)
        const traderHusdBal = await marginAccount.margin(0, trader)

        await impersonateAccount(trader) // has a 200 short
        const alice = ethers.provider.getSigner(trader)
        const base = _1e18.mul(-10) // so that there's no realized pnl
        const { quoteAsset } = await getTradeDetails(await clearingHouse.connect(alice).openPosition(0, base, 0))
        const discount = quoteAsset.mul(100).div(_1e6)
        const ifFee = quoteAsset.mul(250).div(_1e6).sub(discount)
        const referrerFee = quoteAsset.mul(50).div(_1e6)
        expect(await hUSD.balanceOf(config.contracts.InsuranceFund)).to.eq(ifBal.add(ifFee.sub(referrerFee)))
        expect(await marginAccount.margin(0, traderReferrer)).to.eq(referredHusdBal.add(referrerFee))
        expect(await marginAccount.margin(0, trader)).to.eq(traderHusdBal.sub(ifFee))
    })

    it('trade without referral', async function() {
        const ifBal = await hUSD.balanceOf(config.contracts.InsuranceFund)
        const traderHusdBal = await marginAccount.margin(0, trader2)

        await impersonateAccount(trader2)
        const alice = ethers.provider.getSigner(trader2)
        await setBalance(trader2, '0x8AC7230489E80000') // 10 avax to pay for gas fee
        const base = _1e18.mul(5)
        const { quoteAsset } = await getTradeDetails(await clearingHouse.connect(alice).openPosition(0, base, _1e18))
        const ifFee = quoteAsset.mul(250).div(_1e6)
        expect(await hUSD.balanceOf(config.contracts.InsuranceFund)).to.eq(ifBal.add(ifFee))
        expect(await marginAccount.margin(0, trader2)).to.eq(traderHusdBal.sub(ifFee))
    })

    it('addLiquidity', async function() {
        const base = _1e18.mul(50)
        const alice = ethers.provider.getSigner(trader)
        const { dToken } = await hubbleViewer.getMakerQuote(0, base, true, true)
        await clearingHouse.connect(alice).addLiquidity(0, base, dToken)
    })
})
