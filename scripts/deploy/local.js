const utils = require('../../test/utils')

const {
    constants: { _1e6 },
    setupContracts,
    addMargin,
    generateConfig,
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

    const { marginAccountHelper, usdc } =  await setupContracts({
        governance,
        restrictedVUSD: false,
        genesisProxies: true,
        mockOrderBook: false,
        amm: {
            initialRate: 10
        }
    })

    // provide some vusd to signers[1], signers[2]
    const initialVusdAmount = _1e6.mul(1000)
    await addVUSDWithReserve(signers[1], initialVusdAmount)
    await addVUSDWithReserve(signers[2], initialVusdAmount)

    await addMargin(alice, _1e6.mul(40000), usdc)
    await addMargin(bob, _1e6.mul(40000), usdc)

    // setup another market
    // const btc = await setupRestrictedTestToken('Bitcoin', 'BTC', 8)
    // await utils.setupAmm(
    //     governance,
    //     [ 'BTC-PERP', btc.address, oracle.address, 0 ],
    //     {
    //         index: 1,
    //         initialRate: 35000,
    //         initialLiquidity: 30, // maker1 will commit this 2 * liquidity in USD
    //         fee: 10000000, // 0.1%
    //         ammState: 1, // Ignition
    //         unbondPeriod: 300, // 5 mins
    //     }
    // )

    await sleep(5)
    console.log(JSON.stringify(await generateConfig(leaderboard.address, marginAccountHelper.address), null, 0))

    async function addVUSDWithReserve(trader, amount) {
        await usdc.mint(trader.address, amount)
        await usdc.connect(trader).approve(vusd.address, amount)
        await vusd.connect(trader).mintWithReserve(trader.address, amount, { gasLimit })
    }
}

main()
.then(() => process.exit(0))
.catch(error => {
    console.error(error);
    process.exit(1);
});
