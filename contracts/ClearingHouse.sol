// SPDX-License-Identifier: MIT

pragma solidity 0.8.4;

import { VUSD } from "./VUSD.sol";
import "hardhat/console.sol";

contract ClearingHouse {

    int256 constant PRECISION = 1e6;

    int256 public maintenanceMargin;
    uint public tradeFee;
    uint public liquidationPenalty;

    VUSD public vusd;
    address public insuranceFund = address(0x1);
    IMarginAccount public marginAccount;
    IAMM[] public amms;

    event PositionOpened(uint indexed idx, int256 indexed baseAssetQuantity, uint indexed quoteAsset);

    constructor(IMarginAccount _marginAccount, int256 _maintenanceMargin, uint _tradeFee, uint _liquidationPenalty, address _vusd) {
        marginAccount = _marginAccount;
        maintenanceMargin = _maintenanceMargin;
        tradeFee = _tradeFee;
        liquidationPenalty = _liquidationPenalty;
        vusd = VUSD(_vusd);
    }

    function openPosition(uint idx, int256 baseAssetQuantity, uint quoteAssetLimit) external {
        _openPosition(msg.sender, idx, baseAssetQuantity, quoteAssetLimit);
    }

    function _openPosition(address trader, uint idx, int256 baseAssetQuantity, uint quoteAssetLimit) internal {
        require(baseAssetQuantity != 0, "CH: baseAssetQuantity == 0");
        updatePositions(trader);
        (int realizedPnl, uint quoteAsset, bool isPositionIncreased) = amms[idx].openPosition(trader, baseAssetQuantity, quoteAssetLimit);
        uint _tradeFee = _chargeFeeAndRealizePnL(trader, realizedPnl, quoteAsset, false /* isLiquidation */);
        vusd.mint(insuranceFund, _tradeFee);
        // @todo credit trading fee to insurance fund
        if (isPositionIncreased) {
            require(isAboveMaintenanceMargin(trader), "CH: Below Maintenance Margin");
        }
        emit PositionOpened(idx, baseAssetQuantity, quoteAsset);
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
        vusd.mint(insuranceFund, _toInsurance);
        vusd.mint(msg.sender, _liquidationFee - _toInsurance);
    }

    function _chargeFeeAndRealizePnL(address trader, int realizedPnl, uint quoteAsset, bool isLiquidation) internal returns (uint fee) {
        fee = isLiquidation ? _calculateLiquidationPenalty(quoteAsset) : _calculateTradeFee(quoteAsset);
        int256 marginCharge = realizedPnl - int(fee);
        if (marginCharge != 0) {
            marginAccount.realizePnL(trader, marginCharge);
        }
    }

    // View

    function isAboveMaintenanceMargin(address trader) public view returns(bool) {
        return getMarginFraction(trader) >= maintenanceMargin;
    }

    function getMarginFraction(address trader) public view returns(int256) {
        int256 margin = marginAccount.getNormalizedMargin(trader);
        (int256 notionalPosition, int256 unrealizedPnl) = getTotalNotionalPositionAndUnrealizedPnl(trader);
        int256 accountValue = margin + unrealizedPnl;
        if (accountValue <= 0) {
            return 0;
        }
        if (accountValue > 0 && notionalPosition == 0) {
            return type(int256).max;
        }
        return accountValue * PRECISION / notionalPosition;
    }

    function getTotalNotionalPositionAndUnrealizedPnl(address trader)
        public
        view
        returns(int256 notionalPosition, int256 unrealizedPnl)
    {
        for (uint i = 0; i < amms.length; i++) {
            (int256 _notionalPosition, int256 _unrealizedPnl) = amms[i].getNotionalPositionAndUnrealizedPnl(trader);
            notionalPosition += _notionalPosition;
            unrealizedPnl += _unrealizedPnl;
        }
    }

    function markets() external view returns(address[] memory _amms) {
        uint length = amms.length;
        _amms = new address[](length);
        for (uint i = 0; i < length; i++) {
            _amms[i] = address(amms[i]);
        }
    }

    // Internal View

    function _calculateTradeFee(uint quoteAsset) internal view returns (uint) {
        return quoteAsset * tradeFee / uint(PRECISION);
    }

    function _calculateLiquidationPenalty(uint quoteAsset) internal view returns (uint) {
        return quoteAsset * liquidationPenalty / uint(PRECISION);
    }

    // Governance

    function whitelistAmm(address _amm) public /* @todo onlyOwner */ {
        amms.push(IAMM(_amm));
    }
}

interface IAMM {
    function openPosition(address trader, int256 baseAssetQuantity, uint quoteAssetLimit)
        external
        returns (int realizedPnl, uint quoteAsset, bool isPositionIncreased);
    function getUnrealizedPnL(address trade) external returns(int256);
    function getNotionalPositionAndUnrealizedPnl(address trader)
        external
        view
        returns(int256 notionalPosition, int256 unrealizedPnl);
    function updatePosition(address trader) external returns(int256 fundingPayment);
    function closePosition(address trader) external returns (int realizedPnl, uint quoteAsset);
}

interface IMarginAccount {
    function getNormalizedMargin(address trader) external view returns(int256);
    function realizePnL(address trader, int256 realizedPnl) external;
}
