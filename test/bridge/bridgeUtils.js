const { ethers } = require('hardhat')
const utils = require('../utils')

const cchainId = 43114
const hubbleChainId = 54321

const ZERO_ADDRESS = ethers.constants.AddressZero
const usdcAvax = '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E'
const priceFeedAvaxToUSD = '0x0A77230d17318075983913bC2145DB16C7366156' // from Chainkink avax net
const priceFeedUSDCToUSD = '0xF096872672F44d6EBA71458D74fe67F9a77a23B9'
const stargateRouterAvax = '0x45A01E4e04F14f7A4a6702c74187c5F6222033cd'
const stargatePoolIdUSDC = 1


async function setupAvaxContracts(proxyAdmin, marginAccountHelper, options = {}) {
    options = Object.assign(
        {
            governance: signers[0].address
        },
        options
    )

    ;([
        LZEndpointMockFactory,
        usdcAvaxInstance,
        avaxPriceFeed,
        usdcPriceFeed,
    ] = await Promise.all([
        ethers.getContractFactory('TestLZEndpointMock'),
        ethers.getContractAt('IERC20', usdcAvax),
        ethers.getContractAt('AggregatorV3Interface', priceFeedAvaxToUSD),
        ethers.getContractAt('AggregatorV3Interface', priceFeedUSDCToUSD),
    ]))

    lzEndpointMockRemote = await LZEndpointMockFactory.deploy(cchainId)
    lzEndpointMockBase = await LZEndpointMockFactory.deploy(hubbleChainId)

    hgtRemote = await utils.setupUpgradeableProxy(
        'HGTRemote',
        proxyAdmin,
        [ options.governance, stargateRouterAvax, hubbleChainId, {
            token: usdcAvax,
            priceFeed: priceFeedUSDCToUSD,
            collectedFee: 0,
            srcPoolId: stargatePoolIdUSDC,
            decimals: 6,
        },
        priceFeedAvaxToUSD ],
        [ lzEndpointMockRemote.address ]
    )

    hgt = await utils.setupUpgradeableProxy(
        'HGT',
        proxyAdmin,
        [ options.governance, marginAccountHelper ],
        [ lzEndpointMockBase.address ]
    )

    const _marginAccountHelper = await ethers.getContractAt('MarginAccountHelper', marginAccountHelper)
    await _marginAccountHelper.setHGT(hgt.address)

    // internal bookkeeping for endpoints (not part of a real deploy, just for this test)
    await lzEndpointMockRemote.setDestLzEndpoint(hgt.address, lzEndpointMockBase.address)
    await lzEndpointMockBase.setDestLzEndpoint(hgtRemote.address, lzEndpointMockRemote.address)

    await hgtRemote.setTrustedRemote(
        hubbleChainId,
        ethers.utils.solidityPack(['address', 'address'], [hgt.address, hgtRemote.address])
    )
    await hgt.setTrustedRemote(
        cchainId,
        ethers.utils.solidityPack(['address', 'address'], [hgtRemote.address, hgt.address])
    )

    res = {
        usdcAvaxInstance,
        hgtRemote,
        hgt,
        avaxPriceFeed,
        usdcPriceFeed,
        lzEndpointMockRemote,
        lzEndpointMockBase
    }
    return res
}

module.exports = {
    setupAvaxContracts,
    hubbleChainId,
    cchainId,
    ZERO_ADDRESS,
}
