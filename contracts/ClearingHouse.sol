pragma solidity 0.8.4;

import "hardhat/console.sol";

contract ClearingHouse {

    int256 constant PRECISION = 1e6;

    int256 public maintenanceMargin;
    IMarginAccount public marginAccount;
    IAMM[] public amms;

    constructor(IMarginAccount _marginAccount, int256 _maintenanceMargin) {
        marginAccount = _marginAccount;
        maintenanceMargin = _maintenanceMargin;
    }

    function openPosition(uint idx, int256 baseAssetQuantity, int quoteAssetLimit) external {
        address trader = msg.sender;
        updatePositions(trader);
        (int realizedPnl, bool isPositionIncreased) = amms[idx].openPosition(trader, baseAssetQuantity, quoteAssetLimit);
        if (realizedPnl != 0) {
            marginAccount.realizePnL(trader, realizedPnl);
        }
        if (isPositionIncreased) {
            require(isAboveMaintenanceMargin(trader), "CH: Below Maintenance Margin");
        }
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
        marginAccount.realizePnL(trader, -fundingPayment / 1e12);
    }

    function isAboveMaintenanceMargin(address trader) public view returns(bool) {
        return getMarginFraction(trader) >= maintenanceMargin;
    }

    function getMarginFraction(address trader) public view returns(int256) {
        int256 margin = marginAccount.getNormalizedMargin(trader);
        (int256 notionalPosition, int256 unrealizedPnl) = getTotalNotionalPositionAndUnrealizedPnl(trader);
        int256 accountValue = int256(margin) + unrealizedPnl;
        if (notionalPosition == 0) {
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

    /* Governance */
    function whitelistAmm(address _amm) public {
        amms.push(IAMM(_amm));
    }
}

interface IAMM {
    function openPosition(address trader, int256 baseAssetQuantity, int quoteAssetLimit) external returns (int realizedPnl, bool isPositionIncreased);
    function getUnrealizedPnL(address trade) external returns(int256);
    function getNotionalPositionAndUnrealizedPnl(address trader)
        external
        view
        returns(int256 notionalPosition, int256 unrealizedPnl);
    function updatePosition(address trader) external returns(int256 fundingPayment);
}

interface IMarginAccount {
    function getNormalizedMargin(address trader) external view returns(int256);
    function realizePnL(address trader, int256 realizedPnl) external;
}
