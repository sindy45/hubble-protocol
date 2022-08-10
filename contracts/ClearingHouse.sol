// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import { HubbleBase } from "./legos/HubbleBase.sol";
import { IAMM, IInsuranceFund, IMarginAccount, IClearingHouse, IHubbleReferral } from "./Interfaces.sol";
import { VUSD } from "./VUSD.sol";

contract ClearingHouse is IClearingHouse, HubbleBase {
    using SafeCast for uint256;
    using SafeCast for int256;

    uint256 constant PRECISION = 1e6;

    int256 override public maintenanceMargin;
    uint override public tradeFee;
    uint override public liquidationPenalty;
    uint public fixedMakerLiquidationFee;
    int256 public minAllowableMargin;
    uint public referralShare;
    uint public tradingFeeDiscount;

    VUSD public vusd;
    IInsuranceFund override public insuranceFund;
    IMarginAccount public marginAccount;
    IAMM[] override public amms;
    IHubbleReferral public hubbleReferral;

    uint256[50] private __gap;

    event PositionModified(address indexed trader, uint indexed idx, int256 baseAsset, uint quoteAsset, int256 realizedPnl, uint256 timestamp);
    event PositionLiquidated(address indexed trader, uint indexed idx, int256 baseAsset, uint256 quoteAsset, int256 realizedPnl, uint256 timestamp);
    event PositionTranslated(address indexed trader, uint indexed idx, int256 baseAsset, uint256 quoteAsset, int256 realizedPnl, uint256 timestamp);
    event MarketAdded(uint indexed idx, address indexed amm);
    event ReferralBonusAdded(address indexed referrer, uint referralBonus);

    constructor(address _trustedForwarder) HubbleBase(_trustedForwarder) {}

    function initialize(
        address _governance,
        address _insuranceFund,
        address _marginAccount,
        address _vusd,
        address _hubbleReferral,
        int256 _maintenanceMargin,
        int256 _minAllowableMargin,
        uint _tradeFee,
        uint _referralShare,
        uint _tradingFeeDiscount,
        uint _liquidationPenalty
    ) external initializer {
        _setGovernace(_governance);

        insuranceFund = IInsuranceFund(_insuranceFund);
        marginAccount = IMarginAccount(_marginAccount);
        vusd = VUSD(_vusd);
        hubbleReferral = IHubbleReferral(_hubbleReferral);

        require(_maintenanceMargin > 0, "_maintenanceMargin < 0");
        maintenanceMargin = _maintenanceMargin;
        minAllowableMargin = _minAllowableMargin;
        tradeFee = _tradeFee;
        referralShare = _referralShare;
        tradingFeeDiscount = _tradingFeeDiscount;
        liquidationPenalty = _liquidationPenalty;

        fixedMakerLiquidationFee = 20 * PRECISION; // $20
    }

    /* ****************** */
    /*     Positions      */
    /* ****************** */

    /**
    * @notice Open/Modify/Close Position
    * @param idx AMM index
    * @param baseAssetQuantity Quantity of the base asset to Long (baseAssetQuantity > 0) or Short (baseAssetQuantity < 0)
    * @param quoteAssetLimit Rate at which the trade is executed in the AMM. Used to cap slippage.
    */
    function openPosition(uint idx, int256 baseAssetQuantity, uint quoteAssetLimit) override external whenNotPaused {
        address trader = _msgSender();
        _openPosition(trader, idx, baseAssetQuantity, quoteAssetLimit);
    }

    function closePosition(uint idx, uint quoteAssetLimit) override external whenNotPaused {
        address trader = _msgSender();
        (int256 size,,,) = amms[idx].positions(trader);
        _openPosition(trader, idx, -size, quoteAssetLimit);
    }

    function _openPosition(address trader, uint idx, int256 baseAssetQuantity, uint quoteAssetLimit) internal {
        require(baseAssetQuantity != 0, "CH: baseAssetQuantity == 0");

        updatePositions(trader); // adjust funding payments

        (int realizedPnl, uint quoteAsset, bool isPositionIncreased) = amms[idx].openPosition(trader, baseAssetQuantity, quoteAssetLimit);
        uint _tradeFee = _chargeFeeAndRealizePnL(trader, realizedPnl, quoteAsset, false /* isLiquidation */);
        marginAccount.transferOutVusd(address(insuranceFund), _tradeFee);

        if (isPositionIncreased) {
            assertMarginRequirement(trader);
        }
        emit PositionModified(trader, idx, baseAssetQuantity, quoteAsset, realizedPnl, _blockTimestamp());
    }

    /* ****************** */
    /*     Liquidity      */
    /* ****************** */

    function commitLiquidity(uint idx, uint quoteAsset)
        override
        external
    {
        address maker = _msgSender();
        updatePositions(maker);
        amms[idx].commitLiquidity(maker, quoteAsset);
        assertMarginRequirement(maker);
    }
    /**
    * @notice Add liquidity to the amm. The free margin from margin account is utilized for the same
    *   The liquidity can be provided on leverage.
    * @param idx Index of the AMM
    * @param baseAssetQuantity Amount of the asset to add to AMM. Equivalent amount of USD side is automatically added.
    *   This means that user is actually adding 2 * baseAssetQuantity * markPrice.
    * @param minDToken Min amount of dTokens to receive. Used to cap slippage.
    */
    function addLiquidity(uint idx, uint256 baseAssetQuantity, uint minDToken) override external whenNotPaused returns (uint dToken) {
        address maker = _msgSender();
        updatePositions(maker);
        dToken = amms[idx].addLiquidity(maker, baseAssetQuantity, minDToken);
        assertMarginRequirement(maker);
    }

    /**
    * @notice Remove liquidity from the amm.
    * @dev dToken > 0 has been asserted during amm.unbondLiquidity
    * @param idx Index of the AMM
    * @param dToken Measure of the liquidity to remove.
    * @param minQuoteValue Min amount of USD to remove.
    * @param minBaseValue Min amount of base to remove.
    *   Both the above params enable capping slippage in either direction.
    */
    function removeLiquidity(uint idx, uint256 dToken, uint minQuoteValue, uint minBaseValue) override external whenNotPaused {
        require(dToken > 0, "liquidity_being_removed_should_be_non_0");
        address maker = _msgSender();
        updatePositions(maker);
        (int256 realizedPnl, uint quoteAsset, int baseAssetQuantity) = amms[idx].removeLiquidity(maker, dToken, minQuoteValue, minBaseValue);
        marginAccount.realizePnL(maker, realizedPnl);
        if (baseAssetQuantity != 0) {
            emit PositionTranslated(maker, idx, baseAssetQuantity, quoteAsset, realizedPnl, _blockTimestamp());
        }
    }

    function updatePositions(address trader) override public whenNotPaused {
        require(address(trader) != address(0), 'CH: 0x0 trader Address');
        int256 fundingPayment;
        uint numAmms = amms.length;
        for (uint i; i < numAmms; ++i) {
            fundingPayment += amms[i].updatePosition(trader);
        }
        // -ve fundingPayment means trader should receive funds
        marginAccount.realizePnL(trader, -fundingPayment);
    }

    function settleFunding() override external whenNotPaused {
        uint numAmms = amms.length;
        for (uint i; i < numAmms; ++i) {
            amms[i].settleFunding();
        }
    }

    /* ****************** */
    /*    Liquidations    */
    /* ****************** */

    function liquidate(address trader) override external whenNotPaused {
        updatePositions(trader);
        if (isMaker(trader)) {
            _liquidateMaker(trader);
        } else {
            _liquidateTaker(trader);
        }
    }

    function liquidateMaker(address maker) override public whenNotPaused {
        updatePositions(maker);
        _liquidateMaker(maker);
    }

    function liquidateTaker(address trader) override public whenNotPaused {
        require(!isMaker(trader), 'CH: Remove Liquidity First');
        updatePositions(trader);
        _liquidateTaker(trader);
    }

    /* ********************* */
    /* Liquidations Internal */
    /* ********************* */

    function _liquidateMaker(address maker) internal {
        _assertLiquidationRequirement(maker);

        int256 realizedPnl;
        bool _isMaker;

        // in-loop reusable var
        int256 _realizedPnl;
        uint256 quoteAsset;
        int256 baseAssetQuantity;

        uint l = getAmmsLength();
        for (uint i; i < l; ++i) {
            IAMM.Maker memory _maker = amms[i].makers(maker);
            if (_maker.dToken == 0 && _maker.ignition == 0) continue;
            (_realizedPnl, quoteAsset, baseAssetQuantity) = amms[i].forceRemoveLiquidity(maker);
            _isMaker = true;
            realizedPnl += _realizedPnl;
            if (baseAssetQuantity != 0) {
                emit PositionTranslated(maker, i, baseAssetQuantity, quoteAsset, _realizedPnl, _blockTimestamp());
            }
        }

        // charge a fixed liquidation only if the account is a maker in atleast 1 of the markets
        if (_isMaker) {
            realizedPnl -= fixedMakerLiquidationFee.toInt256();
            _disperseLiquidationFee(fixedMakerLiquidationFee);
        }
        if (realizedPnl != 0) {
            marginAccount.realizePnL(maker, realizedPnl);
        }
    }

    function _liquidateTaker(address trader) internal {
        _assertLiquidationRequirement(trader);
        int realizedPnl;
        uint quoteAsset;
        int256 size;
        IAMM _amm;
        uint numAmms = amms.length;
        for (uint i; i < numAmms; ++i) { // liquidate all positions
            _amm = amms[i];
            (size,,,) = _amm.positions(trader);
            if (size != 0) {
                (int _realizedPnl, int _baseAsset, uint _quoteAsset) = _amm.liquidatePosition(trader);
                realizedPnl += _realizedPnl;
                quoteAsset += _quoteAsset;
                emit PositionLiquidated(trader, i, _baseAsset, _quoteAsset, _realizedPnl, _blockTimestamp());
            }
        }

        _disperseLiquidationFee(
            _chargeFeeAndRealizePnL(trader, realizedPnl, quoteAsset, true /* isLiquidation */)
        );
    }

    function _disperseLiquidationFee(uint liquidationFee) internal {
        if (liquidationFee > 0) {
            uint toInsurance = liquidationFee / 2;
            marginAccount.transferOutVusd(address(insuranceFund), toInsurance);
            marginAccount.transferOutVusd(_msgSender(), liquidationFee - toInsurance);
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
        int256 marginCharge;
        if (isLiquidation) {
            fee = _calculateLiquidationPenalty(quoteAsset);
            marginCharge = realizedPnl - fee.toInt256();
        } else {
            fee = _calculateTradeFee(quoteAsset);

            address referrer = hubbleReferral.getTraderRefereeInfo(trader);
            uint referralBonus;
            if (referrer != address(0x0)) {
                referralBonus = fee * referralShare / PRECISION;
                fee -= fee * tradingFeeDiscount / PRECISION;
                // add margin to the referrer
                marginAccount.realizePnL(referrer, referralBonus.toInt256());
                emit ReferralBonusAdded(referrer, referralBonus);
            }

            marginCharge = realizedPnl - fee.toInt256();
            // deduct referral bonus from insurance fund share
            fee -= referralBonus;
        }

        marginAccount.realizePnL(trader, marginCharge);
    }

    /* ****************** */
    /*        View        */
    /* ****************** */

    function calcMarginFraction(address trader, bool includeFundingPayments, Mode mode) public view returns(int256) {
        (uint256 notionalPosition, int256 margin) = getNotionalPositionAndMargin(trader, includeFundingPayments, mode);
        return _getMarginFraction(margin, notionalPosition);
    }

    function isMaker(address trader) override public view returns(bool) {
        uint numAmms = amms.length;
        for (uint i; i < numAmms; ++i) {
            IAMM.Maker memory maker = amms[i].makers(trader);
            if (maker.dToken > 0 || maker.ignition > 0) {
                return true;
            }
        }
        return false;
    }

    function getTotalFunding(address trader) override public view returns(int256 totalFunding) {
        int256 takerFundingPayment;
        int256 makerFundingPayment;
        int256 fundingPayment;
        uint numAmms = amms.length;
        for (uint i; i < numAmms; ++i) {
            (takerFundingPayment, makerFundingPayment,,) = amms[i].getPendingFundingPayment(trader);
            fundingPayment = takerFundingPayment + makerFundingPayment;
            if (fundingPayment < 0) {
                fundingPayment -= fundingPayment / 1e3; // receivers charged 0.1% to account for rounding-offs
            }
            totalFunding += fundingPayment;
        }
    }

    function getTotalNotionalPositionAndUnrealizedPnl(address trader, int256 margin, Mode mode)
        override
        public
        view
        returns(uint256 notionalPosition, int256 unrealizedPnl)
    {
        uint256 _notionalPosition;
        int256 _unrealizedPnl;
        uint numAmms = amms.length;
        for (uint i; i < numAmms; ++i) {
            if (amms[i].isOverSpreadLimit()) {
                (_notionalPosition, _unrealizedPnl) = amms[i].getOracleBasedPnl(trader, margin, mode);
            } else {
                (_notionalPosition, _unrealizedPnl,,) = amms[i].getNotionalPositionAndUnrealizedPnl(trader);
            }
            notionalPosition += _notionalPosition;
            unrealizedPnl += _unrealizedPnl;
        }
    }

    function getNotionalPositionAndMargin(address trader, bool includeFundingPayments, Mode mode)
        override
        public
        view
        returns(uint256 notionalPosition, int256 margin)
    {
        int256 unrealizedPnl;
        margin = marginAccount.getNormalizedMargin(trader);
        if (includeFundingPayments) {
            margin -= getTotalFunding(trader); // -ve fundingPayment means trader should receive funds
        }
        (notionalPosition, unrealizedPnl) = getTotalNotionalPositionAndUnrealizedPnl(trader, margin, mode);
        margin += unrealizedPnl;
    }

    function getAmmsLength() override public view returns(uint) {
        return amms.length;
    }

    function getAMMs() external view returns (IAMM[] memory) {
        return amms;
    }

    /* ****************** */
    /*   Test/UI Helpers  */
    /* ****************** */

    function isAboveMaintenanceMargin(address trader) override external view returns(bool) {
        return calcMarginFraction(trader, true, Mode.Maintenance_Margin) >= maintenanceMargin;
    }

    /**
    * @dev deprecated Use the nested call instead
    *   calcMarginFraction(trader, true, Mode.Min_Allowable_Margin)
    */
    function getMarginFraction(address trader) override external view returns(int256) {
        return calcMarginFraction(trader, true /* includeFundingPayments */, Mode.Min_Allowable_Margin);
    }

    /* ****************** */
    /*   Internal View    */
    /* ****************** */

    /**
    * @dev This method assumes that pending funding has been settled
    */
    function assertMarginRequirement(address trader) public view {
        require(
            calcMarginFraction(trader, false, Mode.Min_Allowable_Margin) >= minAllowableMargin,
            "CH: Below Minimum Allowable Margin"
        );
    }

    /**
    * @dev This method assumes that pending funding has been credited
    */
    function _assertLiquidationRequirement(address trader) internal view {
        require(calcMarginFraction(trader, false, Mode.Maintenance_Margin) < maintenanceMargin, "CH: Above Maintenance Margin");
    }

    function _calculateTradeFee(uint quoteAsset) internal view returns (uint) {
        return quoteAsset * tradeFee / PRECISION;
    }

    function _calculateLiquidationPenalty(uint quoteAsset) internal view returns (uint) {
        return quoteAsset * liquidationPenalty / PRECISION;
    }

    /* ****************** */
    /*        Pure        */
    /* ****************** */

    function _getMarginFraction(int256 accountValue, uint notionalPosition) private pure returns(int256) {
        if (notionalPosition == 0) {
            return type(int256).max;
        }
        return accountValue * PRECISION.toInt256() / notionalPosition.toInt256();
    }

    /* ****************** */
    /*     Governance     */
    /* ****************** */

    function whitelistAmm(address _amm) external onlyGovernance {
        uint l = amms.length;
        for (uint i; i < l; ++i) {
            require(address(amms[i]) != _amm, "ch.whitelistAmm.duplicate_amm");
        }
        emit MarketAdded(l, _amm);
        amms.push(IAMM(_amm));
        amms[l].putAmmInIgnition();
    }

    function setParams(
        int _maintenanceMargin,
        int _minAllowableMargin,
        uint _tradeFee,
        uint _liquidationPenality
    ) external onlyGovernance {
        tradeFee = _tradeFee;
        liquidationPenalty = _liquidationPenality;
        maintenanceMargin = _maintenanceMargin;
        minAllowableMargin = _minAllowableMargin;
    }
}
