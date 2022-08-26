// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

import { IClearingHouse, IMarginAccount, IAMM, IHubbleViewer } from "./Interfaces.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";

contract LiquidationPriceViewer {
    using SafeCast for uint256;
    using SafeCast for int256;

    int256 constant PRECISION_INT = 1e6;
    uint256 constant PRECISION_UINT = 1e6;

    uint constant VUSD_IDX = 0;
    uint constant WAVAX_IDX = 1;

    IClearingHouse public immutable clearingHouse;
    IMarginAccount public immutable marginAccount;
    IHubbleViewer public immutable hubbleViewer;


    constructor(
        IHubbleViewer _hubbleViewer
    ) {
        hubbleViewer = _hubbleViewer;
        clearingHouse = IClearingHouse(hubbleViewer.clearingHouse());
        marginAccount = IMarginAccount(hubbleViewer.marginAccount());
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

        // get total notionalPosition and margin (including unrealizedPnL and funding)
        (uint256 notionalPosition, int256 margin) = clearingHouse.getNotionalPositionAndMargin(trader, true /* includeFundingPayments */, IClearingHouse.Mode.Min_Allowable_Margin);

        // get market specific position info
        (int256 takerPosSize, uint takerOpenNotional,,) = amm.positions(trader);
        uint takerNowNotional = amm.getCloseQuote(takerPosSize);
        uint takerUpdatedNotional = amm.getCloseQuote(takerPosSize + baseAssetQuantity);
        // Calculate new total notionalPosition
        notionalPosition = notionalPosition + takerUpdatedNotional - takerNowNotional;

        margin -= _calculateTradeFee(quoteAssetQuantity).toInt256();
        expectedMarginFraction = _getMarginFraction(margin, notionalPosition);
        liquidationPrice = _getTakerLiquidationPrice(trader, amm, takerPosSize, takerOpenNotional, baseAssetQuantity, quoteAssetQuantity, margin);
    }

    /**
    * Get final margin fraction and liquidation price if user add/remove liquidity
    * @param idx AMM Index
    * @param vUSD vUSD amount to be added/removed in the pool (in 6 decimals)
    * @param isRemove true is liquidity is being removed, false if added
    * @return expectedMarginFraction Resultant Margin fraction after the tx
    * @return longLiquidationPrice Price at which maker will be liquidated if long
    * @return shortLiquidationPrice Price at which maker will be liquidated if short
    */
    function getMakerExpectedMFAndLiquidationPrice(address trader, uint idx, uint vUSD, bool isRemove)
        external
        view
        returns (int256 expectedMarginFraction, uint256 longLiquidationPrice, uint256 shortLiquidationPrice)
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
            (longLiquidationPrice, shortLiquidationPrice) = _getMakerLiquidationPrice(
                trader, takerPosSize, 2 * maker.vUSD.toInt256(), (maker.vUSD * 1e18 / maker.vAsset).toInt256(), margin
            );
        }
    }

    function getTakerLiquidationPrice(address trader, uint idx) external view returns (uint liquidationPrice) {
        // get total notionalPosition and margin (including unrealizedPnL and funding)
        (,int256 margin) = clearingHouse.getNotionalPositionAndMargin(trader, true /* includeFundingPayments */, IClearingHouse.Mode.Maintenance_Margin);
        IAMM amm = clearingHouse.amms(idx);
        (int256 takerPosSize, uint takerOpenNotional,,) = amm.positions(trader);
        liquidationPrice = _getTakerLiquidationPrice(trader, amm, takerPosSize, takerOpenNotional, 0, 0, margin);
    }

    function getMakerLiquidationPrice(address trader, uint idx) external view returns (uint longLiquidationPrice, uint shortLiquidationPrice) {
        // get total notionalPosition and margin (including unrealizedPnL and funding)
        (,int256 margin) = clearingHouse.getNotionalPositionAndMargin(trader, true /* includeFundingPayments */, IClearingHouse.Mode.Maintenance_Margin);
        IAMM amm = clearingHouse.amms(idx);
        (int256 takerPosSize,,,) = amm.positions(trader);
        IAMM.Maker memory maker = amm.makers(trader);
        if (maker.vAsset != 0) {
            return  _getMakerLiquidationPrice(
                trader, takerPosSize, 2 * maker.vUSD.toInt256(), (maker.vUSD * 1e18 / maker.vAsset).toInt256(), margin
            );
        }
    }

   /**
    * @notice get taker liquidation price, while ignoring maker PnL (but factors in maker's notional)
    * margin + pnl = MM * notionalPosition - (1)
    *   where notionalPosition = takerNotional + makerNotional - (1.a)
    * notionalPosition = takerNotional + makerNotional - (2)
    * let liquidation price = P2, takerNotional = P2 * size - (3)
    * margin = hUSD + avax * P2; where - (4)
    *   hUSD = hUSDBalance + unrealizedPnl - pendingFunding - (4.a)
    *   avax = avaxBalance * weight - (4.b)
    * takerNotional = size * P2 - (5)

    * For long, pnl = takerNotional - openNotional - (6)
    * substitute (4), (6) and (1.a) in (1),
    * (hUSD + avax * P2) + (takerNotional - openNotional) = MM * (takerNotional + makerNotional)
    * substitute (5),
    * => (hUSD + avax * P2) + (size * P2 - openNotional) = MM * (size * P2 + makerNotional)
    * => P2 * (avax + size (1 - MM)) = MM * makerNotional + openNotional - hUSD
    * => P2 = (MM * makerNotional + openNotional - hUSD) / (avax + size (1 - MM))

    * For short, pnl = openNotional - takerNotional - (7)
    * substitute (4), (7) and (1.a) in (1),
    * (hUSD + avax * P2) + (openNotional - takerNotional) = MM * (takerNotional + makerNotional)
    * substitute (5),
    * => (hUSD + avax * P2) + (openNotional - size * P2) = MM * (size * P2 + makerNotional)
    * => P2 * (avax - size (1 + MM)) = MM * makerNotional - openNotional - hUSD
    * => P2 = (MM * makerNotional - openNotional - hUSD) / (avax - size (1 + MM))
    * Multiply by -1
    * => P2 = (openNotional + hUSD - MM * makerNotional) / (size * (1 + MM) - avax)
    */
    function _getTakerLiquidationPrice(
        address trader,
        IAMM amm,
        int256 takerPosSize,
        uint takerOpenNotional,
        int256 baseAssetQuantity,
        uint quoteAssetQuantity,
        int256 margin
    )
        internal
        view
        returns(uint256 liquidationPrice)
    {
        if (takerPosSize + baseAssetQuantity == 0) {
            return 0;
        }

        (, int256 unrealizedPnl) = amm.getTakerNotionalPositionAndUnrealizedPnl(trader);

        if (baseAssetQuantity != 0) {
            // Calculate effective position and openNotional
            if (baseAssetQuantity * takerPosSize >= 0) { // increasingPosition i.e. same direction trade
                takerOpenNotional += quoteAssetQuantity;
            } else { // open reverse position
                uint totalPosNotional = amm.getCloseQuote(takerPosSize + baseAssetQuantity);
                if (_abs(takerPosSize) >= _abs(baseAssetQuantity)) { // position side remains same after the trade
                    (takerOpenNotional,) = amm.getOpenNotionalWhileReducingPosition(
                        takerPosSize,
                        totalPosNotional,
                        unrealizedPnl,
                        baseAssetQuantity
                    );
                } else { // position side changes after the trade
                    takerOpenNotional = totalPosNotional;
                }
            }
            takerPosSize += baseAssetQuantity;
        }

        (, unrealizedPnl) = clearingHouse.getTotalNotionalPositionAndUnrealizedPnl(trader, margin, IClearingHouse.Mode.Min_Allowable_Margin);
        int256 hUSD = marginAccount.margin(VUSD_IDX, trader) + unrealizedPnl - clearingHouse.getTotalFunding(trader);

        int256 avax = marginAccount.margin(WAVAX_IDX, trader);
        avax = avax * (marginAccount.supportedAssets())[WAVAX_IDX].weight.toInt256() / PRECISION_INT;

        int256 MM = clearingHouse.maintenanceMargin();
        int256 makerNotional = 2 * (amm.makers(trader)).vUSD.toInt256();
        makerNotional = makerNotional * MM / PRECISION_INT;

        int256 _liquidationPrice;
        if (takerPosSize > 0) {
            _liquidationPrice = (takerOpenNotional.toInt256() - hUSD + makerNotional) * 1e18 / (takerPosSize * (PRECISION_INT - MM) / PRECISION_INT + avax);
        } else if (takerPosSize < 0) {
            takerPosSize = (-takerPosSize) * (PRECISION_INT + MM) / PRECISION_INT;
            if (takerPosSize != avax) { // otherwise the position is delta-neutral
                _liquidationPrice = (takerOpenNotional.toInt256() + hUSD - makerNotional) * 1e18 / (takerPosSize - avax);
            }
        }

        // negative liquidation price is possible when position size is small compared to margin added and
        // hence pnl will not be big enough to reach liquidation
        // in this case, (takerOpenNotional - hUSD) < 0 because of high margin
        if (_liquidationPrice < 0) {
            _liquidationPrice = 0;
        }
        return _liquidationPrice.toUint256();
    }


    /**
    * @notice get maker liquidation price, while ignoring taker PnL (but factors in taker's notional)
    * @dev for maker pnl, approximating long/short price as the price at the time of adding liquidity.
        Since makers take long position when markPrice goes down
        and short when it goes up, this approximation will result in pessimistic liquidation price for maker
    * assuming maker notional will be constant = 2 * maker.vAsset and taker PNL = 0
    * P1 - initialPrice, P2 - liquidationPrice

    * if maker long, P2 < P1, deltaP = P2 - P1
    * => P2 * (makerNotional / P1 + avax - MM * size) = makerNotional * (1 + MM) - hUSD

    * if maker short, P2 > P1, deltaP = P1 - P2
    * => P2 * (makerNotional / P1 - avax + MM * size) = makerNotional * (1 - MM) + hUSD
    */
    function _getMakerLiquidationPrice(
        address trader,
        int256 takerPosSize,
        int256 makerNotional,
        int256 initialPrice,
        int256 margin
    )
        internal
        view
        returns(uint longLiquidationPrice, uint shortLiquidationPrice)
    {
        (, int256 unrealizedPnl) = clearingHouse.getTotalNotionalPositionAndUnrealizedPnl(trader, margin, IClearingHouse.Mode.Min_Allowable_Margin);
        int256 hUSD = marginAccount.margin(VUSD_IDX, trader) + unrealizedPnl - clearingHouse.getTotalFunding(trader);

        int256 avax = marginAccount.margin(WAVAX_IDX, trader);
        uint weight = (marginAccount.supportedAssets())[WAVAX_IDX].weight;
        avax = avax * weight.toInt256() / PRECISION_INT;

        int256 MM = clearingHouse.maintenanceMargin();
        takerPosSize = _abs(takerPosSize) * MM / PRECISION_INT;

        int256 _longLiquidationPrice = makerNotional * (PRECISION_INT + MM) / PRECISION_INT - hUSD;
        _longLiquidationPrice = _longLiquidationPrice * 1e18 / (makerNotional * 1e18 / initialPrice + avax - takerPosSize);

        int256 _shortLiquidationPrice = makerNotional * (PRECISION_INT - MM) / PRECISION_INT + hUSD;
        _shortLiquidationPrice = _shortLiquidationPrice * 1e18 / (makerNotional * 1e18 / initialPrice - avax + takerPosSize);

        if (_longLiquidationPrice < 0) {
            _longLiquidationPrice = 0;
        }

        if (_shortLiquidationPrice < 0) {
            _shortLiquidationPrice = 0;
        }
        return (_longLiquidationPrice.toUint256(), _shortLiquidationPrice.toUint256());
    }

    // Internal

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
