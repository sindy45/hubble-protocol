const utils = require('../../test/utils')
const { addVUSDWithReserve, addMargin } = require('./deployUtils')

const {
    constants: { _1e6 },
    setupContracts,
    generateConfig,
    getTxOptions,
    sleep,
    txOptions
} = utils
const gasLimit = 5e6 // subnet genesis file only allows for this much

/**
 * After deployment
 * governance - signers[0]
 * signers[1], signers[2] have 1000 vUSD each
 */

async function main() {
    signers = await ethers.getSigners()
    governance = signers[0].address
    ;([, alice, bob] = signers)

    // 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
    // console.log(signers[0].address, signers[1].address, signers[2].address)

    txOptions.nonce = await signers[0].getTransactionCount()
    // this is a hack for an interesting use-case
    // when we deploy an implementation contract (tx1) and subsequently the TransparentProxy (tx2), the gas estimation for tx2 might fail because the tx1 is not yet mined
    // however, if we pass the gasLimit here, the estimation is skipped and nonce makes sure that tx1 and then tx2 is mined
    txOptions.gasLimit = gasLimit

    const { marginAccountHelper, orderBook } =  await setupContracts({
        governance,
        restrictedVUSD: false,
        genesisProxies: true,
        mockOrderBook: false,
        testClearingHouse: false,
        amm: {
            initialRate: 2000
        }
    })

    await addMargin(alice, _1e6.mul(40000), gasLimit)
    await addMargin(bob, _1e6.mul(40000), gasLimit)

    // whitelist evm address for order execution transactions
    await orderBook.setValidatorStatus(ethers.utils.getAddress('0x4Cf2eD3665F6bFA95cE6A11CFDb7A2EF5FC1C7E4'), true)
    // set spread limit to higher value
    const maxOracleSpreadRatio = 20 * 1e4 // 20%
    await amm.setPriceSpreadParams(maxOracleSpreadRatio, 0)

    await sleep(5)
    console.log(JSON.stringify(await generateConfig(leaderboard.address, marginAccountHelper.address), null, 0))
}

main()
.then(() => process.exit(0))
.catch(error => {
    console.error(error);
    process.exit(1);
});
