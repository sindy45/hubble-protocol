// SPDX-License-Identifier: MIT

pragma solidity 0.8.4;

interface IRegistry {
    function oracle() external view returns(address);
    function clearingHouse() external view returns(address);
    function vusd() external view returns(address);
    function insuranceFund() external view returns(address);
    function marginAccount() external view returns(address);
}

interface IOracle {
    function getUnderlyingPrice(address asset) external view returns(int256);
    function getUnderlyingTwapPrice(address asset, uint256 intervalInSeconds) external view returns (int256);
}

interface IClearingHouse {
    function getTotalNotionalPositionAndUnrealizedPnl(address trader)
        external
        view
        returns(int256 notionalPosition, int256 unrealizedPnl);
    function isAboveMaintenanceMargin(address trader) external view returns(bool);
    function updatePositions(address trader) external;
    function getMarginFraction(address trader) external view returns(uint256);
    function getTotalFunding(address trader) external view returns(int256 totalFunding);
}

interface ERC20Detailed {
    function decimals() external view returns (uint8);
}

interface IInsuranceFund {
    function seizeBadDebt(uint amount) external;
}

interface IAMM {
    function openPosition(address trader, int256 baseAssetQuantity, uint quoteAssetLimit)
        external
        returns (int realizedPnl, uint quoteAsset, bool isPositionIncreased);
    function addLiquidity(address trader, uint baseAssetQuantity, uint quoteAssetLimit) external;
    function getUnrealizedPnL(address trade) external returns(int256);
    function getNotionalPositionAndUnrealizedPnl(address trader)
        external
        view
        returns(uint256 notionalPosition, int256 unrealizedPnl, int256 size, uint256 openNotional);
    function updatePosition(address trader) external returns(int256 fundingPayment);
    function liquidatePosition(address trader) external returns (int realizedPnl, uint quoteAsset);
    function settleFunding() external returns (int256, int256);
    function underlyingAsset() external view returns (address);
    function positions(address trader) external view returns (int256,uint256,int256);
    function getQuote(int256 baseAssetQuantity) external view returns(uint256 qouteAssetQuantity);
    function getFundingPayment(address trader) external view returns(int256 fundingPayment, int256 latestCumulativePremiumFraction);
    function getOpenNotionalWhileReducingPosition(int256 positionSize, uint256 notionalPosition, int256 unrealizedPnl, int256 baseAssetQuantity, uint quoteAsset)
        external
        pure
        returns(uint256 remainOpenNotional, int realizedPnl);
}

interface IMarginAccount {
    function getNormalizedMargin(address trader) external view returns(int256);
    function realizePnL(address trader, int256 realizedPnl) external;
    function isLiquidatable(address trader) external view returns(bool, uint, uint);
}

interface IVAMM {
    function balances(uint256) external view returns (uint256);

    function get_dy(
        uint256 i,
        uint256 j,
        uint256 dx
    ) external view returns (uint256);

    function get_dx(
        uint256 i,
        uint256 j,
        uint256 dy
    ) external view returns (uint256);

    function exchange(
        uint256 i,
        uint256 j,
        uint256 dx,
        uint256 min_dy
    ) external returns (uint256 dy);

    function exchangeExactOut(
        uint256 i,
        uint256 j,
        uint256 dy,
        uint256 max_dx
    ) external returns (uint256 dx);

    function get_notional(uint256 amount, uint256 vUSD, uint256 vAsset, int256 dx, uint256 openNotional) external view returns (uint256, int256, int256, int256);
    function last_prices(uint256 k) external view returns(uint256);
    function price_oracle(uint256 k) external view returns(uint256);
    function price_scale(uint256 k) external view returns(uint256);
    function add_liquidity(uint256[3] calldata amounts, uint256 min_mint_amount) external returns (uint256);
    function get_maker_position(uint256 amount, uint256 vUSD, uint256 vAsset) external view returns (uint256, int256);
}

interface AggregatorV3Interface {

    function decimals() external view returns (uint8);
    function description() external view returns (string memory);
    function version() external view returns (uint256);

    // getRoundData and latestRoundData should both raise "No data present"
    // if they do not have data to report, instead of returning unset values
    // which could be misinterpreted as actual reported values.
    function getRoundData(uint80 _roundId)
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );
    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );
}
