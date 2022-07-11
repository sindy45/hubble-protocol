const Bluebird = require('bluebird')
const _ = require('lodash')

async function main() {
    const contracts = [
        {
            name: 'VUSD',
            address: '0xe13438252a4BCe800f69519E242289D79004aD5d',
            constructorArguments: [
                '0xFd4f95A581CAA172F2b2A93d6552DA75A373f521',
                '0xdfE416E61D78855bb47b358353dc3AEa0C0a3ECD',
                '0x4cd88b7600000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000000a487562626c65205553440000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000046855534400000000000000000000000000000000000000000000000000000000'
            ]
        },
        {
            name: 'MarginAccount',
            address: '0xDbcA6Fef86087328dF833EE69E5c9c86884649b1',
            constructorArguments: [
                '0xFb17C2CdBFA9A889cB5cd4286C9d7a971b620fD3',
                '0xdfE416E61D78855bb47b358353dc3AEa0C0a3ECD',
                '0x485cc955000000000000000000000000835ce0760387bc894e91039a88a00b6a69e65d94000000000000000000000000e13438252a4bce800f69519e242289d79004ad5d'
            ]
        }
    ]
    await Bluebird.map(contracts, async contract => {
        // console.log(_.pick(contract, ['address', 'constructorArguments']))
        try {
            await hre.run('verify:verify', _.pick(contract, ['address', 'constructorArguments'])) // { address, constructorArguments }
        } catch (e) {
            console.log(`failed in verifying ${contract.name}`, e)
        }
    }, { concurrency: 5 })

    // private contract verification
    await hre.tenderly.push(...contracts.map(contract => {
        // console.log(_.pick(contract, ['address', 'name']))
        return _.pick(contract, ['address', 'name'])
    }))

    // await hre.tenderly.verify(contract) // public contract verification - not sure what that means tho, because it doesn't verify on snowtrace
}

main()
.catch(error => {
    console.error(error);
    process.exit(1);
});
