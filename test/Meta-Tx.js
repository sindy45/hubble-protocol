const { expect } = require('chai');

const utils = require('./utils')

const {
    constants: { _1e6, _1e18 },
    signTransaction,
    setupContracts
} = utils

describe('Meta Txs - Margin Account', async function () {
    before('contract factories', async function() {
        signers = await ethers.getSigners()
        alice = signers[0].address
        ;({ swap, marginAccount, marginAccountHelper, clearingHouse, amm, vUSD, usdc, oracle, forwarder } = await setupContracts())
        relayer = signers[1]
    })

    it('addCollateral', async () => {
        weth = await utils.setupRestrictedTestToken('weth', 'weth', 18)
        await oracle.setUnderlyingPrice(weth.address, 1e6 * 2000) // $2k

        await marginAccount.whitelistCollateral(weth.address, 1e6) // weight = 1

        const supportedCollateral = await marginAccount.supportedCollateral(1);
        expect(supportedCollateral.token).to.eq(weth.address)
        expect(supportedCollateral.decimals).to.eq(18)
    })

    it('addMargin', async () => {
        const amount = _1e18
        await weth.mint(alice, amount)
        await weth.approve(marginAccount.address, amount)

        const data = marginAccount.interface.encodeFunctionData('addMargin', [ 1, amount ])
        const { sign, req } = await signTransaction(signers[0], marginAccount, data, forwarder)
        expect(await forwarder.verify(req, sign)).to.equal(true);

        await forwarder.connect(relayer).executeRequiringSuccess(req, sign);

        expect(await marginAccount.margin(1, alice)).to.eq(amount)
        expect(await marginAccount.getNormalizedMargin(alice)).to.eq(_1e6.mul(2000))
    })
})

// this is not implemented yet!
describe.skip('Meta Txs - orderbook', async function () {
    before('contract factories', async function() {
        signers = await ethers.getSigners()
        alice = signers[1]
        ;({ orderBook, forwarder } = await setupContracts({ mockOrderBook: false, testClearingHouse: false }))
        relayer = signers[2]
    })

    it('trading authority', async function() {
        tradingAuthority = ethers.utils.getAddress(ethers.utils.hexlify(ethers.utils.randomBytes(20)))
        // await orderBook.connect(alice).whitelistTradingAuthority(tradingAuthority, { value: _1e18 })

        const data = orderBook.interface.encodeFunctionData('whitelistTradingAuthority', [ tradingAuthority ])
        const { sign, req } = await signTransaction(alice, orderBook, data, forwarder, _1e18)
        expect(await forwarder.verify(req, sign)).to.equal(true);

        await forwarder.connect(relayer).executeRequiringSuccess(req, sign);

        expect(await orderBook.isTradingAuthority(alice.address, tradingAuthority)).to.eq(true)
        expect(await ethers.provider.getBalance(tradingAuthority)).to.eq(_1e18)
    })
})
