let { BigNumber } = require('ethers')
const fs = require('fs')
const { expect } = require('chai');

const _1e6 = BigNumber.from(10).pow(6)
const _1e18 = ethers.constants.WeiPerEther

describe('Margin Account Tests', function() {
    before('contract factories', async function() {
        signers = await ethers.getSigners()
        alice = signers[0].address
        let abiAndBytecode = fs.readFileSync('./vyper/MoonMath.txt').toString().split('\n').filter(Boolean)
        const MoonMath = new ethers.ContractFactory(JSON.parse(abiAndBytecode[0]), abiAndBytecode[1], signers[0])

        abiAndBytecode = fs.readFileSync('./vyper/Views.txt').toString().split('\n').filter(Boolean)
        const Views = new ethers.ContractFactory(JSON.parse(abiAndBytecode[0]), abiAndBytecode[1], signers[0])

        abiAndBytecode = fs.readFileSync('./vyper/Swap.txt').toString().split('\n').filter(Boolean)
        Swap = new ethers.ContractFactory(JSON.parse(abiAndBytecode[0]), abiAndBytecode[1], signers[0])

        ;([ ClearingHouse, AMM, MarginAccount, VUSD ] = await Promise.all([
            ethers.getContractFactory('ClearingHouse'),
            ethers.getContractFactory('AMM'),
            ethers.getContractFactory('MarginAccount'),
            ethers.getContractFactory('VUSD')
        ]))
        moonMath = await MoonMath.deploy()
        views = await Views.deploy(moonMath.address)

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
        // await swap.add_liquidity([
        //     _1e6.mul(_1e6).mul(_1e6), // 1m USDT
        //     _1e6.mul(100).mul(25), // 25 btc
        //     _1e18.mul(1000).mul(1000) // 1000 eth
        // ], 0)
        // await swap.exchange(0, 2, '100000000', 0)
        const vUSD = await VUSD.deploy()
        ERC20Mintable = await ethers.getContractFactory('ERC20Mintable')
        usdc = await ERC20Mintable.deploy('usdc', 'usdc', 6)

        marginAccount = await MarginAccount.deploy(vUSD.address, usdc.address)
        clearingHouse = await ClearingHouse.deploy(marginAccount.address, 0.03 * 1e6) // 3% maintenance margin
        await marginAccount.setClearingHouse(clearingHouse.address)

        // whitelistAmm
        amm = await AMM.deploy(clearingHouse.address, swap.address)
        await clearingHouse.whitelistAmm(amm.address)
    })

    it('addUSDCMargin', async () => {
        margin = _1e6.mul(2000)
        await usdc.mint(alice, margin)
        await usdc.approve(marginAccount.address, margin)
        await marginAccount.addUSDCMargin(margin);

        expect(await marginAccount.vUSDBalance(alice)).to.eq(margin)
        expect(await marginAccount.getNormalizedMargin(alice)).to.eq(margin)
    })

    it('withdrawVusd', async () => {
        margin = margin.div(2)
        await marginAccount.withdrawVusd(margin, false /* redeemForUSDC */);

        expect(await marginAccount.vUSDBalance(alice)).to.eq(margin)
        expect(await marginAccount.getNormalizedMargin(alice)).to.eq(margin)
    })

    it('addCollateral', async () => {
        const Oracle = await ethers.getContractFactory('Oracle')
        weth = await ERC20Mintable.deploy('weth', 'weth', 18)
        const oracle = await Oracle.deploy()

        await marginAccount.addCollateral(weth.address, oracle.address)

        const supportedCollateral = await marginAccount.supportedCollateral(0);
        expect(supportedCollateral.token).to.eq(weth.address)
        expect(supportedCollateral.oracle).to.eq(oracle.address)
        expect(supportedCollateral.decimals).to.eq(18)
    })

    it('addMargin', async () => {
        const amount = _1e18
        await weth.mint(alice, amount)
        await weth.approve(marginAccount.address, amount)
        await marginAccount.addMargin(0, amount);

        expect(await marginAccount.vUSDBalance(alice)).to.eq(margin)
        expect(await marginAccount.getNormalizedMargin(alice)).to.eq(_1e6.mul(2000).add(margin))
    })

    it('removeMargin', async () => {
        const amount = _1e18.div(2)
        await marginAccount.removeMargin(0, amount);

        expect(await marginAccount.vUSDBalance(alice)).to.eq(margin)
        expect(await marginAccount.getNormalizedMargin(alice)).to.eq(_1e6.mul(2000).div(2).add(margin))
    })
})
