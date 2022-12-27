// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

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
    enum Mode { Maintenance_Margin, Min_Allowable_Margin }
    function settleFunding() external;
    function getTotalNotionalPositionAndUnrealizedPnl(address trader, int256 margin, Mode mode)
        external
        view
        returns(uint256 notionalPosition, int256 unrealizedPnl);
    function isAboveMaintenanceMargin(address trader) external view returns(bool);
    function assertMarginRequirement(address trader) external view;
    function updatePositions(address trader) external;
    function getMarginFraction(address trader) external view returns(int256);
    function getTotalFunding(address trader) external view returns(int256 totalFunding);
    function getAmmsLength() external view returns(uint);
    function amms(uint idx) external view returns(IAMM);
    function maintenanceMargin() external view returns(int256);
    function minAllowableMargin() external view returns(int256);
    function tradeFee() external view returns(uint256);
    function liquidationPenalty() external view returns(uint256);
    function getNotionalPositionAndMargin(address trader, bool includeFundingPayments, Mode mode)
        external
        view
        returns(uint256 notionalPosition, int256 margin);
    function liquidate(address trader) external;
    function liquidateTaker(address trader) external;
    function insuranceFund() external view returns(IInsuranceFund);
    function calcMarginFraction(address trader, bool includeFundingPayments, Mode mode) external view returns(int256);
}

interface ERC20Detailed {
    function decimals() external view returns (uint8);
}

interface IInsuranceFund {
    function seizeBadDebt(uint amount) external;
    function startAuction(address token) external;
    function calcVusdAmountForAuction(address token, uint amount) external view returns(uint);
    function buyCollateralFromAuction(address token, uint amount) external;
}

interface IAMM {
    struct Order {
        address trader;
        int256 baseAssetQuantity;
        uint256 price;
        uint256 salt;
    }

    enum OrderStatus {
        Unfilled,
        Filled,
        Cancelled
    }
    function openPosition(Order memory order, bytes memory signature, int256 fillAmount)
        external
        returns (int realizedPnl, uint quoteAsset, bool isPositionIncreased);
    function getNotionalPositionAndUnrealizedPnl(address trader)
        external
        view
        returns(uint256 notionalPosition, int256 unrealizedPnl, int256 size, uint256 openNotional);
    function updatePosition(address trader) external returns(int256 fundingPayment);
    function liquidatePosition(address trader) external returns (int realizedPnl, int baseAsset, uint quoteAsset);
    function settleFunding() external;
    function underlyingAsset() external view returns (address);
    function positions(address trader) external view returns (int256,uint256,int256,uint256);
    function getNotionalPosition(int256 baseAssetQuantity) external view returns(uint256 quoteAssetQuantity);
    function getPendingFundingPayment(address trader)
        external
        view
        returns(
            int256 takerFundingPayment,
            int256 latestCumulativePremiumFraction
        );
    function getOpenNotionalWhileReducingPosition(int256 positionSize, uint256 notionalPosition, int256 unrealizedPnl, int256 baseAssetQuantity)
        external
        pure
        returns(uint256 remainOpenNotional, int realizedPnl);
    function isOverSpreadLimit() external view returns (bool);
    function getOracleBasedPnl(address trader, int256 margin, IClearingHouse.Mode mode) external view returns (uint, int256);
    function lastPrice() external view returns(uint256);
}

// for backward compatibility in forked tests
interface IAMM_old is IAMM {
    function setMaxOracleSpreadRatio(uint) external;
}

interface IMarginAccount {
    struct Collateral {
        IERC20 token;
        uint weight;
        uint8 decimals;
    }

    enum LiquidationStatus {
        IS_LIQUIDATABLE,
        OPEN_POSITIONS,
        NO_DEBT,
        ABOVE_THRESHOLD
    }

    function addMargin(uint idx, uint amount) external;
    function addMarginFor(uint idx, uint amount, address to) external;
    function removeMargin(uint idx, uint256 amount) external;
    function getSpotCollateralValue(address trader) external view returns(int256 spot);
    function weightedAndSpotCollateral(address trader) external view returns(int256, int256);
    function getNormalizedMargin(address trader) external view returns(int256);
    function realizePnL(address trader, int256 realizedPnl) external;
    function isLiquidatable(address trader, bool includeFunding) external view returns(LiquidationStatus, uint, uint);
    function supportedAssetsLen() external view returns(uint);
    function supportedAssets() external view returns (Collateral[] memory);
    function margin(uint idx, address trader) external view returns(int256);
    function transferOutVusd(address recipient, uint amount) external;
    function liquidateExactRepay(address trader, uint repay, uint idx, uint minSeizeAmount) external;
    function oracle() external view returns(IOracle);
    function removeMarginFor(address trader, uint idx, uint256 amount) external;
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

interface IERC20FlexibleSupply is IERC20 {
    function mint(address to, uint256 amount) external;
    function burn(uint256 amount) external;
}

interface IVUSD is IERC20 {
    function mintWithReserve(address to, uint amount) external;
    function reserveToken() external view returns(address);
    function withdraw(uint amount) external;
    function processWithdrawals() external;
}

interface IUSDC is IERC20FlexibleSupply {
    function masterMinter() external view returns(address);
    function configureMinter(address minter, uint256 minterAllowedAmount) external;
}

interface IHubbleViewer {
    function clearingHouse() external returns(IClearingHouse);
    function marginAccount() external returns(IMarginAccount);
    function getQuote(int256 baseAssetQuantity, uint idx) external view returns(uint256 quoteAssetQuantity);
}

interface IHubbleReferral {
    function getTraderRefereeInfo(address trader) external view returns (address referrer);
}

interface IJoeRouter02 {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
    function swapTokensForExactTokens(
        uint256 amountOut,
        uint256 amountInMax,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
    function factory() external view returns(address);
    function getAmountsIn(uint256 amountOut, address[] calldata path) external view returns (uint256[] memory amounts);
    function getAmountsOut(uint256 amountOut, address[] calldata path) external view returns (uint256[] memory amounts);
}

interface IJoePair {
    function swap(
        uint256 amount0Out,
        uint256 amount1Out,
        address to,
        bytes calldata data
    ) external;
}

interface IJoeFactory {
    function getPair(address tokenA, address tokenB) external view returns (address pair);
}

interface IWAVAX is IERC20 {
    function deposit() external payable;
    function withdraw(uint256) external;
}

interface IYakRouter {
    struct Trade {
        uint amountIn;
        uint amountOut;
        address[] path;
        address[] adapters;
    }

    struct FormattedOfferWithGas {
        uint[] amounts;
        address[] adapters;
        address[] path;
        uint gasEstimate;
    }

    struct FormattedOffer {
        uint[] amounts;
        address[] adapters;
        address[] path;
    }

    function swapNoSplit(
        Trade calldata _trade,
        address _to,
        uint _fee
    ) external;

    function findBestPathWithGas(
        uint256 _amountIn,
        address _tokenIn,
        address _tokenOut,
        uint _maxSteps,
        uint _gasPrice
    ) external view returns(FormattedOfferWithGas memory);

    function findBestPath(
        uint256 _amountIn,
        address _tokenIn,
        address _tokenOut,
        uint _maxSteps
    ) external view returns(FormattedOffer memory);
}
