const { BigNumber } = require('ethers')
const utils = require('../test/utils')

const { constants: { _1e6, _1e18 } } = utils
const _1e8 = BigNumber.from(10).pow(8)
async function main() {
    signers = await ethers.getSigners()
    alice = signers[0].address

    const { marginAccount, clearingHouse, vusd, usdc, oracle } = await utils.setupContracts()

    // provide some vusd to signers[1]
    const initialVusdAmount = _1e6.mul(1000)
    await usdc.mint(signers[1].address, initialVusdAmount)
    await usdc.connect(signers[1]).approve(vusd.address, initialVusdAmount)
    await vusd.connect(signers[1]).mintWithReserve(signers[1].address, initialVusdAmount)

    // whitelist avax as collateral
    const ERC20Mintable = await ethers.getContractFactory('ERC20Mintable')
    const avax = await ERC20Mintable.deploy('Avalanche', 'AVAX', 8)
    await oracle.setStablePrice(avax.address, 60e6) // $60
    await marginAccount.addCollateral(avax.address, 8e5) // weight = 0.8e6
    await avax.mint(signers[1].address, _1e8.mul(200)) // 200 avax

    // setup another market
    const btc = await ERC20Mintable.deploy('Bitcoin', 'BTC', 8)
    await utils.setupAmm(
        [ alice, registry.address, btc.address, 'BTC-Perp' ],
        50000, // initialRate => btc = $50000
        25 // initialLiquidity = 25 btc
    )

    const HubbleViewer = await ethers.getContractFactory('HubbleViewer')
    const hubbleViewer = await HubbleViewer.deploy(clearingHouse.address)

    const contracts = {
        marginAccount: marginAccount.address,
        clearingHouse: clearingHouse.address,
        hubbleViewer: hubbleViewer.address,
        vusd: vusd.address,
        oracle: oracle.address
    }
    console.log(contracts)
}

main()
.then(() => process.exit(0))
.catch(error => {
    console.error(error);
    process.exit(1);
});
