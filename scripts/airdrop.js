const { BigNumber } = require('ethers')
const utils = require('../test/utils')

const { constants: { _1e18, _1e6 } } = utils
const _1e8 = BigNumber.from(10).pow(8)

const fs = require('fs')
const csv = require('csv-parser')

let participants = [
    '0x36E24b66Cb2a474D20B33eb9EA49c3c39f1b3A90', // atvanguard
    // '0x831706473e5bFE54987f4D09eB1D8252742aAE6e', // manthan
    // '0x8C0637a96bAcE1b755c79dd9b3A317f8B2585F69', // sam
    // '0xb10a65d7895bA6D91118d64B685c5dCB830ae9B5', // atul
    // // '0x4b3F2072bfEf4D47141a0D8e4E0665603cb26934', // saurabh
    // '0xd568cA490d594214DAAbE604D4Ddf8818003a64d' // atvanguard-2
]

async function airdrop() {
    signers = await ethers.getSigners()
    governance = signers[0].address
    // const vusd = await ethers.getContractAt('VUSD', '0x93dA071feA5C808a4794975D814fb9AF7a05509B')
    const avax = await ethers.getContractAt('ERC20Mintable', '0xd589b48c806Fa417baAa45Ebe5fa3c3D582a39aa')
    // await vusd.mint(governance, _1e6.mul(_1e6))
    await avax.mint(governance, _1e8.mul(170e3))

    let results = []
    return new Promise(async (resolve, reject) => {
        fs.createReadStream('./scripts/hubble-testnet-whitelist.csv')
        .pipe(csv())
        .on('data', (data) => {
            results.push(data.address)
        })
        .on('end', async () => {
            try {
                console.log(results)
                const amount = _1e8.mul(170)
                const disperse = await ethers.getContractAt('Disperse', '0x7a129D401D062CBa58d224573e946aa33AA15750')
                await avax.approve(disperse.address, amount.mul(results.length))
                while(results.length) {
                    await disperse.disperseTokenEqual(avax.address, results.slice(0, 50), amount)
                    results = results.slice(50)
                }
                resolve()
            } catch(e) {
                console.log(e)
                reject()
            }
        });
    })
    // const vusd = await ethers.getContractAt('VUSD', '0x899BFb3479AA6d32D85E1Fd4dbba6E9A814cF60D')
    // // const avax = await ethers.getContractAt('ERC20Mintable', '0x8e8cecF1Ee553D72A60227102397E5128FF9f61F')

    // // const Disperse = await ethers.getContractFactory('Disperse')
    // // const disperse = await Disperse.deploy()
    // // console.log({ disperse: disperse.address })
    // const disperse = await ethers.getContractAt('Disperse', '0x7a129D401D062CBa58d224573e946aa33AA15750')

    // const amount = _1e6.mul(1e3)
    // await vusd.approve(disperse.address, amount.mul(results.length))
    // await disperse.disperseTokenEqual(vusd.address, results, amount)
}

airdrop()
.then(() => process.exit(0))
.catch(error => {
    console.error(error);
    process.exit(1);
});

