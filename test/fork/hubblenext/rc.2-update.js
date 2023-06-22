const { expect } = require('chai')
const { BigNumber } = require('ethers')
const { ethers } = require('hardhat')

const hubblev2next = require('../../../scripts/hubblev2next')
const config = hubblev2next.contracts

const {
    impersonateAccount,
    constants: { _1e6 }
} = require('../../utils')

const deployer = '0xeAA6AE79bD3d042644D91edD786E4ed3d783Ca2d' // governance
const redstoneAdapterAddress = '0x91661D7757C0ec1bdBb04D51b7a1039e30D6dcc9'

describe('hubblenext-rc.2 update (redstone)', async function() {
    let blockNumber = 577970

    before(async function() {
        await network.provider.request({
            method: "hardhat_reset",
            params: [{
                forking: {
                    jsonRpcUrl: process.env.RPC_URL_ARCHIVE,
                    blockNumber
                }
            }]
        })

        await impersonateAccount(deployer)
        signer = ethers.provider.getSigner(deployer)
        ;([proxyAdmin, ethAmm, avaxAmm, redstoneAdapter] = await Promise.all([
            ethers.getContractAt('ProxyAdmin', config.proxyAdmin),
            ethers.getContractAt('AMM', config.amms[0].address),
            ethers.getContractAt('AMM', config.amms[1].address),
            ethers.getContractAt('IRedstoneAdapter', redstoneAdapterAddress)
        ]))
    })

    after(async function() {
        await network.provider.request({
            method: "hardhat_reset",
            params: [],
        });
    })

    it('redstone data is as expected', async function() {
        const RED_STONE_VALUES_MAPPING_STORAGE_LOCATION = '0x4dd0c77efa6f6d590c97573d8c70b714546e7311202ff7c11c484cc841d91bfc' // keccak256("RedStone.oracleValuesMapping");
        const RED_STONE_LATEST_ROUND_ID_STORAGE_LOCATION = '0xc68d7f1ee07d8668991a8951e720010c9d44c2f11c06b5cac61fbc4083263938' // keccak256("RedStone.latestRoundId");

        ;({ latestRoundId } = await redstoneAdapter.getLatestRoundParams())
        let storage = await ethers.provider.getStorageAt(redstoneAdapterAddress, RED_STONE_LATEST_ROUND_ID_STORAGE_LOCATION)
        expect(BigNumber.from(storage)).to.equal(latestRoundId)

        for (let i = 0; i < 2; i++) { // only eth and avax markets
            let slot = ethers.utils.keccak256(ethers.utils.solidityPack(
                ['bytes32', 'uint256', 'bytes32'],
                [
                    config.amms[i].redStoneFeedId,
                    latestRoundId,
                    RED_STONE_VALUES_MAPPING_STORAGE_LOCATION
                ]
            ))
            let price = await redstoneAdapter.getValueForDataFeedAndRound(config.amms[i].redStoneFeedId, latestRoundId)
            storage = await ethers.provider.getStorageAt(redstoneAdapterAddress, slot)
            expect(BigNumber.from(storage)).to.equal(price)
        }
    })

    it('deploy new oracle', async function() {
        const Oracle = await ethers.getContractFactory('NewOracle')
        newOracle = await Oracle.connect(signer).deploy()
        oracle = await ethers.getContractAt('NewOracle', newOracle.address)
        await oracle.connect(signer).setStablePrice(config.vusd, _1e6) // vusd
    })

    it('eth feed', async function() {
        await oracle.connect(signer).setAggregator(config.amms[0].underlying, config.amms[0].redStoneOracle)
        expect(await oracle.getUnderlyingPrice(config.amms[0].underlying)).to.equal('1871840077')
        // expect(await oracle.getUnderlyingTwapPrice(config.amms[0].underlying, 3600)).to.equal('1876996378')
    })

    it('avax feed', async function() {
        await oracle.connect(signer).setAggregator(config.amms[1].underlying, config.amms[1].redStoneOracle)
        expect(await oracle.getUnderlyingPrice(config.amms[1].underlying)).to.equal('12909540')
        // expect(await oracle.getUnderlyingTwapPrice(config.amms[1].underlying, 3600)).to.equal('12938981')
    })

    it('update amms', async function() {
        const AMM = await ethers.getContractFactory('AMM')
        const newAMM = await AMM.deploy(config.ClearingHouse)
        for (let i = 0; i < 2; i++) { // only eth and avax markets
            await proxyAdmin.connect(signer).upgrade(config.amms[i].address, newAMM.address)
            const amm = await ethers.getContractAt('AMM', config.amms[i].address)
            await amm.connect(signer).setOracleConfig(newOracle.address, '0x91661D7757C0ec1bdBb04D51b7a1039e30D6dcc9' /* adapter address */, config.amms[i].redStoneFeedId)
        }
    })

    it('feeds after update', async function() {
        expect(await ethAmm.getUnderlyingPrice()).to.eq(BigNumber.from(await redstoneAdapter.getValueForDataFeedAndRound(config.amms[0].redStoneFeedId, latestRoundId)).div(100))
        expect(await ethAmm.getUnderlyingTwapPrice(3600)).to.eq(await oracle.getUnderlyingTwapPrice(config.amms[0].underlying, 3600))

        expect(await avaxAmm.getUnderlyingPrice()).to.eq(BigNumber.from(await redstoneAdapter.getValueForDataFeedAndRound(config.amms[1].redStoneFeedId, latestRoundId)).div(100))
        expect(await avaxAmm.getUnderlyingTwapPrice(3600)).to.eq(await oracle.getUnderlyingTwapPrice(config.amms[1].underlying, 3600))
    })
})
