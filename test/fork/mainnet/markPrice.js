const { expect } = require('chai')
const fs = require('fs')
const {
    constants: { _1e6, _1e18, ZERO },
    getTradeDetails,
    parseRawEvent,
} = require('../../utils')
const { mainnetConfig: config } = require('../../../scripts/config')

const deployer = '0xF5c8E1eAFFD278A383C13061B4980dB7619479af'
const proxyAdminAddy = '0xddf407237BDe4d36287Be4De79D65c57AefBf8da'
const alice = ethers.provider.getSigner('0x6b365af8d060e7f7989985d62485357e34e2e8f5') // 4m usdc

describe.skip('(fork) mark price', async function() {
    const blockTag = 18503230
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
        await impersonateAccount(alice._address)
        signer = ethers.provider.getSigner(deployer)
        ;([
            amm, hubbleViewer, clearingHouse, proxyAdmin, marginAccountHelper,
            usdc
        ] = await Promise.all([
            ethers.getContractAt('AMM', config.contracts.amms[0].address),
            ethers.getContractAt('HubbleViewer', config.contracts.HubbleViewer_0),
            ethers.getContractAt('ClearingHouse', config.contracts.ClearingHouse),
            ethers.getContractAt('ProxyAdmin', proxyAdminAddy),
            ethers.getContractAt('MarginAccountHelper', config.contracts.MarginAccountHelper),
            ethers.getContractAt('IERC20', config.contracts.usdc),
        ]))
    })

    after(async function() {
        await network.provider.request({
            method: "hardhat_reset",
            params: [],
        });
    })

    it('update vAMM', async function() {
        const vammAbiAndBytecode = fs.readFileSync('contracts/curve-v2/Swap.txt').toString().split('\n').filter(Boolean)
        const Swap = new ethers.ContractFactory(JSON.parse(vammAbiAndBytecode[0]), vammAbiAndBytecode[1], signer)
        vamm = Swap.attach(config.contracts.amms[0].vamm)
        const newVAMM = await Swap.deploy()
        await proxyAdmin.connect(signer).upgrade(config.contracts.amms[0].vamm, newVAMM.address)
    })

    it('correct markPrice and avg price', async function() {
        // make a trade to update price according to new method
        const margin = _1e6.mul(5000)
        await usdc.connect(alice).approve(marginAccountHelper.address, margin)
        await marginAccountHelper.connect(alice).addVUSDMarginWithReserve(margin)

        const base = _1e18.mul(10)
        const quote = await hubbleViewer.getQuote(base, 0)
        await clearingHouse.connect(alice).openPosition(0, base, quote)

        const markPrice = await amm.lastPrice()
        const avgLongPrice = (await hubbleViewer.getQuote(base, 0)).mul(_1e18).div(base)
        const avgShortPrice = (await hubbleViewer.getQuote(base.mul(-1), 0)).mul(_1e18).div(base)
        expect(avgLongPrice).gt(markPrice)
        expect(avgShortPrice).lt(markPrice)
    })

    it('long', async function() {
        const markPriceBefore = await amm.lastPrice()
        const base = _1e18.mul(10)

        const quote = await hubbleViewer.getQuote(base, 0)
        const tx = await clearingHouse.connect(alice).openPosition(0, base, quote)
        const { quoteAsset } = await getTradeDetails(tx)
        const vammFee = (await parseRawEvent(tx, vamm, 'TokenExchange')).args.trade_fee
        const markPriceAfter = await amm.lastPrice()
        // calculate avgPrice without fee
        const avgPrice = quoteAsset.sub(vammFee).mul(_1e18).div(base)

        expect(markPriceAfter).to.gt(markPriceBefore)
        expect(avgPrice).to.gt(markPriceBefore)
        expect(avgPrice).to.lt(markPriceAfter)
    })

    it('short', async function() {
        const markPriceBefore = await amm.lastPrice()
        const base = _1e18.mul(-5)
        const quote = await hubbleViewer.getQuote(base, 0)
        const tx = await clearingHouse.connect(alice).openPosition(0, base, quote)
        const { quoteAsset } = await getTradeDetails(tx)
        const vammFee = (await parseRawEvent(tx, vamm, 'TokenExchange')).args.trade_fee
        const markPriceAfter = await amm.lastPrice()
        // calculate avgPrice without fee
        const avgPrice = quoteAsset.add(vammFee).mul(_1e18).div(base.abs())

        expect(markPriceAfter).to.lt(markPriceBefore)
        expect(avgPrice).to.lt(markPriceBefore)
        expect(avgPrice).to.gt(markPriceAfter)
    })
})

async function getPrice(q) {
    const quote = await hubbleViewer.getQuote(q, 0)
    return quote.mul(_1e18).div(q.abs())
}

async function impersonateAccount(account) {
    await network.provider.request({
        method: 'hardhat_impersonateAccount',
        params: [account],
    })
}
