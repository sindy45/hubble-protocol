// SPDX-License-Identifier: MIT

pragma solidity 0.8.4;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { IOracle } from "./Interfaces.sol";

import "./VUSD.sol";
import "hardhat/console.sol";

contract MarginAccount is Ownable {
    using SafeERC20 for IERC20;

    IClearingHouse public clearingHouse;
    IOracle public oracle;

    struct Collateral {
        IERC20 token;
        uint weight;
        uint8 decimals;
    }
    Collateral[] public supportedCollateral;

    uint constant VUSD_IDX = 0;
    uint constant PRECISION = 1e6;

    uint public liquidationIncentive = 1.08e18; // scaled 18 decimals

    // supportedCollateral index => trader => balance
    mapping(uint => mapping(address => int)) public margin;

    modifier onlyClearingHouse() {
        require(msg.sender == address(clearingHouse), "Only clearingHouse");
        _;
    }

    constructor(address _vusd, address _oracle) {
        _addCollateral(_vusd, PRECISION); // weight = 1 * PRECISION
        oracle = IOracle(_oracle);
    }

    // Add Margin functions
    function addMarginFor(uint idx, uint amount, address to) external {
        supportedCollateral[idx].token.safeTransferFrom(msg.sender, address(this), amount);
        margin[idx][to] += int(amount);
    }

    function addMargin(uint idx, uint amount) external {
        supportedCollateral[idx].token.safeTransferFrom(msg.sender, address(this), amount);
        margin[idx][msg.sender] += int(amount);
    }

    function removeMargin(uint idx, uint256 amount) external {
        address trader = msg.sender;
        clearingHouse.updatePositions(trader);
        require(margin[VUSD_IDX][trader] >= 0, "Cannot remove margin when vusd balance is negative");
        // uint -> int typecast might be unsafe. @todo fix it
        require(margin[idx][trader] >= int(amount), "Insufficient balance");
        margin[idx][trader] -= int(amount);
        require(clearingHouse.isAboveMaintenanceMargin(trader), "CH: Below Maintenance Margin");
        supportedCollateral[idx].token.safeTransfer(trader, amount);
    }

    function realizePnL(address trader, int256 realizedPnl) onlyClearingHouse external {
        // -ve PnL will reduce balance
        margin[VUSD_IDX][trader] += realizedPnl;
    }

    function liquidate(address trader, uint repayAmount, uint collateralIdx) external {
        (int256 notionalPosition,) = clearingHouse.getTotalNotionalPositionAndUnrealizedPnl(trader);
        require(notionalPosition == 0, "Liquidate positions before liquidating margin account");
        require(getNormalizedMargin(trader) < 0, "Above liquidation threshold");
        int vusdBal = margin[VUSD_IDX][trader];
        require(vusdBal < 0, "Nothing to repay");
        require(-vusdBal >= int(repayAmount), "repaying too much"); // @todo partial liquidation?

        supportedCollateral[VUSD_IDX].token.safeTransferFrom(msg.sender, address(this), repayAmount);
        margin[VUSD_IDX][trader] -= int(repayAmount);
        int priceCollateral = oracle.getUnderlyingPrice(address(supportedCollateral[collateralIdx].token));
        uint seizeAmount = repayAmount * liquidationIncentive / uint(priceCollateral);

        require(int(seizeAmount) <= margin[collateralIdx][trader], "Seizing more than possible");
        margin[collateralIdx][trader] -= int(seizeAmount);
        supportedCollateral[collateralIdx].token.safeTransfer(msg.sender, seizeAmount);
    }

    // View

    function getNormalizedMargin(address trader) public view returns(int256 normMargin) {
        Collateral[] memory assets = supportedCollateral;
        for (uint i = 0; i < assets.length; i++) {
            Collateral memory _collateral = assets[i];
            int numerator = margin[i][trader] * int(_collateral.weight) * oracle.getUnderlyingPrice(address(assets[i].token));
            uint denom = (10 ** _collateral.decimals) * 1e6;
            int _margin = numerator / int(denom);
            normMargin += _margin;
        }
    }

    // Privileged

    function setClearingHouse(IClearingHouse _clearingHouse) external onlyOwner {
        clearingHouse = _clearingHouse;
    }

    function addCollateral(address _coin, uint _weight) external onlyOwner {
        _addCollateral(_coin, _weight);
    }

    // Internal

    function _addCollateral(address _coin, uint _weight) internal {
        Collateral[] memory _collaterals = supportedCollateral;
        for (uint i = 0; i < _collaterals.length; i++) {
            require(address(_collaterals[i].token) != _coin, "collateral exists");
        }
        supportedCollateral.push(
            Collateral({
                token: IERC20(_coin),
                weight: _weight,
                decimals: ERC20Detailed(_coin).decimals()
            })
        );
    }
}

interface IClearingHouse {
    function getTotalNotionalPositionAndUnrealizedPnl(address trader)
        external
        view
        returns(int256 notionalPosition, int256 unrealizedPnl);
    function isAboveMaintenanceMargin(address trader) external view returns(bool);
    function updatePositions(address trader) external;
}

interface ERC20Detailed {
    function decimals() external view returns (uint8);
}
