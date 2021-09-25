// SPDX-License-Identifier: MIT

pragma solidity 0.8.4;

import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import { VUSD } from "./VUSD.sol";
import "./Interfaces.sol";

import "hardhat/console.sol";

contract ClearingHouse {
    using SafeCast for uint256;
    using SafeCast for int256;

    uint256 constant PRECISION = 1e6;

    uint256 public maintenanceMargin;
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
        uint256 precision;
    }

    struct Position {
        int256 size;
        uint256 openNotional;
        int256 unrealizedPnl;
        uint256 avgOpen;
    }

    event PositionOpened(address indexed trader, uint indexed idx, int256 indexed baseAssetQuantity, uint quoteAsset);

    constructor(
        address _insuranceFund,
        address _marginAccount,
        address _vusd,
        uint256 _maintenanceMargin,
        uint _tradeFee,
        uint _liquidationPenalty
    ) {
        insuranceFund = IInsuranceFund(_insuranceFund);
        marginAccount = IMarginAccount(_marginAccount);
        vusd = VUSD(_vusd);

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
        _openPosition(msg.sender, idx, baseAssetQuantity, quoteAssetLimit);
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
        emit PositionOpened(trader, idx, baseAssetQuantity, quoteAsset);
    }

    function updatePositions(address trader) public {
        int256 fundingPayment;
        for (uint i = 0; i < amms.length; i++) {
            fundingPayment += amms[i].updatePosition(trader);
        }
        // -ve fundingPayment means trader should receive funds
        // console.log("fundingPayment");
        // console.logInt(fundingPayment);
        // console.logInt(-fundingPayment / 1e12);
        // @todo should only receive this if user doesn't have bad debt
        // and/or open positions that make the user position insolvent
        marginAccount.realizePnL(trader, -fundingPayment);
    }

    function settleFunding() external {
        int256 premiumFraction;
        int256 longMinusShortOpenInterestNotional;
        int256 precision;
        int256 insurancePnL;
        for (uint i = 0; i < amms.length; i++) {
            (premiumFraction, longMinusShortOpenInterestNotional, precision) = amms[i].settleFunding();
            // if premiumFraction > 0, longs pay shorts, extra shorts are paid for by insurance fund
            // if premiumFraction < 0, shorts pay longs, extra longs are paid for by insurance fund
            insurancePnL += premiumFraction * longMinusShortOpenInterestNotional / precision;
        }
        if (insurancePnL > 0) {
            vusd.mint(address(insuranceFund), insurancePnL.toUint256());
        } else if (insurancePnL < 0) {
            insuranceFund.seizeBadDebt((-insurancePnL).toUint256());
        }
    }

    function liquidate(address trader) external {
        require(!isAboveMaintenanceMargin(trader), "Above Maintenance Margin");
        int realizedPnl;
        uint quoteAsset;
        for (uint i = 0; i < amms.length; i++) { // liquidate all positions
            (int _realizedPnl, uint _quoteAsset) = amms[i].closePosition(trader);
            realizedPnl += _realizedPnl;
            quoteAsset += _quoteAsset;
        }
        // extra liquidation penalty
        uint _liquidationFee = _chargeFeeAndRealizePnL(trader, realizedPnl, quoteAsset, true /* isLiquidation */);
        uint _toInsurance = _liquidationFee / 2;
        vusd.mint(address(insuranceFund), _toInsurance);
        vusd.mint(msg.sender, _liquidationFee - _toInsurance);
    }

    function _chargeFeeAndRealizePnL(
        address trader, int realizedPnl, uint quoteAsset, bool isLiquidation)
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

    function getMarginFraction(address trader) public view returns(uint256) {
        int256 margin = marginAccount.getNormalizedMargin(trader);
        (uint256 notionalPosition, int256 unrealizedPnl) = getTotalNotionalPositionAndUnrealizedPnl(trader);
        int256 accountValue = margin + unrealizedPnl;
        if (accountValue <= 0) {
            return 0;
        }
        if (accountValue > 0 && notionalPosition == 0) {
            return type(uint256).max;
        }
        return accountValue.toUint256() * PRECISION / notionalPosition;
    }

    function getTotalNotionalPositionAndUnrealizedPnl(address trader)
        public
        view
        returns(uint256 notionalPosition, int256 unrealizedPnl)
    {
        uint256 _notionalPosition;
        int256 _unrealizedPnl;
        for (uint i = 0; i < amms.length; i++) {
            (_notionalPosition, _unrealizedPnl) = amms[i].getNotionalPositionAndUnrealizedPnl(trader);
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
                (,positions[i].unrealizedPnl) = amms[i].getNotionalPositionAndUnrealizedPnl(trader);
                positions[i].avgOpen = positions[i].openNotional * amms[i].precision().toUint256() / abs(positions[i].size).toUint256();
            }
        }
    }

    function markets() external view returns(MarketInfo[] memory _markets) {
        uint l = amms.length;
        _markets = new MarketInfo[](l);
        for (uint i = 0; i < l; i++) {
            _markets[i] = MarketInfo(address(amms[i]), amms[i].underlyingAsset(), amms[i].precision().toUint256());
        }
    }

    // Internal View

    function _calculateTradeFee(uint quoteAsset) internal view returns (uint) {
        return quoteAsset * tradeFee / PRECISION;
    }

    function _calculateLiquidationPenalty(uint quoteAsset) internal view returns (uint) {
        return quoteAsset * liquidationPenalty / PRECISION;
    }

    // Pure

    function abs(int x) private pure returns (int) {
        return x >= 0 ? x : -x;
    }

    // Governance

    function whitelistAmm(address _amm) public /* @todo onlyOwner */ {
        amms.push(IAMM(_amm));
    }
}
