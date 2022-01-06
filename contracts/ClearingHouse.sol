// SPDX-License-Identifier: MIT

pragma solidity 0.8.4;

import { ERC2771ContextUpgradeable } from "@openzeppelin/contracts-upgradeable/metatx/ERC2771ContextUpgradeable.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import { VanillaGovernable } from "./Governable.sol";
import { IAMM, IInsuranceFund, IMarginAccount } from "./Interfaces.sol";
import { VUSD } from "./VUSD.sol";

contract ClearingHouse is VanillaGovernable, ERC2771ContextUpgradeable {
    using SafeCast for uint256;
    using SafeCast for int256;

    uint256 constant PRECISION = 1e6;

    int256 public maintenanceMargin;
    uint public tradeFee;
    uint public liquidationPenalty;

    VUSD public vusd;
    IInsuranceFund public insuranceFund;
    IMarginAccount public marginAccount;
    IAMM[] public amms;

    /// @dev UI Helper
    struct MarketInfo {
        address amm;
        address underlying;
    }

    struct Position {
        int256 size;
        uint256 openNotional;
        int256 unrealizedPnl;
        uint256 avgOpen;
    }

    event PositionModified(address indexed trader, uint indexed idx, int256 baseAssetQuantity, uint quoteAsset);
    event PositionLiquidated(address indexed trader, address indexed amm, int256 size, uint256 quoteAsset, int256 realizedPnl);
    event MarketAdded(address indexed amm);

    function initialize(
        address _trustedForwarder,
        address _governance,
        address _insuranceFund,
        address _marginAccount,
        address _vusd,
        int256 _maintenanceMargin,
        uint _tradeFee,
        uint _liquidationPenalty
    ) external {
        __ERC2771Context_init(_trustedForwarder); // has the initializer modifier
        _setGovernace(_governance);

        insuranceFund = IInsuranceFund(_insuranceFund);
        marginAccount = IMarginAccount(_marginAccount);
        vusd = VUSD(_vusd);

        require(_maintenanceMargin > 0, "_maintenanceMargin < 0");
        maintenanceMargin = _maintenanceMargin;
        tradeFee = _tradeFee;
        liquidationPenalty = _liquidationPenalty;
    }

    /**
    * @notice Open/Modify/Close Position
    * @param idx AMM index
    * @param baseAssetQuantity Quantity of the base asset to Long (baseAssetQuantity > 0) or Short (baseAssetQuantity < 0)
    * @param quoteAssetLimit Rate at which the trade is executed in the AMM. Used to cap slippage.
    */
    function openPosition(uint idx, int256 baseAssetQuantity, uint quoteAssetLimit) external {
        _openPosition(_msgSender(), idx, baseAssetQuantity, quoteAssetLimit);
    }

    function closePosition(uint idx, uint quoteAssetLimit) external {
        address trader = _msgSender();
        (int256 size,,) = amms[idx].positions(trader);
        _openPosition(trader, idx, -size, quoteAssetLimit);
    }

    function _openPosition(address trader, uint idx, int256 baseAssetQuantity, uint quoteAssetLimit) internal {
        require(baseAssetQuantity != 0, "CH: baseAssetQuantity == 0");

        updatePositions(trader); // adjust funding payments

        (int realizedPnl, uint quoteAsset, bool isPositionIncreased) = amms[idx].openPosition(trader, baseAssetQuantity, quoteAssetLimit);
        uint _tradeFee = _chargeFeeAndRealizePnL(trader, realizedPnl, quoteAsset, false /* isLiquidation */);
        vusd.mint(address(insuranceFund), _tradeFee);

        if (isPositionIncreased) {
            require(isAboveMaintenanceMargin(trader), "CH: Below Maintenance Margin");
        }
        emit PositionModified(trader, idx, baseAssetQuantity, quoteAsset);
    }

    function addLiquidity(uint idx, uint256 baseAssetQuantity, uint quoteAssetLimit) external {
        address maker = _msgSender();
        updatePositions(maker);
        amms[idx].addLiquidity(maker, baseAssetQuantity, quoteAssetLimit);
        require(isAboveMaintenanceMargin(maker), "CH: Below Maintenance Margin");
    }

    function removeLiquidity(uint idx, uint256 amount, uint minQuoteValue, uint minBaseValue) external {
        address maker = _msgSender();
        updatePositions(maker);
        int256 realizedPnl = amms[idx].removeLiquidity(maker, amount, minQuoteValue, minBaseValue);
        marginAccount.realizePnL(maker, realizedPnl);
    }

    function liquidateMaker(address maker) external {
        updatePositions(maker);

        require(
            _calcMarginFraction(maker, false) < maintenanceMargin,
            "CH: Above Maintenance Margin"
        );

        int256 realizedPnl;
        for (uint i = 0; i < amms.length; i++) {
            (,, uint dToken,,,,) = amms[i].makers(maker);
            realizedPnl += amms[i].removeLiquidity(maker, dToken, 0, 0);
        }
        marginAccount.realizePnL(maker, realizedPnl);
    }

    function updatePositions(address trader) public {
        require(address(trader) != address(0), 'CH: 0x0 trader Address');
        int256 fundingPayment;
        for (uint i = 0; i < amms.length; i++) {
            fundingPayment += amms[i].updatePosition(trader);
        }
        // -ve fundingPayment means trader should receive funds
        marginAccount.realizePnL(trader, -fundingPayment);
    }

    function settleFunding() external {
        for (uint i = 0; i < amms.length; i++) {
            amms[i].settleFunding();
        }
    }

    /**
    @notice Wooosh, you are now liquidate
    */
    function liquidate(address trader) public {
        require(!hasLiquidity(trader), 'CH: Remove Liquidity First');
        updatePositions(trader);
        require(_calcMarginFraction(trader, false /* check funding payments again */) < maintenanceMargin, "Above Maintenance Margin");
        int realizedPnl;
        uint quoteAsset;
        int256 size;
        IAMM _amm;
        for (uint i = 0; i < amms.length; i++) { // liquidate all positions
            _amm = amms[i];
            (size,,) = _amm.positions(trader);
            if (size != 0) {
                (int _realizedPnl, uint _quoteAsset) = _amm.liquidatePosition(trader);
                realizedPnl += _realizedPnl;
                quoteAsset += _quoteAsset;
                emit PositionLiquidated(trader, address(_amm), size, _quoteAsset, _realizedPnl);
            }
        }
        // extra liquidation penalty
        uint _liquidationFee = _chargeFeeAndRealizePnL(trader, realizedPnl, quoteAsset, true /* isLiquidation */);
        if (_liquidationFee > 0) {
            uint _toInsurance = _liquidationFee / 2;
            vusd.mint(address(insuranceFund), _toInsurance);
            vusd.mint(_msgSender(), _liquidationFee - _toInsurance);
        }
    }

    function liquidateMany(address[] calldata traders) external {
        for (uint i = 0; i < traders.length; i++) {
            liquidate(traders[i]);
        }
    }

    function _chargeFeeAndRealizePnL(
        address trader,
        int realizedPnl,
        uint quoteAsset,
        bool isLiquidation
    )
        internal
        returns (uint fee)
    {
        fee = isLiquidation ? _calculateLiquidationPenalty(quoteAsset) : _calculateTradeFee(quoteAsset);
        int256 marginCharge = realizedPnl - fee.toInt256();
        if (marginCharge != 0) {
            marginAccount.realizePnL(trader, marginCharge);
        }
    }

    // View

    function isAboveMaintenanceMargin(address trader) public view returns(bool) {
        return getMarginFraction(trader) >= maintenanceMargin;
    }

    function getMarginFraction(address trader) public view returns(int256) {
        return _calcMarginFraction(trader, true /* includeFundingPayments */);
    }

    function hasLiquidity(address trader) public view returns(bool) {
        for (uint i = 0; i < amms.length; i++) {
            (,, uint dToken,,,,) = amms[i].makers(trader);
            if (dToken > 0) {
                return true;
            }
        }
        return false;
    }

    function getTotalFunding(address trader) public view returns(int256 totalFunding) {
        int256 takerFundingPayment;
        int256 makerFundingPayment;
        for (uint i = 0; i < amms.length; i++) {
            (takerFundingPayment, makerFundingPayment,,) = amms[i].getPendingFundingPayment(trader);
            totalFunding += (takerFundingPayment + makerFundingPayment);
        }
    }

    function getTotalNotionalPositionAndUnrealizedPnl(address trader)
        public
        view
        returns(uint256 notionalPosition, int256 unrealizedPnl)
    {
        uint256 _notionalPosition;
        int256 _unrealizedPnl;
        for (uint i = 0; i < amms.length; i++) {
            (_notionalPosition, _unrealizedPnl,,) = amms[i].getNotionalPositionAndUnrealizedPnl(trader);
            notionalPosition += _notionalPosition;
            unrealizedPnl += _unrealizedPnl;
        }
    }

    // UI Helpers

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
        uint l = amms.length;
        positions = new Position[](l);
        for (uint i = 0; i < l; i++) {
            (positions[i].size, positions[i].openNotional, ) = amms[i].positions(trader);
            if (positions[i].size == 0) {
                positions[i].unrealizedPnl = 0;
                positions[i].avgOpen = 0;
            } else {
                (,positions[i].unrealizedPnl) = amms[i].getTakerNotionalPositionAndUnrealizedPnl(trader);
                positions[i].avgOpen = positions[i].openNotional * 1e18 / _abs(positions[i].size).toUint256();
            }
        }
    }

    /**
    * @notice Get information about all maker impermanent positions
    * @param maker Maker for which information is to be obtained
    * @return positions in order of amms
    *   positions[i].size - BaseAssetQuantity amount longed (+ve) or shorted (-ve)
    *   positions[i].openNotional - $ value of position
    *   positions[i].unrealizedPnl - in dollars. +ve is profit, -ve if loss
    *   positions[i].avgOpen - Average $ value at which position was started
    */
    function makerPositions(address maker) external view returns(Position[] memory positions) {
        uint l = amms.length;
        positions = new Position[](l);
        for (uint i = 0; i < l; i++) {
            (positions[i].size, positions[i].openNotional, positions[i].unrealizedPnl) = amms[i].getMakerPositionAndUnrealizedPnl(maker);
            if (positions[i].size == 0) {
                positions[i].avgOpen = 0;
            } else {
                positions[i].avgOpen = positions[i].openNotional * 1e18 / _abs(positions[i].size).toUint256();
            }
        }
    }

    function markets() external view returns(MarketInfo[] memory _markets) {
        uint l = amms.length;
        _markets = new MarketInfo[](l);
        for (uint i = 0; i < l; i++) {
            _markets[i] = MarketInfo(address(amms[i]), amms[i].underlyingAsset());
        }
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
        // get quoteAsset required to swap baseAssetQuantity
        quoteAssetQuantity = amms[idx].getQuote(baseAssetQuantity);

        // get total notionalPosition and margin (including unrealizedPnL and funding)
        (uint256 notionalPosition, int256 margin) = _getNotionalPositionAndMargin(trader, true /* includeFundingPayments */);

        // get market specific position info
        (int256 takerPosSize,,) = amms[idx].positions(trader);
        uint takerNowNotional = amms[idx].getCloseQuote(takerPosSize);
        uint takerUpdatedNotional = amms[idx].getCloseQuote(takerPosSize + baseAssetQuantity);
        // Calculate new total notionalPosition
        notionalPosition = notionalPosition + takerUpdatedNotional - takerNowNotional;

        margin -= _calculateTradeFee(quoteAssetQuantity).toInt256();
        expectedMarginFraction = _getMarginFraction(margin, notionalPosition);
        liquidationPrice = _getLiquidationPrice(trader, idx, notionalPosition, margin, baseAssetQuantity, quoteAssetQuantity);
    }

    /**
    * Get final margin fraction and liquidation price if user add/remove liquidity
    * @param idx AMM Index
    * @param vUSD vUSD amount to be added in the pool (in 6 decimals)
    * @param isRemove true is liquidity is being removed, false if added
    * @return expectedMarginFraction Resultant Margin fraction after the tx
    * @return liquidationPrice Mark Price at which maker will be liquidated
    */
    function getMakerExpectedMFAndLiquidationPrice(address trader, uint idx, uint vUSD, bool isRemove)
        external
        view
        returns (int256 expectedMarginFraction, uint256 liquidationPrice)
    {
        // get total notionalPosition and margin (including unrealizedPnL and funding)
        (uint256 notionalPosition, int256 margin) = _getNotionalPositionAndMargin(trader, true /* includeFundingPayments */);

        // get taker info
        (int256 takerPosSize,,) = amms[idx].positions(trader);
        uint takerNotional = amms[idx].getCloseQuote(takerPosSize);
        // get maker info
        (uint makerDebt,,,,,,) = amms[idx].makers(trader);
        // calculate total value of deposited liquidity after the tx
        if (isRemove) {
            makerDebt = 2 * (makerDebt / 1e12 - vUSD);
        } else {
            makerDebt = 2 * (makerDebt / 1e12 + vUSD);
        }

        // calculate effective notionalPosition
        (int256 makerPosSize,,) = amms[idx].getMakerPositionAndUnrealizedPnl(trader);
        uint totalPosNotional = amms[idx].getCloseQuote(makerPosSize + takerPosSize);
        notionalPosition += _max(makerDebt + takerNotional, totalPosNotional);
        (uint nowNotional,,,) = amms[idx].getNotionalPositionAndUnrealizedPnl(trader);
        notionalPosition -= nowNotional;

        expectedMarginFraction = _getMarginFraction(margin, notionalPosition);
        liquidationPrice = _getLiquidationPrice(trader, idx, notionalPosition, margin, 0, 0);
    }

    function getLiquidationPrice(address trader, uint idx) external view returns (uint liquidationPrice) {
        // get total notionalPosition and margin (including unrealizedPnL and funding)
        (uint256 notionalPosition, int256 margin) = _getNotionalPositionAndMargin(trader, true /* includeFundingPayments */);
        liquidationPrice = _getLiquidationPrice(trader, idx, notionalPosition, margin, 0, 0);
    }

    /**
    * @dev At liquidation,
    * (margin + pnl) / notionalPosition = maintenanceMargin (MM)
    * => pnl = MM * notionalPosition - margin
    *
    * for long, pnl = liquidationPrice * size - openNotional
    * => liquidationPrice = (pnl + openNotional) / size
    *
    * for short, pnl = openNotional - liquidationPrice * size
    * => liquidationPrice = (openNotional - pnl) / size
    */
    function _getLiquidationPrice(
            address trader,
            uint idx,
            uint256 notionalPosition,
            int256 margin,
            int256 baseAssetQuantity,
            uint quoteAssetQuantity
        )
        internal
        view
        returns(uint256 liquidationPrice)
    {
        if (notionalPosition == 0) {
            return 0;
        }

        (, int256 unrealizedPnl, int256 totalPosSize, uint256 openNotional) = amms[idx].getNotionalPositionAndUnrealizedPnl(trader);

        if (baseAssetQuantity != 0) {
            // Calculate effective position and openNotional
            if (baseAssetQuantity * totalPosSize >= 0) { // increasingPosition i.e. same direction trade
                openNotional += quoteAssetQuantity;
            } else { // open reverse position
                uint totalPosNotional = amms[idx].getCloseQuote(totalPosSize + baseAssetQuantity);
                if (_abs(totalPosSize) >= _abs(baseAssetQuantity)) { // position side remains same after the trade
                    (openNotional,) = amms[idx].getOpenNotionalWhileReducingPosition(
                        totalPosSize,
                        totalPosNotional,
                        unrealizedPnl,
                        baseAssetQuantity
                    );
                } else { // position side changes after the trade
                    openNotional = totalPosNotional;
                }
            }
            totalPosSize += baseAssetQuantity;
        }

        int256 pnlForLiquidation = maintenanceMargin * notionalPosition.toInt256() / 1e6 - margin;
        int256 _liquidationPrice;
        if (totalPosSize > 0) {
            _liquidationPrice = (openNotional.toInt256() + pnlForLiquidation) * 1e18 / totalPosSize;
        } else {
            _liquidationPrice = (openNotional.toInt256() - pnlForLiquidation) * 1e18 / (-totalPosSize);
        }

        if (_liquidationPrice < 0) { // is this possible?
            _liquidationPrice = 0;
        }
        return _liquidationPrice.toUint256();
    }

    // Internal View

    function _calculateTradeFee(uint quoteAsset) internal view returns (uint) {
        return quoteAsset * tradeFee / PRECISION;
    }

    function _calculateLiquidationPenalty(uint quoteAsset) internal view returns (uint) {
        return quoteAsset * liquidationPenalty / PRECISION;
    }

    function _calcMarginFraction(address trader, bool includeFundingPayments) internal view returns(int256) {
        (uint256 notionalPosition, int256 margin) = _getNotionalPositionAndMargin(trader, includeFundingPayments);
        return _getMarginFraction(margin, notionalPosition);
    }

    function _getNotionalPositionAndMargin(address trader, bool includeFundingPayments)
        internal
        view
        returns(uint256 notionalPosition, int256 margin)
    {
        int256 unrealizedPnl;
        (notionalPosition, unrealizedPnl) = getTotalNotionalPositionAndUnrealizedPnl(trader);
        margin = marginAccount.getNormalizedMargin(trader);
        margin += unrealizedPnl;
        if (includeFundingPayments) {
            margin -= getTotalFunding(trader); // -ve fundingPayment means trader should receive funds
        }
    }

    // Pure

    function _getMarginFraction(int256 accountValue, uint notionalPosition) private pure returns(int256) {
        if (notionalPosition == 0) {
            return type(int256).max;
        }
        return accountValue * PRECISION.toInt256() / notionalPosition.toInt256();
    }

    function _abs(int x) private pure returns (int) {
        return x >= 0 ? x : -x;
    }

    function _max(uint x, uint y) private pure returns (uint) {
        return x >= y ? x : y;
    }
    // Governance

    function whitelistAmm(address _amm) external onlyGovernance {
        amms.push(IAMM(_amm));
        emit MarketAdded(_amm);
    }
}
