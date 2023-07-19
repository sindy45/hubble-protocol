const { expect } = require('chai')
const { MerkleTree } = require('merkletreejs')
const keccak256 = require('keccak256')

const utils = require('../utils')
const {
    setupContracts,
    addMargin,
    getTradeDetails,
    signTransaction
} = utils
const { constants: { _1e6, ZERO, _1e18, feeSink } } = utils
const TRADE_FEE = 0.000567 * _1e6

describe('HubbleReferral Unit Tests', function() {
    before('factories', async function() {
        signers = await ethers.getSigners()
        alice = signers[0].address
        bob = signers[11] // signers 0-10 are utilized in other tests
        ;({ hubbleReferral: referral, clearingHouse, marginAccount, vusd, insuranceFund, forwarder } = await setupContracts({ mockOrderBook: false, tradeFee: TRADE_FEE }))
        await referral.beginSignups(50)
    })

    it('check intialize', async function() {
        expect(await referral.restrictedInvites()).to.eq(true)
        expect(await referral.governance()).to.eq(governance)
    })

    it('create referral code', async function() {
        await expect(referral.createReferralCode('xyz')).to.be.revertedWith('HR: referral code too short')
        referralCode = 'aliceReferral'
        await referral.createReferralCode(referralCode)
        expect(await referral.referrerToCode(alice)).to.eq(referralCode)
        expect(await referral.codeToReferrer(referralCode)).to.eq(alice)
    })

    it('two referrers cannot have same referral code', async function() {
        await expect(referral.connect(bob).createReferralCode(
            'aliceReferral')).to.be.revertedWith('HR: referral code already exists')
    })

    it('cannot update referral code', async function() {
        await expect(referral.createReferralCode('xyzt')).to.be.revertedWith(
            'HR: referral code already exists for this address'
        )
    })

    it('5 hubblers create referral codes with metatxs', async function() {
        referrers = []
        for (let i = 0; i < 5; i++) {
            const account = ethers.Wallet.createRandom()
            referrers.push(account)
            const code = `myrefcode${i+1}`
            const data = referral.interface.encodeFunctionData('createReferralCode', [ code ])
            const { sign, req } = await signTransaction(account, referral, data, forwarder)
            expect(await forwarder.verify(req, sign)).to.equal(true);
            await forwarder.executeRequiringSuccess(req, sign);
            expect(await referral.referrerToCode(account.address)).to.eq(code)
            expect(await referral.codeToReferrer(code)).to.eq(account.address)
        }
        // create 5 more accounts that will be used later
        for (let i = 5; i < 10; i++) {
            const account = ethers.Wallet.createRandom()
            referrers.push(account)
        }
    })

    it('setReferralTicketRoot', async function() {
        // airdrop referral tix to 10 referrers
        const leaves = []
        for (let i = 0; i < 10; i++) {
            const leaf = ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['address', 'uint'], [referrers[i].address, i+1]))
            leaves.push(leaf)
        }
        merkleTree = new MerkleTree(leaves, keccak256, { sortPairs: true })
        root = merkleTree.getHexRoot()
        expect(await referral.referralTicketRoot()).to.eq(`0x${'0'.repeat(64)}`)
        await referral.setReferralTicketRoot(root)
        expect(await referral.referralTicketRoot()).to.eq(root)
    })

    it('referral codes can be created even after tix airdrop', async function() {
        for (let i = 5; i < 10; i++) {
            await utils.setBalance(referrers[i].address, ethers.utils.hexStripZeros(_1e18))
            const code = `myrefcode${i+1}`
            await referral.connect(new ethers.Wallet(referrers[i], ethers.provider)).createReferralCode(code)
            expect(await referral.referrerToCode(referrers[i].address)).to.eq(code)
            expect(await referral.codeToReferrer(code)).to.eq(referrers[i].address)
        }
    })

    it('claimReferralTicket', async function() {
        // signers 1 - 10 claim 1 airdrop each
        for (let i = 0; i < 10; i++) {
            const totalReferralTickets = i+1
            const leaf = ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['address', 'uint'], [referrers[i].address, totalReferralTickets]))
            const args = [referrers[i].address, totalReferralTickets, merkleTree.getHexProof(leaf), `0x${'0'.repeat(40)}`] // no trading authority
            await expect(
                referral.connect(signers[i]).claimReferralTicket(args[0], args[1]+1 /* more tix than assigned */, args[2], args[3])
            ).to.be.revertedWith('Invalid merkle proof')
            await referral.connect(signers[i]).claimReferralTicket(...args)
            expect(await referral.traderToReferrer(signers[i].address)).to.eq(referrers[i].address)

            // trying to claim more referrals will fail
            if (i == 0) {
                await expect(
                    referral.connect(signers[i]).claimReferralTicket(...args)
                ).to.be.revertedWith('Already claimed')
            }
        }
    })

    it('trading authory can be set', async function() {
        // claim 2nd referral tix of referrer 1 (0-indexed)
        const totalReferralTickets = 2
        const leaf = ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['address', 'uint'], [referrers[1].address, totalReferralTickets]))

        tradingAuthority = ethers.utils.getAddress(ethers.utils.hexlify(ethers.utils.randomBytes(20)))
        const args = [referrers[1].address, totalReferralTickets, merkleTree.getHexProof(leaf), tradingAuthority]
        // needs referral contract to be set in orderbook that is not the case by default in our test setup
        await orderBook.setReferral(referral.address)
        await referral.connect(signers[10]).claimReferralTicket(...args, { value: _1e18.div(10) })
        expect(await referral.traderToReferrer(signers[10].address)).to.eq(referrers[1].address)
        expect(await orderBook.isTradingAuthority(signers[10].address, tradingAuthority)).to.eq(true)
        expect(await ethers.provider.getBalance(tradingAuthority)).to.eq(_1e18.div(10))

        await expect(
            referral.connect(signers[10]).claimReferralTicket(...args)
        ).to.be.revertedWith('Already claimed')
    })

    it('revoke trading authority', async function() {
        await orderBook.connect(signers[10]).revokeTradingAuthority(tradingAuthority)
        expect(await orderBook.isTradingAuthority(signers[10].address, tradingAuthority)).to.eq(false)
    })

    it('cannot apply referral code with setReferralCode in invite phase', async function() {
        bob = signers[11]
        await expect(
            referral.connect(bob).setReferralCode(referralCode)
        ).to.be.revertedWith('HR: restricted invites')
        expect(await referral.traderToReferrer(bob.address)).to.eq(`0x${'0'.repeat(40)}`)
    })

    it('concludeRestrictedInvitePhase', async function() {
        expect(
            referral.connect(signers[1]).concludeRestrictedInvitePhase()
        ).to.be.revertedWith('ONLY_GOVERNANCE')
        await referral.concludeRestrictedInvitePhase()
        expect(await referral.restrictedInvites()).to.eq(false)
    })

    it('alices referral code can be used', async function() {
        await referral.connect(bob).setReferralCode(referralCode)
        expect(await referral.traderToReferrer(bob.address)).to.eq(alice)
    })

    it('referrer and trader referral benefits', async function() {
        const feeSinkBalance = await vusd.balanceOf(feeSink)
        // add margin
        const margin = _1e6.mul(2000)
        await addMargin(bob, margin)
        const baseAssetQuantity = _1e18.mul(-5)

        expect(await marginAccount.getNormalizedMargin(alice)).to.eq(ZERO)
        const tx = await clearingHouse.connect(bob).openPosition2(0, baseAssetQuantity, 0)
        const { quoteAsset, fee: feeCharged } = await getTradeDetails(tx, TRADE_FEE)
        const tradeFee = quoteAsset.mul(TRADE_FEE).div(_1e6)
        // 0.5bps of the the tradeFee is added to the margin of the referrer
        const referralBonus = tradeFee.mul(50).div(_1e6)
        expect(await marginAccount.getNormalizedMargin(alice)).to.eq(referralBonus)
        // trader gets 1bps a fee discount
        const discount = tradeFee.mul(100).div(_1e6)
        expect(feeCharged).to.eq(tradeFee.sub(discount))
        expect(await marginAccount.getNormalizedMargin(bob.address)).to.eq(
            margin.sub(feeCharged))
        expect(await vusd.balanceOf(feeSink)).to.eq(feeCharged.sub(referralBonus).add(feeSinkBalance))
    })

    it('setGenesisTicketRoot', async function() {
        // airdrop genesis tix to 10 referrers (who want to be traders now)
        const leaves = []
        for (let i = 0; i < 10; i++) {
            const leaf = ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['address'], [referrers[i].address]))
            leaves.push(leaf)
        }
        genesisMerkleTree = new MerkleTree(leaves, keccak256, { sortPairs: true })
        root = genesisMerkleTree.getHexRoot()
        expect(await referral.genesisTicketRoot()).to.eq(`0x${'0'.repeat(64)}`)
        await referral.setGenesisTicketRoot(root)
        expect(await referral.genesisTicketRoot()).to.eq(root)
    })

    it('can signup with genesis ticket', async function() {
        const feeSink = await clearingHouse.feeSink()
        for (let i = 0; i < 10; i++) {
            await utils.setBalance(referrers[i].address, ethers.utils.hexStripZeros(_1e18))
            const leaf = ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['address'], [referrers[i].address]))
            await referral.connect(new ethers.Wallet(referrers[i], ethers.provider)).claimGenesisTicket(genesisMerkleTree.getHexProof(leaf), `0x${'0'.repeat(40)}`)
            expect(await referral.traderToReferrer(referrers[i].address)).to.eq(feeSink)

        }
    })

    it('cannot signup without genesis ticket', async function() {
        const leaf = ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['address'], [alice]))
        await expect(
            // alice trying to signup without a genesis ticket
            referral.claimGenesisTicket(genesisMerkleTree.getHexProof(leaf), `0x${'0'.repeat(40)}`)
        ).to.be.revertedWith('Invalid merkle proof')
    })
})
