// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

import { IClearingHouse, IMarginAccount, IAMM, IVAMM, IHubbleViewer } from "./Interfaces.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";

contract HubbleViewer is IHubbleViewer {
    using SafeCast for uint256;
    using SafeCast for int256;

    int256 constant PRECISION_INT = 1e6;
    uint256 constant PRECISION_UINT = 1e6;

    uint constant VUSD_IDX = 0;

    IClearingHouse public immutable clearingHouse;
    IMarginAccount public immutable marginAccount;

    /// @dev not actually used but helps in utils.generateConfig
    address public immutable registry;

    struct Position {
        int256 size;
        uint256 openNotional;
        int256 unrealizedPnl;
        uint256 avgOpen;
        int256 funding;
    }

    /// @dev UI Helper
    struct MarketInfo {
        address amm;
        address underlying;
    }

    constructor(
        IClearingHouse _clearingHouse,
        IMarginAccount _marginAccount,
        address _registry
    ) {
        clearingHouse = _clearingHouse;
        marginAccount = _marginAccount;
        registry = _registry;
    }

    function getMarginFractionAndMakerStatus(address[] calldata traders)
        external
        view
        returns(int256[] memory fractions, bool[] memory isMaker)
    {
        uint len = traders.length;
        fractions = new int256[](len);
        isMaker = new bool[](len);
        for (uint i; i < len; i++) {
            fractions[i] = clearingHouse.getMarginFraction(traders[i]);
            isMaker[i] = clearingHouse.isMaker(traders[i]);
        }
    }

    function marginAccountLiquidatationStatus(address[] calldata traders)
        external
        view
        returns(IMarginAccount.LiquidationStatus[] memory isLiquidatable, uint[] memory repayAmount, uint[] memory incentivePerDollar)
    {
        isLiquidatable = new IMarginAccount.LiquidationStatus[](traders.length);
        repayAmount = new uint[](traders.length);
        incentivePerDollar = new uint[](traders.length);
        for (uint i; i < traders.length; i++) {
            (isLiquidatable[i], repayAmount[i], incentivePerDollar[i]) = marginAccount.isLiquidatable(traders[i], true);
        }
    }

    /**
    * @notice Get information about all user positions
    * @param trader Trader for which information is to be obtained
    * @return positions in order of amms
    *   positions[i].size - BaseAssetQuantity amount longed (+ve) or shorted (-ve)
    *   positions[i].openNotional - $ value of position
    *   positions[i].unrealizedPnl - in dollars. +ve is profit, -ve if loss
    *   positions[i].avgOpen - Average $ value at which position was started
    */
    function userPositions(address trader) external view returns(Position[] memory positions) {
        uint l = clearingHouse.getAmmsLength();
        positions = new Position[](l);
        for (uint i; i < l; i++) {
            IAMM amm = clearingHouse.amms(i);
            (positions[i].size, positions[i].openNotional,,) = amm.positions(trader);
            if (positions[i].size == 0) {
                positions[i].unrealizedPnl = 0;
                positions[i].avgOpen = 0;
            } else {
                (,positions[i].unrealizedPnl) = amm.getTakerNotionalPositionAndUnrealizedPnl(trader);
                positions[i].avgOpen = positions[i].openNotional * 1e18 / _abs(positions[i].size).toUint256();
            }
        }
    }

    /**
    * @notice Get information about maker's all impermanent positions
    * @param maker Maker for which information is to be obtained
    * @return positions in order of amms
    *   positions[i].size - BaseAssetQuantity amount longed (+ve) or shorted (-ve)
    *   positions[i].openNotional - $ value of position
    *   positions[i].unrealizedPnl - in dollars. +ve is profit, -ve if loss
    *   positions[i].avgOpen - Average $ value at which position was started
    */
    function makerPositions(address maker) external view returns(Position[] memory positions) {
        uint l = clearingHouse.getAmmsLength();
        IAMM amm;
        positions = new Position[](l);
        for (uint i; i < l; i++) {
            amm = clearingHouse.amms(i);
            (
                positions[i].size,
                positions[i].openNotional,
                positions[i].unrealizedPnl
            ) = _getMakerPositionAndUnrealizedPnl(maker, amm);
            if (positions[i].size == 0) {
                positions[i].avgOpen = 0;
            } else {
                positions[i].avgOpen = positions[i].openNotional * 1e18 / _abs(positions[i].size).toUint256();
            }
            (,positions[i].funding,,) = amm.getPendingFundingPayment(maker);
        }
    }

    function markets() external view returns(MarketInfo[] memory _markets) {
        uint l = clearingHouse.getAmmsLength();
        _markets = new MarketInfo[](l);
        for (uint i; i < l; i++) {
            IAMM amm = clearingHouse.amms(i);
            _markets[i] = MarketInfo(address(amm), amm.underlyingAsset());
        }
    }

    /**
    * @notice get maker impermanent position and unrealizedPnl for a particular amm
    * @param _maker maker address
    * @param idx amm index
    * @return position Maker's current impermanent position
    * @return openNotional Position open notional for the current impermanent position inclusive of fee earned
    * @return unrealizedPnl PnL if maker removes liquidity and closes their impermanent position in the same amm
    */
    function getMakerPositionAndUnrealizedPnl(address _maker, uint idx)
        override
        public
        view
        returns (int256 position, uint openNotional, int256 unrealizedPnl)
    {
        return _getMakerPositionAndUnrealizedPnl(_maker, clearingHouse.amms(idx));
    }

    function _getMakerPositionAndUnrealizedPnl(address _maker, IAMM amm)
        internal
        view
        returns (int256 /* position */, uint /* openNotional */, int256 /* unrealizedPnl */)
    {
        IVAMM vamm = amm.vamm();
        IAMM.Maker memory maker = amm.makers(_maker);
        if (maker.ignition != 0) {
            maker.vUSD = maker.ignition;
            (maker.vAsset, maker.dToken) = amm.getIgnitionShare(maker.vUSD);
        }
        return vamm.get_maker_position(maker.dToken, maker.vUSD, maker.vAsset, maker.dToken);
    }

    /**
    * @notice calculate amount of quote asset required for trade
    * @param baseAssetQuantity base asset to long/short
    * @param idx amm index
    */
    function getQuote(int256 baseAssetQuantity, uint idx) public view returns(uint256 quoteAssetQuantity) {
        IAMM amm = clearingHouse.amms(idx);
        IVAMM vamm = amm.vamm();

        if (baseAssetQuantity >= 0) {
            return vamm.get_dx(0, 1, baseAssetQuantity.toUint256()) + 1;
        }
        // rounding-down while shorting is not a problem
        // because lower the min_dy, more permissible it is
        return vamm.get_dy(1, 0, (-baseAssetQuantity).toUint256());
    }

    /**
    * @notice calculate amount of base asset required for trade
    * @param quoteAssetQuantity amount of quote asset to long/short
    * @param idx amm index
    * @param isLong long - true, short - false
    */
    function getBase(uint256 quoteAssetQuantity, uint idx, bool isLong) external view returns(int256 /* baseAssetQuantity */) {
        IAMM amm = clearingHouse.amms(idx);
        IVAMM vamm = amm.vamm();

        uint256 baseAssetQuantity;
        if (isLong) {
            baseAssetQuantity = vamm.get_dy(0, 1, quoteAssetQuantity);
            return baseAssetQuantity.toInt256();
        }
        baseAssetQuantity = vamm.get_dx(1, 0, quoteAssetQuantity);
        return -(baseAssetQuantity.toInt256());
    }

    /**
    * @notice Get total liquidity deposited by maker and its current value
    * @param _maker maker for which information to be obtained
    * @return
    *   vAsset - current base asset amount of maker in the pool
    *   vUSD - current quote asset amount of maker in the pool
    *   totalDeposited - total value of initial liquidity deposited in the pool by maker
    *   dToken - maker dToken balance
    *   vAssetBalance - base token liquidity in the pool
    *   vUSDBalance - quote token liquidity in the pool
    */
    function getMakerLiquidity(address _maker, uint idx)
        external
        view
        returns (uint vAsset, uint vUSD, uint totalDeposited, uint dToken, uint unbondTime, uint unbondAmount, uint vAssetBalance, uint vUSDBalance)
    {
        IAMM amm = clearingHouse.amms(idx);
        IVAMM vamm = amm.vamm();
        IAMM.Maker memory maker = amm.makers(_maker);

        if (amm.ammState() == IAMM.AMMState.Active) {
            if (maker.ignition > 0) {
                (,dToken) = amm.getIgnitionShare(maker.ignition);
            } else {
                dToken = maker.dToken;
            }
            unbondTime = maker.unbondTime;
            unbondAmount = maker.unbondAmount;
            totalDeposited = 2 * maker.vUSD;

            vUSDBalance = vamm.balances(0);
            vAssetBalance = vamm.balances(1);
            uint totalDTokenSupply = vamm.totalSupply();
            if (totalDTokenSupply > 0) {
                vUSD = vUSDBalance * dToken / totalDTokenSupply;
                vAsset = vAssetBalance * dToken / totalDTokenSupply;
            }
        } else {
            totalDeposited = 2 * maker.ignition;
            vUSD = totalDeposited;
        }
    }

    /**
    * @notice calculate base and quote asset amount form dToken
     */
    function calcWithdrawAmounts(uint dToken, uint idx) external view returns (uint quoteAsset, uint baseAsset) {
        IAMM amm = clearingHouse.amms(idx);
        IVAMM vamm = amm.vamm();

        uint totalDTokenSupply = vamm.totalSupply();
        if (totalDTokenSupply > 0) {
            quoteAsset = vamm.balances(0) * dToken / totalDTokenSupply;
            baseAsset = vamm.balances(1) * dToken / totalDTokenSupply;
        }
    }

    /**
    * @notice Get amount of token to add/remove given the amount of other token
    * @param inputAmount quote/base asset amount to add or remove, base - 18 decimal, quote - 6 decimal
    * @param isBase true if inputAmount is base asset
    * @param deposit true -> addLiquidity, false -> removeLiquidity
    * @return fillAmount base/quote asset amount to be added/removed
    *         dToken - equivalent dToken amount
    */
    function getMakerQuote(uint idx, uint inputAmount, bool isBase, bool deposit) public view returns (uint fillAmount, uint dToken) {
        IAMM amm = clearingHouse.amms(idx);
        IVAMM vamm = amm.vamm();

        if (isBase) {
            // calculate quoteAsset amount, fillAmount = quoteAsset, inputAmount = baseAsset
            uint baseAssetBal = vamm.balances(1);
            if (baseAssetBal == 0) {
                fillAmount = inputAmount * vamm.price_scale() / 1e30;
            } else {
                fillAmount = inputAmount * vamm.balances(0) / baseAssetBal;
            }
            dToken = vamm.calc_token_amount([fillAmount, inputAmount], deposit);
        } else {
            uint bal0 = vamm.balances(0);
            // calculate quote asset amount, fillAmount = baseAsset, inputAmount = quoteAsset
            if (bal0 == 0) {
                fillAmount = inputAmount * 1e30 / vamm.price_scale();
            } else {
                fillAmount = inputAmount * vamm.balances(1) / bal0;
            }
            dToken = vamm.calc_token_amount([inputAmount, fillAmount], deposit);
        }
    }

    /**
    * @notice get user margin for all collaterals
    */
    function userInfo(address trader) external view returns(int256[] memory) {
        uint length = marginAccount.supportedAssetsLen();
        int256[] memory _margin = new int256[](length);
        // -ve funding means user received funds
        _margin[VUSD_IDX] = marginAccount.margin(VUSD_IDX, trader) - clearingHouse.getTotalFunding(trader);
        for (uint i = 1; i < length; i++) {
            _margin[i] = marginAccount.margin(i, trader);
        }
        return _margin;
    }

    /**
    * @notice get user account information
    */
    function getAccountInfo(address trader) external view returns (
        int totalCollateral,
        int256 freeMargin,
        int256 marginFraction,
        uint notionalPosition,
        int256 unrealizedPnl,
        int256 marginFractionLiquidation
    ) {
        int256 margin;
        (margin, totalCollateral) = marginAccount.weightedAndSpotCollateral(trader);
        marginFraction = clearingHouse.calcMarginFraction(trader, true, IClearingHouse.Mode.Min_Allowable_Margin);

        uint l = clearingHouse.getAmmsLength();
        bool isOverSpreadLimit = false;
        for (uint i; i < l; i++) {
            IAMM amm = clearingHouse.amms(i);
            (int size,,,) = amm.positions(trader);
            IAMM.Maker memory maker = amm.makers(trader);
            if (amm.isOverSpreadLimit() && (size != 0 || maker.dToken != 0 || maker.ignition != 0)) {
                isOverSpreadLimit = true;
            }
        }

        if (isOverSpreadLimit) {
            marginFractionLiquidation = clearingHouse.calcMarginFraction(trader, true, IClearingHouse.Mode.Maintenance_Margin);
        }

        (notionalPosition, unrealizedPnl) = clearingHouse.getTotalNotionalPositionAndUnrealizedPnl(trader, margin, IClearingHouse.Mode.Min_Allowable_Margin);
        int256 minAllowableMargin = clearingHouse.minAllowableMargin();
        freeMargin = margin + unrealizedPnl - clearingHouse.getTotalFunding(trader) - notionalPosition.toInt256() * minAllowableMargin / PRECISION_INT;
    }

    /**
    * @dev Vanity function required for some analyses later
    */
    function getPendingFundings(address[] calldata traders)
        external
        view
        returns(int[][] memory takerFundings, int[][] memory makerFundings)
    {
        uint l = clearingHouse.getAmmsLength();
        uint t = traders.length;
        takerFundings = new int[][](t);
        makerFundings = new int[][](t);
        for (uint j; j < t; j++) {
            takerFundings[j] = new int[](l);
            makerFundings[j] = new int[](l);
            for (uint i; i < l; i++) {
                IAMM amm = clearingHouse.amms(i);
                (takerFundings[j][i],makerFundings[j][i],,) = amm.getPendingFundingPayment(traders[j]);
            }
        }
    }

    // Pure

    function _abs(int x) private pure returns (int) {
        return x >= 0 ? x : -x;
    }
}
