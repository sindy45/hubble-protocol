const { BigNumber } = require('ethers')
const utils = require('../test/utils')

const { constants: { _1e18, _1e6 } } = utils
const _1e8 = BigNumber.from(10).pow(8)

const fs = require('fs')
const csv = require('csv-parser')

let friends = [
    '0x36E24b66Cb2a474D20B33eb9EA49c3c39f1b3A90', // atvanguard
    '0x831706473e5bFE54987f4D09eB1D8252742aAE6e', // manthan
    '0x8C0637a96bAcE1b755c79dd9b3A317f8B2585F69', // sam
    '0xb10a65d7895bA6D91118d64B685c5dCB830ae9B5', // atul
    '0x4b3F2072bfEf4D47141a0D8e4E0665603cb26934', // saurabh
    '0xd568cA490d594214DAAbE604D4Ddf8818003a64d', // atvanguard-2
    '0x05A99D4be22cf4c1C4a79a9A21f260f85810f3c1', // roy - Caballeros Capital
    '0xB723d57c4d54a6E8f97D4CDfDb7Ee723B50398B1', // roy-2 - Caballeros Capital
]

async function airdrop() {
    signers = await ethers.getSigners()
    governance = signers[0].address

    const vusd = await ethers.getContractAt('VUSD', '0x93dA071feA5C808a4794975D814fb9AF7a05509B')
    const avax = await ethers.getContractAt('ERC20Mintable', '0xd589b48c806Fa417baAa45Ebe5fa3c3D582a39aa')
    const disperse = await ethers.getContractAt('Disperse', '0x7a129D401D062CBa58d224573e946aa33AA15750')

    // await vusd.mint(governance, _1e6.mul(_1e6))
    // await avax.mint(governance, _1e8.mul(170e3))
    // await avax.approve(disperse.address, ethers.constants.MaxUint256)
    // await vusd.approve(disperse.address, ethers.constants.MaxUint256)

    // let participants = friends
    const participants = await parseCsv()

    const vusdAmount = _1e6.mul(1000)
    const avaxAmount = _1e8.mul(170)

    console.log(participants)
    while (participants.length) {
        await disperse.disperseTokenEqual(avax.address, participants.slice(0, 50), avaxAmount)
        await disperse.disperseTokenEqual(vusd.address, participants.slice(0, 50), vusdAmount)
        participants = participants.slice(50)
    }
}

function parseCsv() {
    let results = []
    return new Promise(async (resolve, reject) => {
        fs.createReadStream('./scripts/hubble-testnet-whitelist.csv')
        .pipe(csv())
        .on('data', (data) => {
            results.push(data.address)
        })
        .on('end', async () => {
            try {
                resolve(results)
            } catch(e) {
                reject(e)
            }
        });
    })
}

airdrop()
.then(() => process.exit(0))
.catch(error => {
    console.error(error);
    process.exit(1);
});
