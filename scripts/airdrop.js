const { BigNumber } = require('ethers')
const utils = require('../test/utils')

const { constants: { _1e18, _1e6 } } = utils
const _1e8 = BigNumber.from(10).pow(8)

const fs = require('fs')
const csv = require('csv-parser')

const BATCH_SIZE = 150

const friends = [
    '0x36E24b66Cb2a474D20B33eb9EA49c3c39f1b3A90', // atvanguard
    '0x831706473e5bFE54987f4D09eB1D8252742aAE6e', // manthan
    '0x8C0637a96bAcE1b755c79dd9b3A317f8B2585F69', // sam
    '0xb10a65d7895bA6D91118d64B685c5dCB830ae9B5', // atul
    '0x4b3F2072bfEf4D47141a0D8e4E0665603cb26934', // saurabh
    '0xd568cA490d594214DAAbE604D4Ddf8818003a64d', // atvanguard-2
]

async function airdrop() {
    const [ signer ] = await ethers.getSigners()
    const governance = signer.address

    // const vusd = await ethers.getContractAt('VUSD', '0x93dA071feA5C808a4794975D814fb9AF7a05509B')
    avax = await ethers.getContractAt('ERC20Mintable', '0xd589b48c806Fa417baAa45Ebe5fa3c3D582a39aa')
    weth = await ethers.getContractAt('ERC20Mintable', '0xC1B33A334d34d72A503DfF50e97549503fFc760F')
    btc = await ethers.getContractAt('ERC20Mintable', '0xFD7483C75c7C5eD7910c150A3FDf62cEa707E4dE')
    link = await ethers.getContractAt('ERC20Mintable', '0x1577a55b8b0dbCb4b90E7193295333d3B334f0F2')

    const disperse = await ethers.getContractAt('Disperse', '0x7a129D401D062CBa58d224573e946aa33AA15750')

    // await vusd.mint(governance, _1e6.mul(_1e6))
    await avax.mint(governance, _1e8.mul(191000))
    await weth.mint(governance, _1e18.mul(9000))
    await btc.mint(governance, _1e8.mul(1500))
    await link.mint(governance, _1e8.mul(270000))

    // await vusd.approve(disperse.address, ethers.constants.MaxUint256)
    // await avax.approve(disperse.address, ethers.constants.MaxUint256)
    await weth.approve(disperse.address, ethers.constants.MaxUint256)
    await btc.approve(disperse.address, ethers.constants.MaxUint256)
    await link.approve(disperse.address, ethers.constants.MaxUint256)

    // let participants = friends

    // const cohort1 = await parseCsv('./scripts/cohorts/testnaut-cohort-1.csv')
    const cohort1 = fs.readFileSync('./scripts/cohorts/cohort-1-active.txt').toString().split(',')
    const cohort2 = await parseCsv('./scripts/cohorts/testnaut-cohort-2.csv')
    const cohorts = cohort1.concat(cohort2)
    let participants = {}
    for (i = 0; i < cohorts.length; i++) {
        if (cohorts[i] != '0x36E24b66Cb2a474D20B33eb9EA49c3c39f1b3A90' && cohorts[i] != '0x831706473e5bFE54987f4D09eB1D8252742aAE6e') {
            participants[cohorts[i]] = true
        }
    }
    participants = Object.keys(participants)

    console.log(`airdropping to ${participants.length} participants...`)

    // const vusdAmount = _1e6.mul(1000)
    const avaxAmount = _1e8.mul(150)
    const ethAmount = _1e18.mul(6)
    const btcAmount = _1e8.mul(1)
    const linkAmount = _1e8.mul(175)

    let nonce = await signer.getTransactionCount()
    while(participants.length) {
        await Promise.all([
            disperse.disperseTokenEqual(avax.address, participants.slice(0, BATCH_SIZE), avaxAmount.mul(5), { nonce: nonce++ }),
            disperse.disperseTokenEqual(weth.address, participants.slice(0, BATCH_SIZE), ethAmount.mul(5), { nonce: nonce++ }),
            disperse.disperseTokenEqual(btc.address, participants.slice(0, BATCH_SIZE), btcAmount.mul(5), { nonce: nonce++ }),
            disperse.disperseTokenEqual(link.address, participants.slice(0, BATCH_SIZE), linkAmount.mul(5), { nonce: nonce++ })
        ])
        participants = participants.slice(BATCH_SIZE)
    }
}

function parseCsv(path) {
    let results = []
    return new Promise(async (resolve, reject) => {
        fs.createReadStream(path)
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

function sleep(s) {
    return new Promise(resolve => setTimeout(resolve, s * 1000));
}

airdrop()
.then(() => process.exit(0))
.catch(error => {
    console.error(error);
    process.exit(1);
});
