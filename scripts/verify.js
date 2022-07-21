const Bluebird = require('bluebird')
const _ = require('lodash')

async function main() {
    // whirlpool
    const contracts = [
        {
          name: 'VUSD',
          address: '0xd9EB670F3fA7929c80f2D6f7F6666FE8335dDd80',
          constructorArguments: [ '0xbdab32601abbd79eff36bb23a4efebe334ffa09c' ]
        },
        {
          name: 'TransparentUpgradeableProxy',
          impl: 'VUSD',
          address: '0x335072AA9dD9Fed83DcA7BBC72265Dda8d06287E',
          constructorArguments: [
            '0xd9EB670F3fA7929c80f2D6f7F6666FE8335dDd80',
            '0xdfE416E61D78855bb47b358353dc3AEa0C0a3ECD',
            '0x4cd88b7600000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000000a487562626c65205553440000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000046855534400000000000000000000000000000000000000000000000000000000'
          ]
        },
        {
          name: 'MarginAccount',
          address: '0x6bBc45951021BF5e7c42a3459227C79FB3497f21',
          constructorArguments: [ '0x66517c9a4Cf1A3efDb20742DF8E7375dF553C2ed' ]
        },
        {
          name: 'TransparentUpgradeableProxy',
          impl: 'MarginAccount',
          address: '0xE91Df8e200f8Ab7A72e9cBDB2b207beC0dfb73C5',
          constructorArguments: [
            '0x6bBc45951021BF5e7c42a3459227C79FB3497f21',
            '0xdfE416E61D78855bb47b358353dc3AEa0C0a3ECD',
            '0x485cc955000000000000000000000000835ce0760387bc894e91039a88a00b6a69e65d94000000000000000000000000335072aa9dd9fed83dca7bbc72265dda8d06287e'
          ]
        },
        {
          name: 'MarginAccountHelper',
          address: '0xD5D22E3e5CdA2e57Ee56549Ee67eEfD1CB5C72d1',
          constructorArguments: [
            '0xE91Df8e200f8Ab7A72e9cBDB2b207beC0dfb73C5',
            '0x335072AA9dD9Fed83DcA7BBC72265Dda8d06287E',
            '0xd00ae08403B9bbb9124bB305C09058E32C39A48c'
          ]
        },
        {
          name: 'InsuranceFund',
          address: '0x3eE003Cf98591BF49887b39DcB95538503548663',
          constructorArguments: []
        },
        {
          name: 'TransparentUpgradeableProxy',
          impl: 'InsuranceFund',
          address: '0xFF2a2d228E136BcBbA2C07939cfab40dcaCB6877',
          constructorArguments: [
            '0x3eE003Cf98591BF49887b39DcB95538503548663',
            '0xdfE416E61D78855bb47b358353dc3AEa0C0a3ECD',
            '0xc4d66de8000000000000000000000000835ce0760387bc894e91039a88a00b6a69e65d94'
          ]
        },
        {
          name: 'Oracle',
          address: '0x18f0f1764e4CE7C6d2e5Ef12996Ba4C1B45FFad0',
          constructorArguments: []
        },
        {
          name: 'TransparentUpgradeableProxy',
          impl: 'Oracle',
          address: '0xc1B21D15479DBC3BdaB5541D89258C05a3cC6309',
          constructorArguments: [
            '0x18f0f1764e4CE7C6d2e5Ef12996Ba4C1B45FFad0',
            '0xdfE416E61D78855bb47b358353dc3AEa0C0a3ECD',
            '0xc4d66de8000000000000000000000000835ce0760387bc894e91039a88a00b6a69e65d94'
          ]
        },
        {
          name: 'HubbleReferral',
          address: '0x0DD44aB4523e3B6bb4610f38C6412b1B948480F0',
          constructorArguments: []
        },
        {
          name: 'TransparentUpgradeableProxy',
          impl: 'HubbleReferral',
          address: '0x00bf64ffC153d2436f9424F1f82A34FF6FEE3332',
          constructorArguments: [
            '0x0DD44aB4523e3B6bb4610f38C6412b1B948480F0',
            '0xdfE416E61D78855bb47b358353dc3AEa0C0a3ECD',
            '0x'
          ]
        },
        {
          name: 'ClearingHouse',
          address: '0x51279F26586dA3FF413fc3bee5de39A0069E6062',
          constructorArguments: [ '0x66517c9a4Cf1A3efDb20742DF8E7375dF553C2ed' ]
        },
        {
          name: 'TransparentUpgradeableProxy',
          impl: 'ClearingHouse',
          address: '0x397Bd4b8ccbEf873fF053A5d1fFE23BFD636a3BD',
          constructorArguments: [
            '0x51279F26586dA3FF413fc3bee5de39A0069E6062',
            '0xdfE416E61D78855bb47b358353dc3AEa0C0a3ECD',
            '0x63164a32000000000000000000000000835ce0760387bc894e91039a88a00b6a69e65d94000000000000000000000000ff2a2d228e136bcbba2c07939cfab40dcacb6877000000000000000000000000e91df8e200f8ab7a72e9cbdb2b207bec0dfb73c5000000000000000000000000335072aa9dd9fed83dca7bbc72265dda8d06287e00000000000000000000000000bf64ffc153d2436f9424f1f82a34ff6fee333200000000000000000000000000000000000000000000000000000000000186a00000000000000000000000000000000000000000000000000000000000030d4000000000000000000000000000000000000000000000000000000000000000fa00000000000000000000000000000000000000000000000000000000000186a0000000000000000000000000000000000000000000000000000000000000c350000000000000000000000000000000000000000000000000000000000000c350'
          ]
        },
        {
          name: 'AMM',
          address: '0x18C4551050E1D9277196f5e5718e20e22beE3839',
          constructorArguments: [ '0x397Bd4b8ccbEf873fF053A5d1fFE23BFD636a3BD', 86400 ]
        },
        {
          name: 'TransparentUpgradeableProxy',
          impl: 'VAMM',
          address: '0xa85E43e1FA59b1C33505b165CEd2f65bA6B718eA',
          constructorArguments: [
            '0x6e56c1527Fd348A3Be400E15083A1E0f85605Cce',
            '0xdfE416E61D78855bb47b358353dc3AEa0C0a3ECD',
            '0xacfa07a4000000000000000000000000835ce0760387bc894e91039a88a00b6a69e65d940000000000000000000000008f9fca659651d2f3b67997c396cf701971574c38000000000000000000000000bd9842b7d512c49cc2d4a48ba505693f3d8384030000000000000000000000000000000000000000000000000000000000061a80000000000000000000000000000000000000000000000000000083e0717e100000000000000000000000000000000000000000000000000000000000004c4b40000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000084c94623200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000258'
          ]
        },
        {
          name: 'TransparentUpgradeableProxy',
          impl: 'AMM',
          address: '0xAa0a2c901fA879e4927FdAFB17D097734D136fcA',
          constructorArguments: [
            '0x18C4551050E1D9277196f5e5718e20e22beE3839',
            '0xdfE416E61D78855bb47b358353dc3AEa0C0a3ECD',
            '0x55edfbfe00000000000000000000000000000000000000000000000000000000000000c0000000000000000000000000d00ae08403b9bbb9124bb305c09058e32c39a48c000000000000000000000000c1b21d15479dbc3bdab5541d89258c05a3cc63090000000000000000000000000000000000000000000000004563918244f40000000000000000000000000000a85e43e1fa59b1c33505b165ced2f65ba6b718ea000000000000000000000000835ce0760387bc894e91039a88a00b6a69e65d940000000000000000000000000000000000000000000000000000000000000009415641582d504552500000000000000000000000000000000000000000000000'
          ]
        }
    ]
    await Bluebird.map(contracts, async contract => {
        try {
            await hre.run('verify:verify', _.pick(contract, ['address', 'constructorArguments'])) // { address, constructorArguments }
        } catch (e) {
            console.log(`failed in verifying ${contract.name}`, e)
        }
    }, { concurrency: 5 })

    // private contract verification
    console.log('verifications completed, now adding to tenderly...')
    await hre.tenderly.push(
        contracts
        .filter(c => c.name != 'TransparentUpgradeableProxy') // these can be added in a single call
        .map(c => _.pick(c, ['address', 'name']))
    )

    const tups = contracts
        .filter(c => c.name == 'TransparentUpgradeableProxy')
        .map(c => _.pick(c, ['address', 'name']))
    for (let i = 0; i < tups.length; i++) {
        await hre.tenderly.push(tups[i])
    }

    // await hre.tenderly.verify(contract) // public contract verification - not sure what that means tho, because it doesn't verify on snowtrace
}

main()
.catch(error => {
    console.error(error);
    process.exit(1);
});
