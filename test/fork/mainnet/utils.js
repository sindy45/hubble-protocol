const config = {
    "genesisBlock": 18291062,
    "timestamp": 1659792695,
    "contracts": {
      "ClearingHouse": "0x4E3535964Cb5612a466d8bb25362d485452eFcEF",
      "HubbleViewer": "0x690EB0F0D9ddC1D3Df1a5E123000B95b8E708447",
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
        }
      ]
    },
    "systemParams": {
      "maintenanceMargin": "100000",
      "numCollateral": 2,
      "insuranceFundFee": "250",
      "liquidationFee": "50000"
    }
}

module.exports = {
    config
}