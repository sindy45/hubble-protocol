const utils = require('../../test/utils')

const {
    constants: { _1e6, _1e18 },
    BigNumber,
    setupContracts,
    setupRestrictedTestToken,
    generateConfig
} = utils
const _1e8 = BigNumber.from(10).pow(8)

/**
 * Deploying ETH amm in active mode with $2m liquidity (1k eth at $1k) added
 * Deploying BTC amm in ignition mode  with $2m liquidity (30 BTC at $35k) commited.
 * Unbond period for both is 5mins
 *
 * After deployment
 * governance - signers[0]
 * maker - signers[9]
 * signers[1], signers[2] have 1000 vUSD and 200 avax each
 * call btcAMM.liftOff() with governance to put AMM in active mode
 */

async function main() {
    signers = await ethers.getSigners()
    governance = signers[0].address

    const { marginAccountHelper } =  await setupContracts({
        governance,
        unbondRoundOff: 1, // 1s
        amm: {
            unbondPeriod: 300, // 5 mins
        },
        restrictedVUSD: false
    })

    // provide some vusd to signers[1], signers[2]
    const initialVusdAmount = _1e6.mul(1000)
    await addVUSDWithReserve(signers[1], initialVusdAmount)
    await addVUSDWithReserve(signers[2], initialVusdAmount)

    // whitelist avax as collateral
    const avax = await setupRestrictedTestToken('Avalanche', 'AVAX', 8)
    await oracle.setStablePrice(avax.address, 100e8) // $100
    await marginAccount.whitelistCollateral(avax.address, 8e5) // weight = 0.8e6
    await avax.mint(signers[1].address, _1e8.mul(200)) // 200 avax
    await avax.mint(signers[2].address, _1e8.mul(200)) // 200 avax

    // setup another market
    const btc = await setupRestrictedTestToken('Bitcoin', 'BTC', 8)
    await utils.setupAmm(
        governance,
        [ 'BTC-PERP', btc.address, oracle.address, 0 ],
        {
            index: 1,
            initialRate: 35000,
            initialLiquidity: 30, // maker1 will commit this 2 * liquidity in USD
            fee: 10000000, // 0.1%
            ammState: 1, // Ignition
            unbondPeriod: 300, // 5 mins
        }
    )

    console.log(JSON.stringify(await generateConfig(leaderboard.address, marginAccountHelper.address), null, 2))

    async function addVUSDWithReserve(trader, amount) {
        await usdc.mint(trader.address, amount)
        await usdc.connect(trader).approve(vusd.address, amount)
        await vusd.connect(trader).mintWithReserve(trader.address, amount)
    }
}

main()
.then(() => process.exit(0))
.catch(error => {
    console.error(error);
    process.exit(1);
});
