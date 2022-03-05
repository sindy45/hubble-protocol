// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import { Governable } from "./legos/Governable.sol";
import { ERC20Detailed, IOracle, IRegistry, IVAMM, IAMM, IClearingHouse } from "./Interfaces.sol";

contract AMM is IAMM, Governable {
    using SafeCast for uint256;
    using SafeCast for int256;

    uint256 public constant spotPriceTwapInterval = 1 hours;
    uint256 public constant fundingPeriod = 1 hours;
    int256 constant BASE_PRECISION = 1e18;

    address public immutable clearingHouse;
    uint256 public immutable unbondRoundOff;

    /* ****************** */
    /*       Storage      */
    /* ****************** */

    // System-wide config

    IOracle public oracle;

    // AMM config

    IVAMM override public vamm;
    address override public underlyingAsset;
    string public name;

    uint256 public fundingBufferPeriod;
    uint256 public nextFundingTime;
    int256 public cumulativePremiumFraction;
    int256 public cumulativePremiumPerDtoken;
    int256 public posAccumulator;

    uint256 public longOpenInterestNotional;
    uint256 public shortOpenInterestNotional;
    uint256 public maxOracleSpreadRatio; // scaled 2 decimals

    enum Side { LONG, SHORT }
    struct Position {
        int256 size;
        uint256 openNotional;
        int256 lastPremiumFraction;
    }
    mapping(address => Position) override public positions;

    mapping(address => Maker) internal _makers;
    uint256 public withdrawPeriod;
    uint256 public unbondPeriod;

    struct ReserveSnapshot {
        uint256 lastPrice;
        uint256 timestamp;
        uint256 blockNumber;
    }
    ReserveSnapshot[] public reserveSnapshots;

    Ignition override public ignition;
    IAMM.AMMState override public ammState;

    struct VarGroup1 {
        uint minQuote;
        uint minBase;
        bool isLiquidation;
    }

    uint256[50] private __gap;

    /* ****************** */
    /*       Events       */
    /* ****************** */

    // Generic AMM related events
    event FundingRateUpdated(int256 premiumFraction, uint256 underlyingPrice, int256 cumulativePremiumFraction, int256 cumulativePremiumPerDtoken, uint256 nextFundingTime, uint256 timestamp, uint256 blockNumber);
    event FundingPaid(address indexed trader, int256 takerFundingPayment, int256 makerFundingPayment);
    event Swap(int256 baseAsset, uint256 quoteAsset, uint256 lastPrice, uint256 openInterestNotional);

    // Trader related events
    event PositionChanged(address indexed trader, int256 size, uint256 openNotional, int256 realizedPnl);
    event LiquidityAdded(address indexed trader, uint dToken, uint baseAsset, uint quoteAsset, uint timestamp);
    event LiquidityRemoved(address indexed trader, uint dToken, uint baseAsset, uint quoteAsset, int256 realizedPnl, bool isLiquidation, uint timestamp);
    event Unbonded(address indexed trader, uint256 unbondAmount, uint256 unbondTime, uint timestamp);

    /**
    * @dev This is only emitted when maker funding related events are updated.
    * These fields are: ignition,dToken,lastPremiumFraction,pos,lastPremiumPerDtoken,posAccumulator
    */
    event MakerPositionChanged(address indexed trader, Maker maker, uint timestamp);

    modifier onlyClearingHouse() {
        require(msg.sender == clearingHouse, "Only clearingHouse");
        _;
    }

    modifier onlyVamm() {
        require(msg.sender == address(vamm), "Only VAMM");
        _;
    }

    modifier whenIgnition() {
        require(ammState == AMMState.Ignition, "amm_not_ignition");
        _;
    }

    modifier whenActive() {
        require(ammState == AMMState.Active, "amm_not_active");
        _;
    }

    constructor(address _clearingHouse, uint _unbondRoundOff) {
        clearingHouse = _clearingHouse;
        unbondRoundOff = _unbondRoundOff;
    }

    function initialize(
        string memory _name,
        address _underlyingAsset,
        address _oracle,
        address _vamm,
        address _governance
    ) external initializer {
        name = _name;
        underlyingAsset = _underlyingAsset;
        oracle = IOracle(_oracle);
        vamm = IVAMM(_vamm);
        _setGovernace(_governance);

        // values that most likely wouldn't need to change frequently
        fundingBufferPeriod = 15 minutes;
        withdrawPeriod = 1 days;
        maxOracleSpreadRatio = 20;
        unbondPeriod = 3 days;
    }

    /**
    * @dev baseAssetQuantity != 0 has been validated in clearingHouse._openPosition()
    */
    function openPosition(address trader, int256 baseAssetQuantity, uint quoteAssetLimit)
        override
        external
        onlyClearingHouse
        whenActive
        returns (int realizedPnl, uint quoteAsset, bool isPositionIncreased)
    {
        Position memory position = positions[trader];
        bool isNewPosition = position.size == 0 ? true : false;
        Side side = baseAssetQuantity > 0 ? Side.LONG : Side.SHORT;
        if (isNewPosition || (position.size > 0 ? Side.LONG : Side.SHORT) == side) {
            // realizedPnl = 0;
            quoteAsset = _increasePosition(trader, baseAssetQuantity, quoteAssetLimit);
            isPositionIncreased = true;
        } else {
            (realizedPnl, quoteAsset, isPositionIncreased) = _openReversePosition(trader, baseAssetQuantity, quoteAssetLimit);
        }
        _emitPositionChanged(trader, realizedPnl);
    }

    function liquidatePosition(address trader)
        override
        external
        onlyClearingHouse
        returns (int realizedPnl, uint quoteAsset)
    {
        // don't need an ammState check because there should be no active positions
        Position memory position = positions[trader];
        bool isLongPosition = position.size > 0 ? true : false;
        // sending market orders can fk the trader. @todo put some safe guards around price of liquidations
        if (isLongPosition) {
            (realizedPnl, quoteAsset) = _reducePosition(trader, -position.size, 0, true /* isLiquidation */);
        } else {
            (realizedPnl, quoteAsset) = _reducePosition(trader, -position.size, type(uint).max, true /* isLiquidation */);
        }
        _emitPositionChanged(trader, realizedPnl);
    }

    function updatePosition(address trader)
        override
        external
        onlyClearingHouse
        returns(int256 fundingPayment)
    {
        if (ammState != AMMState.Active) return 0;

        _setIgnitionShare(trader);
        Maker storage maker = _makers[trader];
        int256 takerFundingPayment;
        int256 makerFundingPayment;
        (
            takerFundingPayment,
            makerFundingPayment,
            maker.lastPremiumFraction,
            maker.lastPremiumPerDtoken
        ) = getPendingFundingPayment(trader);

        Position storage position = positions[trader];
        position.lastPremiumFraction = maker.lastPremiumFraction;

        // +: trader paid, -: trader received
        fundingPayment = takerFundingPayment + makerFundingPayment;
        if (fundingPayment < 0) {
            fundingPayment -= fundingPayment / 1e3; // receivers charged 0.1% to account for rounding-offs
        }

        _emitMakerPositionChanged(trader);
        emit FundingPaid(trader, takerFundingPayment, makerFundingPayment);
    }

    /* ****************** */
    /*       Makers       */
    /* ****************** */

    function addLiquidity(address maker, uint baseAssetQuantity, uint minDToken)
        override
        external
        onlyClearingHouse
        whenActive
        returns (uint dToken)
    {
        uint quoteAsset;
        uint baseAssetBal = vamm.balances(1);
        if (baseAssetBal == 0) {
            quoteAsset = baseAssetQuantity * vamm.price_scale() / 1e30;
        } else {
            quoteAsset = baseAssetQuantity * vamm.balances(0) / baseAssetBal;
        }

        dToken = vamm.add_liquidity([quoteAsset, baseAssetQuantity], minDToken);

        // updates
        Maker storage _maker = _makers[maker];
        if (_maker.dToken > 0) { // Maker only accumulates position when they had non-zero liquidity
            _maker.pos += (posAccumulator - _maker.posAccumulator) * _maker.dToken.toInt256() / 1e18;
        }
        _maker.vUSD += quoteAsset;
        _maker.vAsset += baseAssetQuantity;
        _maker.dToken += dToken;
        _maker.posAccumulator = posAccumulator;
        _emitMakerPositionChanged(maker);
        emit LiquidityAdded(maker, dToken, baseAssetQuantity, quoteAsset, _blockTimestamp());
    }

    /**
    * @notice Express the intention to withdraw liquidity.
    * Can only withdraw after unbondPeriod and within withdrawal period
    * All withdrawals are batched together to 00:00 GMT
    * @param dToken Amount of dToken to withdraw
    */
    function unbondLiquidity(uint dToken) external whenActive {
        address maker = msg.sender;
        // this needs to be invoked here because updatePosition is not called before unbondLiquidity
        _setIgnitionShare(maker);
        Maker storage _maker = _makers[maker];
        require(_maker.dToken >= dToken, "unbonding_too_much");
        _maker.unbondAmount = dToken;
        _maker.unbondTime = ((_blockTimestamp() + unbondPeriod) / unbondRoundOff) * unbondRoundOff;
        emit Unbonded(maker, dToken, _maker.unbondTime, _blockTimestamp());
    }

    function forceRemoveLiquidity(address maker)
        override
        external
        onlyClearingHouse
        returns (int realizedPnl, uint makerOpenNotional, int makerPosition)
    {
        Maker storage _maker = _makers[maker];
        if (ammState == AMMState.Active) {
            // @todo partial liquidations and slippage checks
            VarGroup1 memory varGroup1 = VarGroup1(0,0,true);
            uint dToken = _maker.dToken;
            if (dToken == 0) {
                // these will be assigned on _setIgnitionShare(maker)
                (,dToken) = getIgnitionShare(_maker.ignition);
            }
            return _removeLiquidity(maker, dToken, varGroup1);
        }

        // ammState == AMMState.Ignition
        ignition.quoteAsset -= _makers[maker].ignition;
        _makers[maker].ignition = 0;
        _emitMakerPositionChanged(maker);
    }

    function removeLiquidity(address maker, uint amount, uint minQuote, uint minBase)
        override
        external
        onlyClearingHouse
        returns (int /* realizedPnl */, uint /* makerOpenNotional */, int /* makerPosition */)
    {

        Maker storage _maker = _makers[maker];
        _maker.unbondAmount -= amount; // will revert if removing more than unbondAmount
        uint _now = _blockTimestamp();
        require(_now >= _maker.unbondTime, "still_unbonding");
        require(_now <= _maker.unbondTime + withdrawPeriod, "withdraw_period_over");
        // there's no need to reset the unbondTime, unbondAmount will take care of everything

        VarGroup1 memory varGroup1 = VarGroup1(minQuote, minBase, false);
        return _removeLiquidity(maker, amount, varGroup1);
    }

    function _removeLiquidity(address maker, uint amount, VarGroup1 memory varGroup1)
        internal
        returns (int realizedPnl, uint makerOpenNotional, int makerPosition)
    {
        Maker storage _maker = _makers[maker];
        Position storage position = positions[maker];

        // amount <= _maker.dToken will be asserted when updating maker.dToken
        uint256 totalOpenNotional;
        uint[2] memory dBalances = [uint(0),uint(0)];
        (
            makerPosition,
            makerOpenNotional,
            totalOpenNotional,
            realizedPnl, // feeAdjustedPnl
            dBalances
        ) = vamm.remove_liquidity(
            amount,
            [varGroup1.minQuote, varGroup1.minBase],
            _maker.vUSD,
            _maker.vAsset,
            _maker.dToken,
            position.size,
            position.openNotional
        );

        // update maker info
        {
            uint diff = _maker.dToken - amount;
            if (diff == 0) {
                _maker.pos = 0;
                _maker.vAsset = 0;
                _maker.vUSD = 0;
                _maker.dToken = 0;
            } else {
                // muitiply by diff because a taker position will also be opened while removing liquidity and its funding payment is calculated seperately
                _maker.pos = _maker.pos + (posAccumulator - _maker.posAccumulator) * diff.toInt256() / 1e18;
                _maker.vAsset = _maker.vAsset * diff / _maker.dToken;
                _maker.vUSD = _maker.vUSD * diff / _maker.dToken;
                _maker.dToken = diff;
            }
            _maker.posAccumulator = posAccumulator;
        }

        // translate impermanent position to a permanent one
        {
            if (makerPosition != 0) {
                // reducing or reversing position
                if (makerPosition * position.size < 0) { // this ensures takerPosition !=0
                    realizedPnl += _getPnlWhileReducingPosition(position.size, position.openNotional, makerPosition);
                }
                position.openNotional = totalOpenNotional;
                position.size += makerPosition;

                // update long and short open interest notional
                if (makerPosition > 0) {
                    longOpenInterestNotional += makerPosition.toUint256();
                } else {
                    shortOpenInterestNotional += (-makerPosition).toUint256();
                }

                // these events will enable the parsing logic in the indexer to work seamlessly
                emit Swap(0, 0, lastPrice(), openInterestNotional());
                _emitPositionChanged(maker, realizedPnl);
            }
        }

        _emitMakerPositionChanged(maker);
        emit LiquidityRemoved(
            maker,
            amount,
            dBalances[1], // baseAsset
            dBalances[0], // quoteAsset
            realizedPnl,
            varGroup1.isLiquidation,
            _blockTimestamp()
        );
    }

    function getOpenNotionalWhileReducingPosition(
        int256 positionSize,
        uint256 newNotionalPosition,
        int256 unrealizedPnl,
        int256 baseAssetQuantity
    )
        override
        public
        pure
        returns(uint256 remainOpenNotional, int realizedPnl)
    {
        require(abs(positionSize) >= abs(baseAssetQuantity), "AMM.ONLY_REDUCE_POS");
        bool isLongPosition = positionSize > 0 ? true : false;

        realizedPnl = unrealizedPnl * abs(baseAssetQuantity) / abs(positionSize);
        int256 unrealizedPnlAfter = unrealizedPnl - realizedPnl;

        /**
        * We need to determine the openNotional value of the reduced position now.
        * We know notionalPosition and unrealizedPnlAfter (unrealizedPnl times the ratio of open position)
        * notionalPosition = notionalPosition - quoteAsset (exchangedQuoteAssetAmount)
        * calculate openNotional (it's different depends on long or short side)
        * long: unrealizedPnl = notionalPosition - openNotional => openNotional = notionalPosition - unrealizedPnl
        * short: unrealizedPnl = openNotional - notionalPosition => openNotional = notionalPosition + unrealizedPnl
        */
        if (isLongPosition) {
            /**
            * Let baseAssetQuantity = Q, position.size = size, by definition of _reducePosition, abs(size) >= abs(Q)
            * quoteAsset = notionalPosition * Q / size
            * unrealizedPnlAfter = unrealizedPnl - realizedPnl = unrealizedPnl - unrealizedPnl * Q / size
            * remainOpenNotional = notionalPosition - notionalPosition * Q / size - unrealizedPnl + unrealizedPnl * Q / size
            * => remainOpenNotional = notionalPosition(size-Q)/size - unrealizedPnl(size-Q)/size
            * => remainOpenNotional = (notionalPosition - unrealizedPnl) * (size-Q)/size
            * Since notionalPosition includes the PnL component, notionalPosition >= unrealizedPnl and size >= Q
            * Hence remainOpenNotional >= 0
            */
            remainOpenNotional = (newNotionalPosition.toInt256() - unrealizedPnlAfter).toUint256();  // will assert that remainOpenNotional >= 0
        } else {
            /**
            * Let baseAssetQuantity = Q, position.size = size, by definition of _reducePosition, abs(size) >= abs(Q)
            * quoteAsset = notionalPosition * Q / size
            * unrealizedPnlAfter = unrealizedPnl - realizedPnl = unrealizedPnl - unrealizedPnl * Q / size
            * remainOpenNotional = notionalPosition - notionalPosition * Q / size + unrealizedPnl - unrealizedPnl * Q / size
            * => remainOpenNotional = notionalPosition(size-Q)/size + unrealizedPnl(size-Q)/size
            * => remainOpenNotional = (notionalPosition + unrealizedPnl) * (size-Q)/size
            * => In AMM.sol, unrealizedPnl = position.openNotional - notionalPosition
            * => notionalPosition + unrealizedPnl >= 0
            * Hence remainOpenNotional >= 0
            */
            remainOpenNotional = (newNotionalPosition.toInt256() + unrealizedPnlAfter).toUint256();  // will assert that remainOpenNotional >= 0
        }
    }

    /**
     * @notice update funding rate
     * @dev only allow to update while reaching `nextFundingTime`
     */
    function settleFunding()
        override
        external
        onlyClearingHouse
    {
        if (
            ammState != AMMState.Active
            || _blockTimestamp() < nextFundingTime
        ) return;

        // premium = twapMarketPrice - twapIndexPrice
        // timeFraction = fundingPeriod(1 hour) / 1 day
        // premiumFraction = premium * timeFraction
        int256 underlyingPrice = getUnderlyingTwapPrice(spotPriceTwapInterval);
        int256 premium = getTwapPrice(spotPriceTwapInterval) - underlyingPrice;
        int256 premiumFraction = (premium * int256(fundingPeriod)) / 1 days;

        int256 premiumPerDtoken = posAccumulator * premiumFraction;

        // makers pay slightly more to account for rounding off
        premiumPerDtoken = (premiumPerDtoken / BASE_PRECISION) + 1;

        cumulativePremiumFraction += premiumFraction;
        cumulativePremiumPerDtoken += premiumPerDtoken;

        // Updates for next funding event
        // in order to prevent multiple funding settlement during very short time after network congestion
        uint256 minNextValidFundingTime = _blockTimestamp() + fundingBufferPeriod;

        // floor((nextFundingTime + fundingPeriod) / 3600) * 3600
        uint256 nextFundingTimeOnHourStart = ((nextFundingTime + fundingPeriod) / 1 hours) * 1 hours;

        // max(nextFundingTimeOnHourStart, minNextValidFundingTime)
        nextFundingTime = nextFundingTimeOnHourStart > minNextValidFundingTime
            ? nextFundingTimeOnHourStart
            : minNextValidFundingTime;

        _emitFundingRateUpdated(premiumFraction, underlyingPrice);
    }

    function commitLiquidity(address maker, uint quoteAsset)
        override
        external
        whenIgnition
        onlyClearingHouse
    {
        quoteAsset /= 2; // only need to track the USD side
        _makers[maker].ignition += quoteAsset;
        ignition.quoteAsset += quoteAsset;
        _emitMakerPositionChanged(maker);
    }

    function liftOff() external onlyGovernance whenIgnition {
        uint256 underlyingPrice = getUnderlyingTwapPrice(15 minutes).toUint256();
        require(underlyingPrice > 0, "amm.liftOff.underlyingPrice_not_set");
        vamm.setinitialPrice(underlyingPrice * 1e12); // vamm expects 18 decimal scale
        if (ignition.quoteAsset > 0) {
            ignition.baseAsset = ignition.quoteAsset * 1e18 / underlyingPrice;
            ignition.dToken = vamm.add_liquidity([ignition.quoteAsset, ignition.baseAsset], 0);

            // helps in the API logic
            emit LiquidityAdded(address(this), ignition.dToken, ignition.baseAsset, ignition.quoteAsset, _blockTimestamp());
        }

        ammState = AMMState.Active;
        // funding games can now begin
        nextFundingTime = ((_blockTimestamp() + fundingPeriod) / 1 hours) * 1 hours;
    }

    function _setIgnitionShare(address maker) internal {
        uint vUSD = _makers[maker].ignition;
        if (vUSD == 0) return;

        Maker storage _maker = _makers[maker];
        _maker.vUSD = vUSD;
        (_maker.vAsset, _maker.dToken) = getIgnitionShare(vUSD);
        _maker.ignition = 0;
        _emitMakerPositionChanged(maker); // because dToken was updated
    }

    function getIgnitionShare(uint vUSD) override public view returns (uint vAsset, uint dToken) {
        vAsset = ignition.baseAsset * vUSD / ignition.quoteAsset;
        dToken = ignition.dToken * vUSD / ignition.quoteAsset;
    }

    // View

    function getSnapshotLen() external view returns (uint256) {
        return reserveSnapshots.length;
    }

    function getUnderlyingTwapPrice(uint256 _intervalInSeconds) public view returns (int256) {
        return oracle.getUnderlyingTwapPrice(underlyingAsset, _intervalInSeconds);
    }

    function getTwapPrice(uint256 _intervalInSeconds) public view returns (int256) {
        return _calcTwap(_intervalInSeconds).toInt256();
    }

    function getNotionalPositionAndUnrealizedPnl(address trader)
        override
        external
        view
        returns(uint256 notionalPosition, int256 unrealizedPnl, int256 size, uint256 openNotional)
    {
        if (ammState == AMMState.Ignition) {
            return (_makers[trader].ignition * 2, 0, 0, 0);
        }

        uint vUSD = _makers[trader].ignition;
        uint vAsset;
        uint dToken;
        if (vUSD > 0) { // participated in ignition
            (vAsset, dToken) = getIgnitionShare(vUSD);
        } else {
            vUSD = _makers[trader].vUSD;
            vAsset = _makers[trader].vAsset;
            dToken = _makers[trader].dToken;
        }

        (notionalPosition, size, unrealizedPnl, openNotional) = vamm.get_notional(
            dToken,
            vUSD,
            vAsset,
            positions[trader].size,
            positions[trader].openNotional
        );
    }

    /**
    * @notice returns false if
    * (1-maxSpreadRatio)*indexPrice < markPrice < (1+maxSpreadRatio)*indexPrice
    * else, true
    */
    function isOverSpreadLimit() external view returns(bool) {
        if (ammState != AMMState.Active) return false;

        uint oraclePrice = uint(oracle.getUnderlyingPrice(underlyingAsset));
        uint markPrice = lastPrice();
        uint oracleSpreadRatioAbs;
        if (markPrice > oraclePrice) {
            oracleSpreadRatioAbs = markPrice - oraclePrice;
        } else {
            oracleSpreadRatioAbs = oraclePrice - markPrice;
        }
        oracleSpreadRatioAbs = oracleSpreadRatioAbs * 100 / oraclePrice;

        if (oracleSpreadRatioAbs >= maxOracleSpreadRatio) {
            return true;
        }
        return false;
    }

    /**
    * @notice returns notionalPosition and unrealizedPnl when isOverSpreadLimit()
    * calculate margin fraction using markPrice and oraclePrice
    * if mode = Maintenance_Margin, return values which have maximum margin fraction
    * if mode = min_allowable_margin, return values which have minimum margin fraction
    */
    function getOracleBasedPnl(address trader, int256 margin, IClearingHouse.Mode mode) override external view returns (uint notionalPosition, int256 unrealizedPnl) {
        Maker memory _maker = _makers[trader];
        if (ammState == AMMState.Ignition) {
            return (_maker.ignition * 2, 0);
        }

        Position memory _taker = positions[trader];
        int256 size;
        uint openNotional;
        (notionalPosition, size, unrealizedPnl, openNotional) = vamm.get_notional(
            _maker.dToken,
            _maker.vUSD,
            _maker.vAsset,
            _taker.size,
            _taker.openNotional
        );

        if (notionalPosition == 0) {
            return (0, 0);
        }

        int256 marginFraction = (margin + unrealizedPnl) * 1e6 / notionalPosition.toInt256();
        (int oracleBasedNotional, int256 oracleBasedUnrealizedPnl, int256 oracleBasedMF) = _getOracleBasedMarginFraction(
            trader,
            margin,
            openNotional,
            size
        );

        if (mode == IClearingHouse.Mode.Maintenance_Margin) {
            if (oracleBasedMF > marginFraction) {
                notionalPosition = oracleBasedNotional.toUint256();
                unrealizedPnl = oracleBasedUnrealizedPnl;
            }
        } else if (oracleBasedMF < marginFraction) { // IClearingHouse.Mode.Min_Allowable_Margin
            notionalPosition = oracleBasedNotional.toUint256();
            unrealizedPnl = oracleBasedUnrealizedPnl;
        }
    }

    function _getOracleBasedMarginFraction(address trader, int256 margin, uint256 openNotional, int256 size)
        internal
        view
        returns (int oracleBasedNotional, int256 oracleBasedUnrealizedPnl, int256 marginFraction)
    {
        int256 oraclePrice = oracle.getUnderlyingPrice(underlyingAsset);
        oracleBasedNotional = oraclePrice * abs(size) / BASE_PRECISION;
        if (size > 0) {
            oracleBasedUnrealizedPnl = oracleBasedNotional - openNotional.toInt256();
        } else if (size < 0) {
            oracleBasedUnrealizedPnl = openNotional.toInt256() - oracleBasedNotional;
        }
        // notionalPostion = max(makerDebt, makerPositionNotional) + takerPositionalNotional
        // = max(makerDebt + takerPositionNotional, makerPositionNotional + takerPositionNotional)
        int256 oracleBasedTakerNotional = oraclePrice * abs(positions[trader].size) / BASE_PRECISION;
        oracleBasedNotional = _max(2 * _makers[trader].vUSD.toInt256() + oracleBasedTakerNotional, oracleBasedNotional);
        marginFraction = (margin + oracleBasedUnrealizedPnl) * 1e6 / oracleBasedNotional;
    }

    function getPendingFundingPayment(address trader)
        override
        public
        view
        returns(
            int256 takerFundingPayment,
            int256 makerFundingPayment,
            int256 latestCumulativePremiumFraction,
            int256 latestPremiumPerDtoken
        )
    {
        Position memory taker = positions[trader];
        Maker memory maker = _makers[trader];

        // cache state variables locally for cheaper access and return values
        latestCumulativePremiumFraction = cumulativePremiumFraction;
        latestPremiumPerDtoken = cumulativePremiumPerDtoken;

        // Taker
        takerFundingPayment = (latestCumulativePremiumFraction - taker.lastPremiumFraction)
            * taker.size
            / BASE_PRECISION;

        // Maker
        uint256 dToken;
        uint vUSD = _makers[trader].ignition;
        if (vUSD > 0) {
            (,dToken) = getIgnitionShare(vUSD);
        } else {
            dToken = maker.dToken;
        }

        if (dToken > 0) {
            int256 cpf = latestCumulativePremiumFraction - maker.lastPremiumFraction;
            makerFundingPayment = (
                maker.pos * cpf +
                (
                    latestPremiumPerDtoken
                    - maker.lastPremiumPerDtoken
                    - maker.posAccumulator * cpf / BASE_PRECISION
                ) * dToken.toInt256()
            ) / BASE_PRECISION;
        }
    }

    function getCloseQuote(int256 baseAssetQuantity) override public view returns(uint256 quoteAssetQuantity) {
        if (baseAssetQuantity > 0) {
            return vamm.get_dy(1, 0, baseAssetQuantity.toUint256());
        } else if (baseAssetQuantity < 0) {
            return vamm.get_dx(0, 1, (-baseAssetQuantity).toUint256());
        }
        return 0;
    }

    function getTakerNotionalPositionAndUnrealizedPnl(address trader) override public view returns(uint takerNotionalPosition, int256 unrealizedPnl) {
        Position memory position = positions[trader];
        if (position.size > 0) {
            takerNotionalPosition = vamm.get_dy(1, 0, position.size.toUint256());
            unrealizedPnl = takerNotionalPosition.toInt256() - position.openNotional.toInt256();
        } else if (position.size < 0) {
            takerNotionalPosition = vamm.get_dx(0, 1, (-position.size).toUint256());
            unrealizedPnl = position.openNotional.toInt256() - takerNotionalPosition.toInt256();
        }
    }

    function lastPrice() public view returns(uint256) {
        return vamm.last_prices() / 1e12;
    }

    function openInterestNotional() public view returns (uint256) {
        return longOpenInterestNotional + shortOpenInterestNotional;
    }

    function makers(address maker) override external view returns(Maker memory) {
        return _makers[maker];
    }

    // internal

    /**
    * @dev Go long on an asset
    * @param baseAssetQuantity Exact base asset quantity to go long
    * @param max_dx Maximum amount of quote asset to be used while longing baseAssetQuantity. Lower means longing at a lower price (desirable).
    * @param isLiquidation true if liquidaiton else false
    * @return quoteAssetQuantity quote asset utilised. quoteAssetQuantity / baseAssetQuantity was the average rate.
      quoteAssetQuantity <= max_dx
    */
    function _long(int256 baseAssetQuantity, uint max_dx, bool isLiquidation) internal returns (uint256 quoteAssetQuantity) {
        require(baseAssetQuantity > 0, "VAMM._long: baseAssetQuantity is <= 0");

        uint _lastPrice;
        (quoteAssetQuantity, _lastPrice) = vamm.exchangeExactOut(
            0, // sell quote asset
            1, // purchase base asset
            baseAssetQuantity.toUint256(), // long exactly. Note that statement asserts that baseAssetQuantity >= 0
            max_dx
        ); // 6 decimals precision

        // longs not allowed if market price > (1 + maxOracleSpreadRatio)*index price
        uint256 oraclePrice = uint(oracle.getUnderlyingPrice(underlyingAsset));
        oraclePrice = oraclePrice * (100 + maxOracleSpreadRatio) / 100;
        if (!isLiquidation && _lastPrice > oraclePrice) {
            revert("VAMM._long: longs not allowed");
        }

        _addReserveSnapshot(_lastPrice);
        // since maker position will be opposite of the trade
        posAccumulator -= baseAssetQuantity * 1e18 / vamm.totalSupply().toInt256();
        emit Swap(baseAssetQuantity, quoteAssetQuantity, _lastPrice, openInterestNotional());
    }

    /**
    * @dev Go short on an asset
    * @param baseAssetQuantity Exact base asset quantity to short
    * @param min_dy Minimum amount of quote asset to be used while shorting baseAssetQuantity. Higher means shorting at a higher price (desirable).
    * @param isLiquidation true if liquidaiton else false
    * @return quoteAssetQuantity quote asset utilised. quoteAssetQuantity / baseAssetQuantity was the average short rate.
      quoteAssetQuantity >= min_dy.
    */
    function _short(int256 baseAssetQuantity, uint min_dy, bool isLiquidation) internal returns (uint256 quoteAssetQuantity) {
        require(baseAssetQuantity < 0, "VAMM._short: baseAssetQuantity is >= 0");

        uint _lastPrice;
        (quoteAssetQuantity, _lastPrice) = vamm.exchange(
            1, // sell base asset
            0, // get quote asset
            (-baseAssetQuantity).toUint256(), // short exactly. Note that statement asserts that baseAssetQuantity <= 0
            min_dy
        );

        // shorts not allowed if market price < (1 - maxOracleSpreadRatio)*index price
        uint256 oraclePrice = uint(oracle.getUnderlyingPrice(underlyingAsset));
        oraclePrice = oraclePrice * (100 - maxOracleSpreadRatio) / 100;
        if (!isLiquidation && _lastPrice < oraclePrice) {
            revert("VAMM._short: shorts not allowed");
        }
        _addReserveSnapshot(_lastPrice);
        // since maker position will be opposite of the trade
        posAccumulator -= baseAssetQuantity * 1e18 / vamm.totalSupply().toInt256();
        emit Swap(baseAssetQuantity, quoteAssetQuantity, _lastPrice, openInterestNotional());
    }

    function _emitPositionChanged(address trader, int256 realizedPnl) internal {
        Position memory position = positions[trader];
        emit PositionChanged(trader, position.size, position.openNotional, realizedPnl);
    }

    function _emitMakerPositionChanged(address maker) internal {
        emit MakerPositionChanged(maker, _makers[maker], _blockTimestamp());
    }

    /**
    * @dev Get PnL to be realized for the part of the position that is being closed
    *   Check takerPosition != 0 before calling
    */
    function _getPnlWhileReducingPosition(
        int256 takerPosition,
        uint takerOpenNotional,
        int256 makerPosition
    ) internal view returns (int256 pnlToBeRealized) {
        // notional of the combined new position
        uint newNotional = getCloseQuote(takerPosition + makerPosition);
        uint totalPosition = abs(makerPosition + takerPosition).toUint256();

        if (abs(takerPosition) > abs(makerPosition)) { // taker position side remains same
            uint reducedOpenNotional = takerOpenNotional * abs(makerPosition).toUint256() / abs(takerPosition).toUint256();
            uint makerNotional = newNotional * abs(makerPosition).toUint256() / totalPosition;
            pnlToBeRealized = _getPnlToBeRealized(takerPosition, makerNotional, reducedOpenNotional);
        } else { // taker position side changes
            // @todo handle case when totalPosition = 0
            uint closedPositionNotional = newNotional * abs(takerPosition).toUint256() / totalPosition;
            pnlToBeRealized = _getPnlToBeRealized(takerPosition, closedPositionNotional, takerOpenNotional);
        }
    }

    function _getPnlToBeRealized(int256 takerPosition, uint notionalPosition, uint openNotional) internal pure returns (int256 pnlToBeRealized) {
        if (takerPosition > 0) {
            pnlToBeRealized = notionalPosition.toInt256() - openNotional.toInt256();
        } else {
            pnlToBeRealized = openNotional.toInt256() - notionalPosition.toInt256();
        }
    }

    function _increasePosition(address trader, int256 baseAssetQuantity, uint quoteAssetLimit)
        internal
        returns(uint quoteAsset)
    {
        if (baseAssetQuantity > 0) { // Long - purchase baseAssetQuantity
            longOpenInterestNotional += baseAssetQuantity.toUint256();
            quoteAsset = _long(baseAssetQuantity, quoteAssetLimit, false /* isLiquidation */);
        } else { // Short - sell baseAssetQuantity
            shortOpenInterestNotional += (-baseAssetQuantity).toUint256();
            quoteAsset = _short(baseAssetQuantity, quoteAssetLimit, false /* isLiquidation */);
        }
        positions[trader].size += baseAssetQuantity; // -ve baseAssetQuantity will increase short position
        positions[trader].openNotional += quoteAsset;
    }

    function _openReversePosition(address trader, int256 baseAssetQuantity, uint quoteAssetLimit)
        internal
        returns (int realizedPnl, uint quoteAsset, bool isPositionIncreased)
    {
        Position memory position = positions[trader];
        if (abs(position.size) >= abs(baseAssetQuantity)) {
            (realizedPnl, quoteAsset) = _reducePosition(trader, baseAssetQuantity, quoteAssetLimit, false /* isLiqudation */);
        } else {
            uint closedRatio = (quoteAssetLimit * abs(position.size).toUint256()) / abs(baseAssetQuantity).toUint256();
            (realizedPnl, quoteAsset) = _reducePosition(trader, -position.size, closedRatio, false /* isLiqudation */);

            // this is required because the user might pass a very less value (slippage-prone) while shorting
            if (quoteAssetLimit >= quoteAsset) {
                quoteAssetLimit -= quoteAsset;
            }
            quoteAsset += _increasePosition(trader, baseAssetQuantity + position.size, quoteAssetLimit);
            isPositionIncreased = true;
        }
    }

    /**
    * @dev validate that baseAssetQuantity <= position.size should be performed before the call to _reducePosition
    */
    function _reducePosition(address trader, int256 baseAssetQuantity, uint quoteAssetLimit, bool isLiquidation)
        internal
        returns (int realizedPnl, uint256 quoteAsset)
    {
        (, int256 unrealizedPnl) = getTakerNotionalPositionAndUnrealizedPnl(trader);

        Position storage position = positions[trader]; // storage because there are updates at the end
        bool isLongPosition = position.size > 0 ? true : false;

        if (isLongPosition) {
            longOpenInterestNotional -= (-baseAssetQuantity).toUint256();
            quoteAsset = _short(baseAssetQuantity, quoteAssetLimit, isLiquidation);
        } else {
            shortOpenInterestNotional -= baseAssetQuantity.toUint256();
            quoteAsset = _long(baseAssetQuantity, quoteAssetLimit, isLiquidation);
        }
        uint256 notionalPosition = getCloseQuote(position.size + baseAssetQuantity);
        (position.openNotional, realizedPnl) = getOpenNotionalWhileReducingPosition(position.size, notionalPosition, unrealizedPnl, baseAssetQuantity);
        position.size += baseAssetQuantity;
    }

    function _addReserveSnapshot(uint256 price)
        internal
    {
        uint256 currentBlock = block.number;
        uint256 blockTimestamp = _blockTimestamp();

        if (reserveSnapshots.length == 0) {
            reserveSnapshots.push(
                ReserveSnapshot(price, blockTimestamp, currentBlock)
            );
            return;
        }

        ReserveSnapshot storage latestSnapshot = reserveSnapshots[reserveSnapshots.length - 1];
        // update values in snapshot if in the same block
        if (currentBlock == latestSnapshot.blockNumber) {
            latestSnapshot.lastPrice = price;
        } else {
            reserveSnapshots.push(
                ReserveSnapshot(price, blockTimestamp, currentBlock)
            );
        }
    }

    function _blockTimestamp() internal view virtual returns (uint256) {
        return block.timestamp;
    }

    function _calcTwap(uint256 _intervalInSeconds)
        internal
        view
        returns (uint256)
    {
        uint256 snapshotIndex = reserveSnapshots.length - 1;
        uint256 currentPrice = reserveSnapshots[snapshotIndex].lastPrice;
        if (_intervalInSeconds == 0) {
            return currentPrice;
        }

        uint256 baseTimestamp = _blockTimestamp() - _intervalInSeconds;
        ReserveSnapshot memory currentSnapshot = reserveSnapshots[snapshotIndex];
        // return the latest snapshot price directly
        // if only one snapshot or the timestamp of latest snapshot is earlier than asking for
        if (reserveSnapshots.length == 1 || currentSnapshot.timestamp <= baseTimestamp) {
            return currentPrice;
        }

        uint256 previousTimestamp = currentSnapshot.timestamp;
        uint256 period = _blockTimestamp() - previousTimestamp;
        uint256 weightedPrice = currentPrice * period;
        while (true) {
            // if snapshot history is too short
            if (snapshotIndex == 0) {
                return weightedPrice / period;
            }

            snapshotIndex = snapshotIndex - 1;
            currentSnapshot = reserveSnapshots[snapshotIndex];
            currentPrice = reserveSnapshots[snapshotIndex].lastPrice;

            // check if current round timestamp is earlier than target timestamp
            if (currentSnapshot.timestamp <= baseTimestamp) {
                // weighted time period will be (target timestamp - previous timestamp). For example,
                // now is 1000, _interval is 100, then target timestamp is 900. If timestamp of current round is 970,
                // and timestamp of NEXT round is 880, then the weighted time period will be (970 - 900) = 70,
                // instead of (970 - 880)
                weightedPrice = weightedPrice + (currentPrice * (previousTimestamp - baseTimestamp));
                break;
            }

            uint256 timeFraction = previousTimestamp - currentSnapshot.timestamp;
            weightedPrice = weightedPrice + (currentPrice * timeFraction);
            period = period + timeFraction;
            previousTimestamp = currentSnapshot.timestamp;
        }
        return weightedPrice / _intervalInSeconds;
    }

    function _emitFundingRateUpdated(
        int256 _premiumFraction,
        int256 _underlyingPrice
    ) internal {
        emit FundingRateUpdated(
            _premiumFraction,
            _underlyingPrice.toUint256(),
            cumulativePremiumFraction,
            cumulativePremiumPerDtoken,
            nextFundingTime,
            _blockTimestamp(),
            block.number
        );
    }

    // Pure

    function abs(int x) internal pure returns (int) {
        return x >= 0 ? x : -x;
    }

    function _max(int x, int y) private pure returns (int) {
        return x >= y ? x : y;
    }

    // Governance

    function putAmmInIgnition() external onlyClearingHouse {
        ammState = AMMState.Ignition;
    }

    function changeOracle(address _oracle) public onlyGovernance {
        oracle = IOracle(_oracle);
    }

    function setFundingBufferPeriod(uint _fundingBufferPeriod) external onlyGovernance {
        fundingBufferPeriod = _fundingBufferPeriod;
    }

    function setUnbondPeriod(uint _unbondPeriod) external onlyGovernance {
        unbondPeriod = _unbondPeriod;
    }
}
