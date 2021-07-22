pragma solidity 0.8.4;

contract ClearingHouse {

    int256 constant PRECISION = 1e8;

    int public maintenanceMargin;
    IMarginAccount public marginAccount;
    IAMM[] public amms;

    function openPosition(IAMM amm, int256 baseAssetQuantity, int quoteAssetLimit) external {
        address trader = msg.sender;
        amm.openPosition(trader, baseAssetQuantity, quoteAssetLimit);
        verifyMaintenanceMargin(trader);
    }

    function verifyMaintenanceMargin(address trader) public view {
        require(getMarginFraction(trader) >= maintenanceMargin, "CH: Below Maintenance Margin");
    }

    function getMarginFraction(address trader) public view returns(int256) {
        int256 margin = marginAccount.getNormalizedMargin(trader);
        (int256 notionalPosition, int256 unrealizedPnl) = getTotalNotionalPositionAndUnrealizedPnl(trader);
        int256 accountValue = int256(margin) + unrealizedPnl;
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
}

interface IAMM {
    function openPosition(address trader, int256 baseAssetQuantity, int quoteAssetLimit) external returns (uint notionalMargin);
    function getUnrealizedPnL(address trade) external returns(int256);
    function getNotionalPositionAndUnrealizedPnl(address trader)
        external
        view
        returns(int256 notionalPosition, int256 unrealizedPnl);
}

interface IMarginAccount {
    function getNormalizedMargin(address trader) external view returns(int256);
    function realizePnL(address trader, int256 realizedPnl) external;
}
