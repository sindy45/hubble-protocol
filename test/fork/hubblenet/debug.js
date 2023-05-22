const { expect } = require('chai')
const { ethers } = require('hardhat')
const {
    impersonateAccount,
    setBalance,
    constants: { _1e18, ZERO, _1e6 }
} = require('../../utils')
const { BigNumber } = ethers

const validator = '0x7baf9e291a0E676a3FC92b684c7198123e9e23e8'
const OBGenesisProxyAddress = '0x0300000000000000000000000000000000000069'
const MAGenesisProxyAddress = '0x0300000000000000000000000000000000000070'
const CHGenesisProxyAddress = '0x0300000000000000000000000000000000000071'

describe.skip('(fork) order match', async function() {
    let blockNumber = 8106

    before(async function() {
        await network.provider.request({
            method: "hardhat_reset",
            params: [{
                forking: {
                    jsonRpcUrl: `https://candy-hubblenet-rpc.hubble.exchange/ext/bc/RvN18T4TH8U4SEamC7rJxavTfuwf6i9V2Fqu8LYCg9u9GgfYE/rpc`,
                    blockNumber
                }
            }]
        })
        await impersonateAccount(validator)
        signer = ethers.provider.getSigner(validator)

        ;([ orderBook, clearingHouse, marginAccount, amm, proxyAdmin,
            vusd, wavax, usdc, oracle, weth
        ] = await Promise.all([
            ethers.getContractAt('OrderBook', OBGenesisProxyAddress),
            ethers.getContractAt('ClearingHouse', CHGenesisProxyAddress),
            // ethers.getContractAt('AMM', config.contracts.amms[0].address),
            // ethers.getContractAt('ProxyAdmin', proxyAdminAddy),
            // ethers.getContractAt('IERC20', config.contracts.vusd),
            // ethers.getContractAt('IERC20', config.contracts.collateral[1].address),
            // ethers.getContractAt('IERC20', config.contracts.usdc),
            // ethers.getContractAt('Oracle', config.contracts.Oracle),
            // ethers.getContractAt('IERC20', Weth)
        ]))

        // signers = await ethers.getSigners()
        // ;([, alice, bob] = signers)
        // console.log(await clearingHouse.amms(0))
        // console.log(alice.address, bob.address)
    })

    after(async function() {
        await network.provider.request({
            method: "hardhat_reset",
            params: [],
        });
    })

    it('place order', async function() {
        console.log((await ethers.provider.getNetwork()).chainId)
        const { order: order1, signature: sig1 } = await placeOrder(orderBook, alice, 1, 11)
        const { order: order2, signature: sig2 } = await placeOrder(orderBook, bob, -1, 11)
        console.log({ order1, sig1, order2, sig2 })
    })

    const order1 = {
        ammIndex: 0,
        trader: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
        baseAssetQuantity: ethers.utils.parseEther('100'),
        price: ethers.utils.parseUnits('10.5', 6),
        salt: '0x01872ccbda06'
    }
    const sig1 = '0xe620004a12354e36b8fbf7319b0b05ff8edc8b4bce4d45f40d8e0f70c058f55c60ec5852d59a903abeb438a3729b2210c18b3b343f9db8695bea17ec3fb0f8bb1c'

    const order2 = {
        ammIndex: 0,
        trader: '0x835cE0760387BC894E91039a88A00b6a69E65D94',
        baseAssetQuantity: ethers.utils.parseEther('-1'),
        price: ethers.utils.parseUnits('10.5', 6),
        salt: '0x01872ce162b4'
    }
    const sig2 = '0x656812b104e0b60f0b63b486fe1f572e78e3e5deb5ff575230716bfb2a28b58e6ca522a8e1956bba8294a73c28f7693d482ac8bc7b8fa8b8646ec2fbc3710d141b'
    const fillAmount = ethers.utils.parseEther('1')

    const matchInfo = [{
        orderHash: '0x2d797b81bc44bc00991559775b5b146c816a7cb1073dbcf038cf9ad85a694222',
        blockPlaced: 35,
        isMakerOrder: true
    }, {
        orderHash: '0xd556d8939d73713321089a07686b8769f939b04ac906549d1ebc029c18cfc7eb',
        blockPlaced: 41,
        isMakerOrder: false
    }]

    it('order match', async function() {
        // console.log(await orderBook.verifySigner(order1, sig1))
        // console.log(await orderBook.verifySigner(order2, sig2))
        await orderBook.connect(signer).executeMatchedOrders(
            [order1, order2],
            [sig1, sig2],
            fillAmount
        )
    })

    it('ch.openPosition', async function() {
        await impersonateAccount(CHGenesisProxyAddress)
        await setBalance(CHGenesisProxyAddress, ethers.utils.parseEther('2').toHexString().replace(/0x0+/, "0x"))
        // await clearingHouse.connect(ethers.provider.getSigner(CHGenesisProxyAddress)).openPosition(order1, fillAmount, order1.price, true, { gasPrice: 60e9})
        await clearingHouse.connect(ethers.provider.getSigner(CHGenesisProxyAddress)).openPosition(order2, fillAmount.mul(-1), order2.price, false, { gasPrice: 60e9})
    })

    it('ch.openComplementaryPositions', async function() {
        await impersonateAccount(OBGenesisProxyAddress)
        await setBalance(OBGenesisProxyAddress, ethers.utils.parseEther('2').toHexString().replace(/0x0+/, "0x"))
        await clearingHouse
            .connect(ethers.provider.getSigner(OBGenesisProxyAddress))
            .openComplementaryPositions([order1,order2], matchInfo, fillAmount, order2.price, { gasPrice: 60e9})
    })

    it('settleFunding', async function() {
        await orderBook.connect(ethers.provider.getSigner(validator)).settleFunding()
    })
})

async function placeOrder(orderBook, signer, baseAssetQuantity, price) {
    const domain = {
        name: 'Hubble',
        version: '2.0',
        chainId: 321123, // (await ethers.provider.getNetwork()).chainId,
        verifyingContract: OBGenesisProxyAddress // orderBook.address
    }

    const orderType = {
        Order: [
            // field ordering must be the same as LIMIT_ORDER_TYPEHASH
            { name: "ammIndex", type: "uint256" },
            { name: "trader", type: "address" },
            { name: "baseAssetQuantity", type: "int256" },
            { name: "price", type: "uint256" },
            { name: "salt", type: "uint256" },
        ]
    }
    const order = {
        ammIndex: ZERO,
        trader: signer.address,
        baseAssetQuantity: ethers.utils.parseEther(baseAssetQuantity.toString()),
        price: ethers.utils.parseUnits(price.toString(), 6),
        salt: BigNumber.from(Date.now())
    }
    order1Hash = await orderBook.getOrderHash(order)
    signature = await signer._signTypedData(domain, orderType, order)

    await orderBook.connect(signer).placeOrder(order, signature)
    return { order, signature }
}
