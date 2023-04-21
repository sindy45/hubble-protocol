// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IRegistry {
    function oracle() external view returns(address);
    function clearingHouse() external view returns(address);
    function vusd() external view returns(address);
    function insuranceFund() external view returns(address);
    function marginAccount() external view returns(address);
    function orderBook() external view returns(address);
}

interface IOracle {
    function getUnderlyingPrice(address asset) external view returns(int256);
    function getUnderlyingTwapPrice(address asset, uint256 intervalInSeconds) external view returns (int256);
}

interface IClearingHouse {
    enum Mode { Maintenance_Margin, Min_Allowable_Margin }

    event PositionModified(address indexed trader, uint indexed idx, int256 baseAsset, uint price, int256 realizedPnl, int256 size, uint256 openNotional, int256 fee, uint256 timestamp);
    event PositionLiquidated(address indexed trader, uint indexed idx, int256 baseAsset, uint256 price, int256 realizedPnl, int256 size, uint256 openNotional, int256 fee, uint256 timestamp);
    event MarketAdded(uint indexed idx, address indexed amm);
    event ReferralBonusAdded(address indexed referrer, uint referralBonus);
    event FundingPaid(address indexed trader, uint indexed idx, int256 takerFundingPayment, int256 cumulativePremiumFraction);
    event FundingRateUpdated(uint indexed idx, int256 premiumFraction, uint256 underlyingPrice, int256 cumulativePremiumFraction, uint256 nextFundingTime, uint256 timestamp, uint256 blockNumber);

    function orderBook() external view returns(IOrderBook);
    function getRequiredMargin(int256 baseAssetQuantity, uint256 price) external view returns(uint marginRequired);
    function openComplementaryPositions(
        IOrderBook.Order[2] memory orders,
        IOrderBook.MatchInfo[2] memory matchInfo,
        int256 fillAmount,
        uint fulfillPrice
    )  external;

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
    function takerFee() external view returns(int256);
    function makerFee() external view returns(int256);
    function liquidationPenalty() external view returns(uint256);
    function getNotionalPositionAndMargin(address trader, bool includeFundingPayments, Mode mode)
        external
        view
        returns(uint256 notionalPosition, int256 margin);
    function liquidate(
        IOrderBook.Order calldata order,
        IOrderBook.MatchInfo calldata matchInfo,
        int256 liquidationAmount,
        uint price,
        address trader
    ) external;
    function feeSink() external view returns(address);
    function calcMarginFraction(address trader, bool includeFundingPayments, Mode mode) external view returns(int256);
    function getUnderlyingPrice() external view returns(uint[] memory prices);
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

interface IOrderBook {
    enum OrderStatus {
        Invalid,
        Placed,
        Filled,
        Cancelled
    }

    enum OrderExecutionMode {
        Taker,
        Maker,
        SameBlock,
        Liquidation
    }

    struct Order {
        uint256 ammIndex;
        address trader;
        int256 baseAssetQuantity;
        uint256 price;
        uint256 salt;
    }

    struct MatchInfo {
        bytes32 orderHash;
        uint blockPlaced;
        OrderExecutionMode mode;
    }

    struct OrderInfo {
        IOrderBook.Order order;
        uint blockPlaced;
        int256 filledAmount;
        uint256 reservedMargin;
        OrderStatus status;
    }

    event OrderPlaced(address indexed trader, bytes32 indexed orderHash, Order order, bytes signature, uint timestamp);
    event OrderCancelled(address indexed trader, bytes32 indexed orderHash, uint timestamp);
    event OrdersMatched(bytes32 indexed orderHash0, bytes32 indexed orderHash1, uint256 fillAmount, uint price, uint openInterestNotional, address relayer, uint timestamp);
    event LiquidationOrderMatched(address indexed trader, bytes32 indexed orderHash, bytes signature, uint256 fillAmount, uint price, uint openInterestNotional, address relayer, uint timestamp);
    event OrderMatchingError(bytes32 indexed orderHash, string err);
    event LiquidationError(address indexed trader, bytes32 indexed orderHash, string err, uint256 toLiquidate);

