const mainnetConfig = {
    "genesisBlock": 18291062,
    "timestamp": 1659792695,
    "contracts": {
        "ClearingHouse": "0x4E3535964Cb5612a466d8bb25362d485452eFcEF",
        "HubbleViewer": "0x51bB52aA9B6B755B293635d8Ef2192Ccf65a9B3e",
        "LiquidationPriceViewer": "0xD56bCc48714A4e58c9Dc96Cb42685B8e79Da0659",
        "MarginAccount": "0x7648675cA85DfB9e2F9C764EbC5e9661ef46055D",
        "Oracle": "0x7511E2ccAe82CdAb12d51F0d1519ad5450F157De",
        "InsuranceFund": "0x870850A72490379f60A4924Ca64BcA89a6D53a9d",
        "Registry": "0xfD704bc28097f1065640022Bee386985bDbc4122",
        "Leaderboard": "0xa3C1E96F7E788DF5a5923c064006e30D17AC588F",
        "BatchLiquidator": "0xeAAFe319454d7bE5C8E5f9Aa5585BeeBAa1BB727",
        "MarginAccountHelper": "0x9Cff75010B16404F2cD58556Db317607A1eebfc5",
        "HubbleReferral": "0x27f48404f6951702EAB36930a6671c459faC0B20",
        "usdc": "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
        "vusd": "0x5c6FC0AaF35A55E7a43Fff45575380bCEdb5Cbc2",
        "TrustedForwarder": "0xEd27FB82DAb4c5384B38aEe8d0Ab81B3b591C0FA",
        "PortfolioManager": "0x2FdaAac29aefa974E72ba224DbC45C6E2b7b0055",
        "amms": [
            {
                "perp": "AVAX-PERP",
                "address": "0xD3575CC24dB98Bfa3C61Da7b484CF3a50a6f4fEd",
                "underlying": "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7",
                "vamm": "0x269Cd1827fCa5c4d3c7748C45708806c026052FE"
            }
        ],
        "collateral": [
            {
                "name": "Hubble USD",
                "ticker": "hUSD",
                "decimals": "6",
                "weight": "1000000",
                "address": "0x5c6FC0AaF35A55E7a43Fff45575380bCEdb5Cbc2"
            },
            {
                "name": "Wrapped AVAX",
                "ticker": "WAVAX",
                "decimals": "18",
                "weight": "800000",
                "address": "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7"
            },
            {
                "name": "Wrapped Ether",
                "ticker": "WETH.e",
                "decimals": "18",
                "weight": "800000",
                "address": "0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB"
            }
        ],
        "thirdParty": {
            "JoeRouter": "0x60aE616a2155Ee3d9A68541Ba4544862310933d4",
            "YakRouter": "0xC4729E56b831d74bBc18797e0e17A295fA77488c"
        },
        // older ones
        "HubbleViewer_0": "0x690EB0F0D9ddC1D3Df1a5E123000B95b8E708447",
        "HubbleViewer_1": "0x6E412ecD0f582DA78D2Dfd51a61e7c06e8744fe5",
        "LiquidationPriceViewer_1": "0x863799D7e804d7b1d7B33dfE0ab1B54B2EEEb2a9"

    },
    "systemParams": {
        "maintenanceMargin": "100000",
        "numCollateral": 2,
        "insuranceFundFee": "250",
        "liquidationFee": "50000"
    }
}

const whirlpoolConfig = {
    "genesisBlock": 11951773,
    "timestamp": 1658830227,
    "contracts": {
        "ClearingHouse": "0xd6693FA24b73d67ef8E19983cda7AAdAcc6B771A",
        "HubbleViewer": "0xE9489E6454Ff7d25E4de74Cbdbfd15f8ce834EaC",
        "LiquidationPriceViewer": "0x4Dd928314b28F91008019B822b0582DC0a409B00",
        "MarginAccount": "0x5124C2dD88B68DB9E5a142dB6E515E8325CeBd20",
        "Oracle": "0x17803c2abE66139d478fA36e4e5Fef4e3aa57054",
        "InsuranceFund": "0x4e3CF7C40FeB07689af4175f444B2a39633E8f4d",
        "Registry": "0xb3C825B5c692fe53054F04B80d947A1966446a28",
        "Leaderboard": "0xdD3f0a3710a4219F33D3919DD08657F2C92eCD5e",
        "MarginAccountHelper": "0x9F52Ec123A3180E6b2Ec6Bf16a41949dADF94a03",
        "HubbleReferral": "0x19A71B4A0F9DcE41366a5F0de4F808937f55948A",
        "usdc": "0xBdAB32601ABbD79efF36bB23A4EFEBE334ffA09c",
        "vusd": "0x4875E6621e9547f858fB88379B56909315607299",
        "TrustedForwarder": "0xaCEc31046a2B59B75E8315Fe4BCE4Da943237817",
        "PortfolioManager": "0x61addfc55ecc7382f804ce081289c8dc1ee41113",
        "amms": [
            {
                "perp": "AVAX-PERP",
                "address": "0x2F3363F05Aa37c18eb7BE4aE3E1bB51601237bA5",
                "underlying": "0xd00ae08403B9bbb9124bB305C09058E32C39A48c",
                "vamm": "0xdBf9c6EDFB852F19A57627196b1c7046FCBc45a3"
            }
        ],
        "collateral": [
            {
                "name": "Hubble USD",
                "ticker": "hUSD",
                "decimals": "6",
                "weight": "1000000",
                "address": "0x4875E6621e9547f858fB88379B56909315607299"
            },
            {
                "name": "Wrapped AVAX",
                "ticker": "WAVAX",
                "decimals": "18",
                "weight": "800000",
                "address": "0xd00ae08403B9bbb9124bB305C09058E32C39A48c"
            }
        ],
        "thirdParty": {
            "JoeRouter": "0xd7f655E3376cE2D7A2b08fF01Eb3B1023191A901",
            "YakRouter": "0x0000000000000000000000000000000000000000"
        },
        // older ones
        "HubbleViewer_0": "0x4ecc1d18e39442d4671f10e921a3da63e757ba26",
        "LiquidationPriceViewer_0": "0xE219234455Fc75a12E3723100e6D0C4De77Fb9E9"
    },
    "systemParams": {
        "maintenanceMargin": "100000",
        "numCollateral": 2,
        "insuranceFundFee": "250",
        "liquidationFee": "50000"
    }
}

module.exports = { mainnetConfig, whirlpoolConfig }
