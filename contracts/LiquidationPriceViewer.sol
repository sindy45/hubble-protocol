// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

import { IClearingHouse, IMarginAccount, IAMM, IHubbleViewer, IOracle } from "./Interfaces.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";

contract LiquidationPriceViewer {
    using SafeCast for uint256;
    using SafeCast for int256;

    struct LiquidationPriceData {
        int256 coefficient;
        uint initialPrice;
    }

    int256 constant PRECISION_INT = 1e6;
    uint256 constant PRECISION_UINT = 1e6;

    uint constant VUSD_IDX = 0;
    uint constant WAVAX_IDX = 1;

    IClearingHouse public immutable clearingHouse;
    IMarginAccount public immutable marginAccount;
    IHubbleViewer public immutable hubbleViewer;
    IOracle public immutable oracle;


    constructor(
        IHubbleViewer _hubbleViewer
    ) {
        hubbleViewer = _hubbleViewer;
        clearingHouse = IClearingHouse(hubbleViewer.clearingHouse());
        marginAccount = IMarginAccount(hubbleViewer.marginAccount());
        oracle = marginAccount.oracle();
    }

    /**
    * Get final margin fraction and liquidation price if user longs/shorts baseAssetQuantity
    * @param idx AMM Index
    * @param baseAssetQuantity Positive if long, negative if short, scaled 18 decimals
    * @return expectedMarginFraction Resultant Margin fraction when the trade is executed
    * @return quoteAssetQuantity USD rate for the trade
    * @return liquidationPrice Mark Price at which trader will be liquidated
    */
    function getTakerExpectedMFAndLiquidationPrice(address trader, uint idx, int256 baseAssetQuantity)
        external
        view
        returns (int256 expectedMarginFraction, uint256 quoteAssetQuantity, uint256 liquidationPrice)
    {
        IAMM amm = clearingHouse.amms(idx);
        // get quoteAsset required to swap baseAssetQuantity
        quoteAssetQuantity = hubbleViewer.getQuote(baseAssetQuantity, idx);

        // get market specific position info
        (int256 takerPosSize,,,) = amm.positions(trader);
        // get total notionalPosition and margin (including unrealizedPnL and funding)
        // using IClearingHouse.Mode.Min_Allowable_Margin here to calculate correct newNotional
        (uint256 notionalPosition, int256 margin) = clearingHouse.getNotionalPositionAndMargin(trader, true /* includeFundingPayments */, IClearingHouse.Mode.Min_Allowable_Margin);

        {
            uint takerNowNotional = amm.getCloseQuote(takerPosSize);
            takerPosSize += baseAssetQuantity;
            uint takerUpdatedNotional = amm.getCloseQuote(takerPosSize);
            // Calculate new total notionalPosition
            notionalPosition = notionalPosition + takerUpdatedNotional - takerNowNotional;

            margin -= _calculateTradeFee(quoteAssetQuantity).toInt256();
            expectedMarginFraction = _getMarginFraction(margin, notionalPosition);
        }
        liquidationPrice = _getTakerLiquidationPrice(trader, amm, notionalPosition, takerPosSize, margin);
    }

    /**
    * Get final margin fraction and liquidation price if user add/remove liquidity
    * @param idx AMM Index
    * @param vUSD vUSD amount to be added/removed in the pool (in 6 decimals)
    * @param isRemove true is liquidity is being removed, false if added
    * @return expectedMarginFraction Resultant Margin fraction after the tx
    * @return liquidationPriceData data required to calculate maker liquidation price
    */
    function getMakerExpectedMFAndLiquidationPrice(address trader, uint idx, uint vUSD, bool isRemove)
        external
        view
        returns (int256 expectedMarginFraction, LiquidationPriceData memory liquidationPriceData)
    {
        // get total notionalPosition and margin (including unrealizedPnL and funding)
        (uint256 notionalPosition, int256 margin) = clearingHouse.getNotionalPositionAndMargin(trader, true /* includeFundingPayments */, IClearingHouse.Mode.Min_Allowable_Margin);

        IAMM amm = clearingHouse.amms(idx);

        // get taker info
        (int256 takerPosSize,,,) = amm.positions(trader);
        uint takerNotional = amm.getCloseQuote(takerPosSize);

        // get maker info
        IAMM.Maker memory maker = amm.makers(trader);

        {
            // calculate total value of deposited liquidity after the tx
            if (isRemove) {
                (,uint dToken) = hubbleViewer.getMakerQuote(idx, vUSD, false /* isBase */, false /* deposit */);
                maker.vUSD = maker.vUSD * (maker.dToken - dToken) / maker.dToken;
                maker.vAsset = maker.vAsset * (maker.dToken - dToken) / maker.dToken;
            } else {
                maker.vUSD += vUSD;
                if (amm.ammState() == IAMM.AMMState.Active) {
                    (uint vAsset,) = hubbleViewer.getMakerQuote(idx, vUSD, false /* isBase */, true /* deposit */);
                    maker.vAsset += vAsset;
                }
            }
        }

        {
            // calculate effective notionalPosition
            (int256 makerPosSize,,) = hubbleViewer.getMakerPositionAndUnrealizedPnl(trader, idx);
            uint totalPosNotional = amm.getCloseQuote(makerPosSize + takerPosSize);
            notionalPosition += _max(2 * maker.vUSD + takerNotional, totalPosNotional);
        }

        {
            (uint nowNotional,,,) = amm.getNotionalPositionAndUnrealizedPnl(trader);
            notionalPosition -= nowNotional;
        }

        expectedMarginFraction = _getMarginFraction(margin, notionalPosition);
        // approximating price at the time of add/remove as y / x
        if (maker.vAsset != 0) {
            (,int256 takerPnl) = amm.getTakerNotionalPositionAndUnrealizedPnl(trader);
            liquidationPriceData = LiquidationPriceData({
                coefficient: _getMakerLiquidationPrice(trader, 2 * maker.vUSD.toInt256(), takerPnl),
                initialPrice: maker.vUSD * 1e18 / maker.vAsset
            });
        }
    }

    function getTakerLiquidationPrice(address trader, uint idx) external view returns (uint liquidationPrice) {
        IAMM amm = clearingHouse.amms(idx);
        (int256 takerPosSize,,,) = amm.positions(trader);
        // using IClearingHouse.Mode.Maintenance_Margin to get liquidation mode notional
        (uint256 notionalPosition, int256 margin) = clearingHouse.getNotionalPositionAndMargin(trader, true, IClearingHouse.Mode.Maintenance_Margin);
        liquidationPrice = _getTakerLiquidationPrice(trader, amm, notionalPosition, takerPosSize, margin);
    }

    function getMakerLiquidationPrice(address trader, uint idx) external view returns (LiquidationPriceData memory liquidationPriceData) {
        IAMM amm = clearingHouse.amms(idx);
        IAMM.Maker memory maker = amm.makers(trader);
        (,int256 takerPnl) = amm.getTakerNotionalPositionAndUnrealizedPnl(trader);
        if (maker.vAsset != 0) {
            liquidationPriceData =  LiquidationPriceData({
                coefficient: _getMakerLiquidationPrice(trader, 2 * maker.vUSD.toInt256(), takerPnl),
                initialPrice: maker.vUSD * 1e18 / maker.vAsset
            });
        }
    }

    function getMakerLeverage(address maker, uint idx) external view returns(uint leverage) {
        IAMM amm = clearingHouse.amms(idx);
        uint makerNotional = 2 * amm.makers(maker).vUSD;
        (, int256 margin) = clearingHouse.getNotionalPositionAndMargin(maker, true, IClearingHouse.Mode.Maintenance_Margin);
        leverage = makerNotional * PRECISION_UINT / margin.toUint256();
    }

    // Internal

   /**
    * @notice get taker liquidation price, while ignoring future maker PnL (but factors in maker's notional)
    * margin + (liqPrice - indexPrice) * avax + takerPnl = MM * notionalPosition - (1) where,
    * notionalPosition = takerNotional (at liquidation) + makerNotional
    * takerPnl = (liqPrice - indexPrice) * size - (2), where size is with sign
    * margin = weightedCollateral + unrealizedPnl - pendingFunding
    * avax = avaxBalance * weight

    * For long,
    * notionalPosition = nowNotional + (liqPrice - indexPrice) * size - (3)
    * substitute (2) and (3) in (1),
    * liqPrice = indexPrice + (MM * nowNotional - margin) / (avax + (1 - MM) * size)

    * For short,
    * notionalPosition = nowNotional - (liqPrice - indexPrice) * size - (4)
    * substitute (2) and (4) in (1),
    * liqPrice = indexPrice + (MM * nowNotional - margin) / (avax + (1 + MM) * size)
    */
    function _getTakerLiquidationPrice(
        address trader,
        IAMM amm,
        uint nowNotional,
        int256 takerPosSize,
        int256 margin
    )
        internal
        view
        returns(uint256 /* liquidationPrice */)
    {
        if (takerPosSize == 0) {
            return 0;
        }

        int256 avax = marginAccount.margin(WAVAX_IDX, trader);
        avax = avax * (marginAccount.supportedAssets())[WAVAX_IDX].weight.toInt256() / PRECISION_INT;
        int256 MM = clearingHouse.maintenanceMargin();
        int256 indexPrice = oracle.getUnderlyingPrice(amm.underlyingAsset());

        int256 multiplier = takerPosSize > 0 ? (PRECISION_INT - MM) : (PRECISION_INT + MM);
        // assumption : position size and avax have same precision
        multiplier = multiplier * takerPosSize / PRECISION_INT + avax;
        int256 liquidationPrice = indexPrice + (nowNotional.toInt256() * MM / PRECISION_INT - margin) * 1e18 / multiplier;

        // negative liquidation price is possible when margin is too high
        return liquidationPrice >= 0 ? liquidationPrice.toUint256() : 0;
    }


    /**
    * @notice get maker liquidation price
    * @dev assumes constant collateral value, constant taker pnl
    * @dev assumes taker notional = 0
    * P1 - initialPrice, P2 - liquidationPrice
    * https://medium.com/auditless/how-to-calculate-impermanent-loss-full-derivation-803e8b2497b7
    * Impermanent Loss (IL) =  2 * sqrt(k) / (k + 1) - 1 - (1), where k = P2 / P1
    * makerPnl = IL * makerNotional - (2)
    * assuming maker notional will be constant = 2 * maker.vAsset and constant taker PNL at current price

    * margin + makerPnl = MM * makerNotional - (3)
    * substitute (1) and (2) in (3)
    * margin + (2 * sqrt(k) / (k + 1) - 1) * makerNotional = MM * makerNotional - (4)
    * assuming constant margin here or else equation (4) will become a degree 4 polynomial
    * let x^2 = k and coefficient b = 2 * makerNotional / (MM * makerNotional + makerNotional - margin)
    * equation (4) can be simplified as,
    * x^2 - b * x + 1 = 0 - (5)
    * longLiqPrice = x1^2 * P1, shortLiqPrice = x2^2 * P1, where x1 and x2 are roots of equation (5)
    */
    function _getMakerLiquidationPrice(
        address trader,
        int256 makerNotional,
        int256 takerPnl
    )
        internal
        view
        returns(int256 /* coefficient */)
    {
        // factor in taker position pnl at current price
        int256 margin = marginAccount.getNormalizedMargin(trader) + takerPnl - clearingHouse.getTotalFunding(trader);
        int256 MM = clearingHouse.maintenanceMargin();

        return 2 * makerNotional * PRECISION_INT / ((MM + PRECISION_INT) * makerNotional / PRECISION_INT - margin);
    }

    function _calculateTradeFee(uint quoteAsset) internal view returns (uint) {
        return quoteAsset * clearingHouse.tradeFee() / PRECISION_UINT;
    }

    // Pure

    function _getMarginFraction(int256 accountValue, uint notionalPosition) private pure returns(int256) {
        if (notionalPosition == 0) {
            return type(int256).max;
        }
        return accountValue * PRECISION_INT / notionalPosition.toInt256();
    }

    function _abs(int x) private pure returns (int) {
        return x >= 0 ? x : -x;
    }

    function _max(uint x, uint y) private pure returns (uint) {
        return x >= y ? x : y;
    }
}