    function executeMatchedOrders(Order[2] memory orders, bytes[2] memory signatures, int256 fillAmount) external;
    function settleFunding() external;
    function liquidateAndExecuteOrder(address trader, Order memory order, bytes memory signature, uint256 toLiquidate) external;
    function getLastTradePrices() external view returns(uint[] memory lastTradePrices);
}

interface IAMM {
    function openPosition(IOrderBook.Order memory order, int256 fillAmount, uint256 fulfillPrice)
        external
        returns (int realizedPnl, bool isPositionIncreased, int size, uint openNotional);
    function getNotionalPositionAndUnrealizedPnl(address trader)
        external
        view
        returns(uint256 notionalPosition, int256 unrealizedPnl, int256 size, uint256 openNotional);
    function updatePosition(address trader) external returns(int256 fundingPayment, int256 cumulativePremiumFraction);
    function liquidatePosition(address trader, uint price, int fillAmount) external returns (int realizedPnl, uint quoteAsset, int size, uint openNotional);
    function settleFunding() external returns (int256 premiumFraction, int256 underlyingPrice, int256 /* cumulativePremiumFraction */, uint256 /* nextFundingTime */);
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
    function getOracleBasedPnl(address trader, int256 margin, IClearingHouse.Mode mode) external view returns (uint, int256);
    function lastPrice() external view returns(uint256);
    function startFunding() external returns(uint256);
    function openInterestNotional() external returns(uint256);
    function getUnderlyingPrice() external view returns(uint256);
    function minSizeRequirement() external view returns(uint256);
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

    /* ****************** */
    /*       Events       */
    /* ****************** */

    /// @notice Emitted when user adds margin for any of the supported collaterals
    event MarginAdded(address indexed trader, uint256 indexed idx, uint amount, uint256 timestamp);

    /// @notice Emitted when user removes margin for any of the supported collaterals
    event MarginRemoved(address indexed trader, uint256 indexed idx, uint256 amount, uint256 timestamp);

    /**
    * @notice Mutates trader's vUSD balance
    * @param trader Account who is realizing PnL
    * @param realizedPnl Increase or decrease trader's vUSD balace by. +ve/-ve value means vUSD is added/removed respectively from trader's margin
    */
    event PnLRealized(address indexed trader, int256 realizedPnl, uint256 timestamp);

    /**
    * @notice Emitted when a trader's margin account is liquidated i.e. their vUSD debt is repayed in exchange for their collateral
    * @param trader Trader whose margin account was liquidated
    * @param idx Index of the collateral that was seized during the liquidation
    * @param seizeAmount Amount of the collateral that was seized during the liquidation
    * @param repayAmount The debt that was repayed
    */
    event MarginAccountLiquidated(address indexed trader, uint indexed idx, uint seizeAmount, uint repayAmount, uint256 timestamp);
    event MarginReserved(address indexed trader, uint amount);
    event MarginReleased(address indexed trader, uint amount);

    /**
    * @notice Emitted when funds from insurance fund are tasked to settle system's bad debt
    * @param trader Account for which the bad debt was settled
    * @param seized Collateral amounts that were seized
    * @param repayAmount Debt that was settled. it's exactly equal to -vUSD when vUSD < 0
    */
    event SettledBadDebt(address indexed trader, uint[] seized, uint repayAmount, uint256 timestamp);

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
    function reserveMargin(address trader, uint amount) external;
    function releaseMargin(address trader, uint amount) external;
    function reservedMargin(address trader) external view returns(uint);
    function getAvailableMargin(address trader) external view returns (int availableMargin);
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

interface IVUSD {
    event WithdrawalFailed(address indexed trader, uint amount, bytes data);

    function mintWithReserve(address to, uint amount) external payable;
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

interface IHGTCore {
    /**
     * @dev Emitted when `_amount` tokens are moved from the `_sender` to (`_dstChainId`, `_toAddress`)
     * `_nonce` is the outbound nonce.
     */
    event SendToChain(uint16 indexed _dstChainId, address indexed _from, bytes _toAddress, uint _amount, uint64 _nonce);

    /**
     * @dev Emitted when `_amount` tokens are received from `_srcChainId` into the `_toAddress` on the local chain.
     * `_nonce` is the inbound nonce.
     */
    event ReceiveFromChain(uint16 indexed _srcChainId, address indexed _to, uint _amount, uint64 _nonce);
}

interface IFeeSink {
    function transferOutVusd(address recipient, uint amount) external;
}
