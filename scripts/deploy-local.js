const fs = require('fs')
const { constants: { _1e6, _1e18 }, setupContracts } = require('../test/utils')

async function main() {
    signers = await ethers.getSigners()
    const { swap, marginAccount, marginAccountHelper, clearingHouse, amm, vusd, usdc, weth, oracle, insuranceFund } = await setupContracts()

    // provide some vusd balance to signers[1]
    const initialVusdAmount = _1e6.mul(1000)
    await usdc.mint(signers[1].address, initialVusdAmount)
    await usdc.connect(signers[1]).approve(vusd.address, initialVusdAmount)
    await vusd.connect(signers[1]).mintWithReserve(signers[1].address, initialVusdAmount)

    const contracts = {
        vamm: swap.address,
        amm: amm.address,
        marginAccount: marginAccount.address,
        marginAccountHelper: marginAccountHelper.address,
        clearingHouse: clearingHouse.address,
        insuranceFund: insuranceFund.address,
        vusd: vusd.address,
        usdc: usdc.address,
        weth: weth.address,
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
