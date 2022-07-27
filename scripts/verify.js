const Bluebird = require('bluebird')
const _ = require('lodash')

async function main() {
    // whirlpool
    const contracts = [
      {
        name: 'VUSD',
        address: '0x129656515Dc848F8e55fb48e988E7f66ec96Df5b',
        constructorArguments: [ '0xbdab32601abbd79eff36bb23a4efebe334ffa09c' ]
      },
      {
        name: 'TransparentUpgradeableProxy',
        impl: 'VUSD',
        address: '0x4875E6621e9547f858fB88379B56909315607299',
        constructorArguments: [
          '0x129656515Dc848F8e55fb48e988E7f66ec96Df5b',
          '0xdfE416E61D78855bb47b358353dc3AEa0C0a3ECD',
          '0x4cd88b7600000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000000a487562626c65205553440000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000046855534400000000000000000000000000000000000000000000000000000000'
        ]
      },
      {
        name: 'MarginAccount',
        address: '0xF7Ac5a7C6BfA0c864c41934cA0aAC14F5790c0A4',
        constructorArguments: [ '0xaCEc31046a2B59B75E8315Fe4BCE4Da943237817' ]
      },
      {
        name: 'TransparentUpgradeableProxy',
        impl: 'MarginAccount',
        address: '0x5124C2dD88B68DB9E5a142dB6E515E8325CeBd20',
        constructorArguments: [
          '0xF7Ac5a7C6BfA0c864c41934cA0aAC14F5790c0A4',
          '0xdfE416E61D78855bb47b358353dc3AEa0C0a3ECD',
          '0x485cc955000000000000000000000000835ce0760387bc894e91039a88a00b6a69e65d940000000000000000000000004875e6621e9547f858fb88379b56909315607299'
        ]
      },
      {
        name: 'MarginAccountHelper',
        address: '0x9F52Ec123A3180E6b2Ec6Bf16a41949dADF94a03',
        constructorArguments: [
          '0x5124C2dD88B68DB9E5a142dB6E515E8325CeBd20',
          '0x4875E6621e9547f858fB88379B56909315607299',
          '0xd00ae08403B9bbb9124bB305C09058E32C39A48c'
        ]
      },
      {
        name: 'InsuranceFund',
        address: '0xCf00ff8e06171862b9DDf2362c7EA01383C60aD3',
        constructorArguments: []
      },
      {
        name: 'TransparentUpgradeableProxy',
        impl: 'InsuranceFund',
        address: '0x4e3CF7C40FeB07689af4175f444B2a39633E8f4d',
        constructorArguments: [
          '0xCf00ff8e06171862b9DDf2362c7EA01383C60aD3',
          '0xdfE416E61D78855bb47b358353dc3AEa0C0a3ECD',
          '0xc4d66de8000000000000000000000000835ce0760387bc894e91039a88a00b6a69e65d94'
        ]
      },
      {
        name: 'Oracle',
        address: '0xE3B9E1aBc2491FA147fD177622419CBdB8386244',
        constructorArguments: []
      },
      {
        name: 'TransparentUpgradeableProxy',
        impl: 'Oracle',
        address: '0x17803c2abE66139d478fA36e4e5Fef4e3aa57054',
        constructorArguments: [
          '0xE3B9E1aBc2491FA147fD177622419CBdB8386244',
          '0xdfE416E61D78855bb47b358353dc3AEa0C0a3ECD',
          '0xc4d66de8000000000000000000000000835ce0760387bc894e91039a88a00b6a69e65d94'
        ]
      },
      {
        name: 'HubbleReferral',
        address: '0xcAfa81f62dc65E3a1ADab3c1a00dFAe340434a84',
        constructorArguments: []
      },
      {
        name: 'TransparentUpgradeableProxy',
        impl: 'HubbleReferral',
        address: '0x19A71B4A0F9DcE41366a5F0de4F808937f55948A',
        constructorArguments: [
          '0xcAfa81f62dc65E3a1ADab3c1a00dFAe340434a84',
          '0xdfE416E61D78855bb47b358353dc3AEa0C0a3ECD',
          '0x'
        ]
      },
      {
        name: 'ClearingHouse',
        address: '0xB2BB1b6a68a1e31418CCF23324A7F1b45fD50d58',
        constructorArguments: [ '0xaCEc31046a2B59B75E8315Fe4BCE4Da943237817' ]
      },
      {
        name: 'TransparentUpgradeableProxy',
        impl: 'ClearingHouse',
        address: '0xd6693FA24b73d67ef8E19983cda7AAdAcc6B771A',
        constructorArguments: [
          '0xB2BB1b6a68a1e31418CCF23324A7F1b45fD50d58',
          '0xdfE416E61D78855bb47b358353dc3AEa0C0a3ECD',
          '0x63164a32000000000000000000000000835ce0760387bc894e91039a88a00b6a69e65d940000000000000000000000004e3cf7c40feb07689af4175f444b2a39633e8f4d0000000000000000000000005124c2dd88b68db9e5a142db6e515e8325cebd200000000000000000000000004875e6621e9547f858fb88379b5690931560729900000000000000000000000019a71b4a0f9dce41366a5f0de4f808937f55948a00000000000000000000000000000000000000000000000000000000000186a00000000000000000000000000000000000000000000000000000000000030d4000000000000000000000000000000000000000000000000000000000000000fa00000000000000000000000000000000000000000000000000000000000186a0000000000000000000000000000000000000000000000000000000000000c350000000000000000000000000000000000000000000000000000000000000c350'
        ]
      },
      {
        name: 'AMM',
        address: '0xb6d32A3D77f5D2894261F388985276E4995D50ca',
        constructorArguments: [ '0xd6693FA24b73d67ef8E19983cda7AAdAcc6B771A', 86400 ]
      },
      {
        name: 'TransparentUpgradeableProxy',
        impl: 'VAMM',
        address: '0xdBf9c6EDFB852F19A57627196b1c7046FCBc45a3',
        constructorArguments: [
          '0xE416b538F9904E2B1AC04Fb7da83C51B55D56038',
          '0xdfE416E61D78855bb47b358353dc3AEa0C0a3ECD',
          '0xacfa07a4000000000000000000000000835ce0760387bc894e91039a88a00b6a69e65d94000000000000000000000000beb5425ef960b3a816f60560e0cc14ca8d009f12000000000000000000000000683fc29d0fb0a69cce715f03983024f28668873f0000000000000000000000000000000000000000000000000000000000061a80000000000000000000000000000000000000000000000000000083e0717e100000000000000000000000000000000000000000000000000000000000004c4b40000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000084c94623200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000258'
        ]
      },
      {
        name: 'TransparentUpgradeableProxy',
        impl: 'AMM',
        address: '0x2F3363F05Aa37c18eb7BE4aE3E1bB51601237bA5',
        constructorArguments: [
          '0xb6d32A3D77f5D2894261F388985276E4995D50ca',
          '0xdfE416E61D78855bb47b358353dc3AEa0C0a3ECD',
          '0x55edfbfe00000000000000000000000000000000000000000000000000000000000000c0000000000000000000000000d00ae08403b9bbb9124bb305c09058e32c39a48c00000000000000000000000017803c2abe66139d478fa36e4e5fef4e3aa570540000000000000000000000000000000000000000000000004563918244f40000000000000000000000000000dbf9c6edfb852f19a57627196b1c7046fcbc45a3000000000000000000000000835ce0760387bc894e91039a88a00b6a69e65d940000000000000000000000000000000000000000000000000000000000000009415641582d504552500000000000000000000000000000000000000000000000'
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
