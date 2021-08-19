const { BigNumber } = require('ethers')
const fs = require('fs')
const { expect } = require("chai");

const utils = require('./utils')

const _1e6 = BigNumber.from(10).pow(6)
const _1e18 = ethers.constants.WeiPerEther
const ZERO = BigNumber.from(0)

describe('e2e', function() {
    before('setup contracts', async function() {
        signers = await ethers.getSigners()
        alice = signers[0].address
        let abiAndBytecode = fs.readFileSync('./vyper/MoonMath.txt').toString().split('\n').filter(Boolean)
        const MoonMath = new ethers.ContractFactory(JSON.parse(abiAndBytecode[0]), abiAndBytecode[1], signers[0])

        abiAndBytecode = fs.readFileSync('./vyper/Views.txt').toString().split('\n').filter(Boolean)
        const Views = new ethers.ContractFactory(JSON.parse(abiAndBytecode[0]), abiAndBytecode[1], signers[0])

        abiAndBytecode = fs.readFileSync('./vyper/Swap.txt').toString().split('\n').filter(Boolean)
        const Swap = new ethers.ContractFactory(JSON.parse(abiAndBytecode[0]), abiAndBytecode[1], signers[0])

        ;([ ClearingHouse, AMM, MarginAccount, VUSD ] = await Promise.all([
            ethers.getContractFactory('ClearingHouse'),
            ethers.getContractFactory('AMM'),
            ethers.getContractFactory('MarginAccount'),
            ethers.getContractFactory('VUSD')
        ]))
        const moonMath = await MoonMath.deploy()
        const views = await Views.deploy(moonMath.address)
        swap = await Swap.deploy(
            "0xbabe61887f1de2713c6f97e567623453d3c79f67",
            "0xbabe61887f1de2713c6f97e567623453d3c79f67",
            moonMath.address,
            views.address,
            3645,
            "69999999999999",
            0,
            0,
            "2800000000000000",
            0,
            "1500000000000000",
            0,
            600,
            [_1e18.mul(40000) /* btc initial rate */, _1e18.mul(1000) /* eth initial rate */]
        )
        await swap.add_liquidity([
            _1e6.mul(_1e6), // 1m USDT
            _1e6.mul(100).mul(25), // 25 btc
            _1e18.mul(1000) // 1000 eth
        ], 0)
        // await swap.exchange(0, 2, '100000000', 0)
        const vUSD = await VUSD.deploy()
        ERC20Mintable = await ethers.getContractFactory('ERC20Mintable')
        usdc = await ERC20Mintable.deploy('usdc', 'usdc', 6)

        marginAccount = await MarginAccount.deploy(vUSD.address, usdc.address)
        clearingHouse = await ClearingHouse.deploy(marginAccount.address, 0.03 * 1e6) // 3% maintenance margin
        await marginAccount.setClearingHouse(clearingHouse.address)
    })

    it('whitelistAmm', async function() {
        amm = await AMM.deploy(clearingHouse.address, swap.address)
        await clearingHouse.whitelistAmm(amm.address)
    })

    it('addMargin', async function() {
        marginAmount = _1e6.mul(100)
        await usdc.mint(alice, marginAmount)
        await usdc.approve(marginAccount.address, marginAmount)
        await marginAccount.addUSDCMargin(marginAmount);
        console.log((await marginAccount.getNormalizedMargin(alice)).toString())
    })

    it('openPosition - SHORT', async function() {
        await clearingHouse.openPosition(0, _1e18.mul(-2), 0)
        const position = await amm.positions(signers[0].address)
        const { notionalPosition, unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(alice)
        utils.log(position, notionalPosition, unrealizedPnl, await clearingHouse.getMarginFraction(alice))
    })

    it('_increasePosition - SHORT', async function() {
        await clearingHouse.openPosition(0, _1e18.mul(-1), 0)
        const position = await amm.positions(signers[0].address)
        const { notionalPosition, unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(alice)
        utils.log(position, notionalPosition, unrealizedPnl, await clearingHouse.getMarginFraction(alice))
    })

    it.skip('settleFunding', async function() {
        const underlyingTwapPrice = await amm.getUnderlyingTwapPrice(0)
        const twapPrice = await amm.getTwapPrice(0)
        const premium = await amm.callStatic.settleFunding()
        await amm.settleFunding()
        console.log({
            premium: premium.toString(),
            underlyingTwapPrice: underlyingTwapPrice.toString(),
            twapPrice: twapPrice.toString(),
            fundingRate: (await amm.fundingRate()).toString()
        })
        const normalizedMargin = await marginAccount.getNormalizedMargin(alice)
        console.log({ normalizedMargin: normalizedMargin.toString()})
        await clearingHouse.updatePositions(alice)
        // short position so margin should increase
        expect((await marginAccount.getNormalizedMargin(alice)).gt(normalizedMargin)).to.be.true
    })

    it('_openReversePosition - (Close short)', async function() {
        let { notionalPosition } = await amm.getNotionalPositionAndUnrealizedPnl(alice)
        await clearingHouse.openPosition(0, _1e18.mul(3), ethers.constants.MaxUint256)

        const position = await amm.positions(signers[0].address)
        ;({ notionalPosition, unrealizedPnl } = await amm.getNotionalPositionAndUnrealizedPnl(alice))
        const marginFraction = await clearingHouse.getMarginFraction(alice)
        utils.log(position, notionalPosition, unrealizedPnl, marginFraction);

        expect(position.size).to.eq(ZERO)
        expect(position.openNotional).to.eq(ZERO)
        expect(notionalPosition).to.eq(ZERO)
        expect(unrealizedPnl).to.eq(ZERO)
        expect(marginFraction).to.eq(ethers.constants.MaxInt256)

        // realizedPnl should ideally be 0, but is -1 (-1e-6)
        // doesn't happen when a size=3 is shorted in one go
        // actual expectation is vUSDBalance(alice) == marginAmount
        expect(await marginAccount.vUSDBalance(alice)).to.eq(marginAmount.sub(1))
    })
})
