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
    function getUnrealizedPnL(address trade) external returns(int256);
    function getNotionalPositionAndUnrealizedPnl(address trader)
        external
        view
        returns(uint256 notionalPosition, int256 unrealizedPnl);
    function updatePosition(address trader) external returns(int256 fundingPayment);
    function closePosition(address trader) external returns (int realizedPnl, uint quoteAsset);
    function settleFunding() external returns (int256, int256, int256);
    function underlyingAsset() external view returns (address);
    function precision() external view returns (int256);
    function positions(address trader) external view returns (int256,uint256,int256);
}

interface IMarginAccount {
    function getNormalizedMargin(address trader) external view returns(int256);
    function realizePnL(address trader, int256 realizedPnl) external;
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

    function last_prices(uint256 k) external view returns(uint256);
    function price_oracle(uint256 k) external view returns(uint256);
}
