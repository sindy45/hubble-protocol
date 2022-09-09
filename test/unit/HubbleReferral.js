const { expect } = require('chai')
const utils = require('../utils')
const {
    setupContracts,
    addMargin,
    getTradeDetails
} = utils
const { constants: { _1e6, ZERO, _1e18 } } = utils
const TRADE_FEE = 0.000567 * _1e6

describe('HubbleReferral Unit Tests', function() {
    before('factories', async function() {
        signers = await ethers.getSigners()
        alice = signers[0].address
        ;([ bob, charlie ] = signers.slice(1))
        ;({ hubbleReferral, clearingHouse, marginAccount, vusd, insuranceFund } = await setupContracts({ tradeFee: TRADE_FEE }))
    })

    it('create referral code', async function() {
        await expect(hubbleReferral.createReferralCode('xyz')).to.be.revertedWith('HR: referral code too short')
        referralCode = 'aliceReferral'
        await hubbleReferral.createReferralCode(referralCode)
        expect(await hubbleReferral.getReferralCodeByAddress(alice)).to.eq(referralCode)
    })

    it('two referrers cannot have same referral code', async function() {
        await expect(hubbleReferral.connect(bob).createReferralCode(
            'aliceReferral')).to.be.revertedWith('HR: referral code already exists')
    })

    it('referrer cannot update referral code once set', async function() {
        await expect(hubbleReferral.createReferralCode('xyzt')).to.be.revertedWith(
            'HR: referral code already exists for this address'
        )
    })

    it('trader sets referral code', async function() {
        await expect(hubbleReferral.connect(bob).setReferralCode('xyz')).to.be.revertedWith(
            'HR: referral code too short'
        )
        await expect(hubbleReferral.connect(bob).setReferralCode('xyzt')).to.be.revertedWith(
            'HR: referral code does not exist'
        )
        await hubbleReferral.connect(bob).setReferralCode(referralCode)
        expect(await hubbleReferral.getTraderRefereeInfo(bob.address)).to.eq(alice)
    })

    it('cannot update referral code once set', async function() {
        const testReferral = 'testReferral'
        await hubbleReferral.connect(charlie).createReferralCode(testReferral)
        await expect(hubbleReferral.connect(bob).setReferralCode(testReferral)).to.be.revertedWith(
            'HR: referrer already added'
        )
        // cannot set their own referral code
        await expect(hubbleReferral.setReferralCode(referralCode)).to.be.revertedWith(
            'HR: cannot be a referee of a referral code you own'
        )
    })

    it('referrer and trader referral benefits', async function() {
        // add margin
        const margin = _1e6.mul(2000)
        await addMargin(bob, margin)
        const baseAssetQuantity = _1e18.mul(-5)

        expect(await marginAccount.getNormalizedMargin(alice)).to.eq(ZERO)
        const tx = await clearingHouse.connect(bob).openPosition(0, baseAssetQuantity, 0)
        ;({ quoteAsset, fee } = await getTradeDetails(tx, TRADE_FEE))
        // 10% of the the tradeFee is added to the margin of the referrer
        const referralBonus = quoteAsset.mul(50).div(_1e6)
        expect(await marginAccount.getNormalizedMargin(alice)).to.eq(referralBonus)
        // trader gets 5% a fee discount
        const discount = quoteAsset.mul(100).div(_1e6)
        const feeAfterDiscount = fee.sub(discount)
        expect(await marginAccount.getNormalizedMargin(bob.address)).to.eq(
            margin.sub(feeAfterDiscount))
        // insurance fund gets the remaining fee
        expect(await vusd.balanceOf(insuranceFund.address)).to.eq(feeAfterDiscount.sub(referralBonus))
    })
})
