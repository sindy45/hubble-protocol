// SPDX-License-Identifier: MIT

pragma solidity 0.8.4;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Initializable } from "@openzeppelin/contracts/proxy/utils/Initializable.sol";

import { VUSD } from "./VUSD.sol";
import "./Interfaces.sol";
import "hardhat/console.sol";

contract MarginAccount is Ownable, Initializable {
    using SafeERC20 for IERC20;

    IClearingHouse public clearingHouse;
    IOracle public oracle;
    IInsuranceFund public insuranceFund;
    VUSD public vusd;

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

    event MarginAdded(address trader, uint idx, uint amount);

    modifier onlyClearingHouse() {
        require(msg.sender == address(clearingHouse), "Only clearingHouse");
        _;
    }

    function initialize(address _registry) external initializer {
        IRegistry registry = IRegistry(_registry);
        syncDeps(registry);
        _addCollateral(address(vusd), PRECISION); // weight = 1 * PRECISION
    }

    // Add Margin functions

    function addMargin(uint idx, uint amount) external {
        addMarginFor(idx, amount, msg.sender);
    }

    function addMarginFor(uint idx, uint amount, address to) public {
        require(amount > 0, "Add non-zero margin");
        // will revert for idx >= supportedCollateral.length
        supportedCollateral[idx].token.safeTransferFrom(msg.sender, address(this), amount);
        margin[idx][to] += int(amount);
        emit MarginAdded(to, idx, amount);
    }

    function removeMargin(uint idx, uint256 amount) external {
        address trader = msg.sender;
        clearingHouse.updatePositions(trader);
        require(margin[VUSD_IDX][trader] >= 0, "Cannot remove margin when vusd balance is negative");
        // uint -> int typecast might be unsafe. @todo fix it
        require(margin[idx][trader] >= int(amount), "Insufficient balance");
        margin[idx][trader] -= int(amount);
        require(clearingHouse.isAboveMaintenanceMargin(trader), "CH: Below Maintenance Margin");
        if (idx == VUSD_IDX) {
            uint bal = vusd.balanceOf(address(this));
            if (bal < amount) {
                // Say there are 2 traders, Alice and Bob.
                // Alice has a profitable position and realizes their PnL in form of vusd margin.
                // But bob has not yet realized their -ve PnL.
                // In that case we'll take a credit from vusd contract, which will eventually be returned when Bob pays their debt back.
                vusd.mint(address(this), amount - bal);
            }
        }
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
        margin[VUSD_IDX][trader] += int(repayAmount);
        int priceCollateral = oracle.getUnderlyingPrice(address(supportedCollateral[collateralIdx].token));
        uint seizeAmount = repayAmount * liquidationIncentive / uint(priceCollateral);

        require(int(seizeAmount) <= margin[collateralIdx][trader], "Seizing more than possible");
        margin[collateralIdx][trader] -= int(seizeAmount);
        supportedCollateral[collateralIdx].token.safeTransfer(msg.sender, seizeAmount);
    }

    function settleBadDebt(address trader) external {
        (int256 notionalPosition,) = clearingHouse.getTotalNotionalPositionAndUnrealizedPnl(trader);
        require(notionalPosition == 0, "Liquidate positions before settling bad debt");
        require(getSpotCollateralValue(trader) < 0, "Above bad debt threshold");
        int vusdBal = margin[VUSD_IDX][trader];
        require(vusdBal < 0, "Nothing to repay");

        Collateral[] memory assets = supportedCollateral;

        insuranceFund.seizeBadDebt(uint(-vusdBal));
        margin[VUSD_IDX][trader] = 0;

        for (uint i = 1 /* skip vusd */; i < assets.length; i++) {
            int amount = margin[i][trader];
            if (amount > 0) {
                margin[i][trader] = 0;
                assets[i].token.safeTransfer(address(insuranceFund), uint(amount));
            }
        }
    }

    // View

    function getSpotCollateralValue(address trader) public view returns(int256) {
        return _collateralValue(trader, false);
    }

    function getNormalizedMargin(address trader) public view returns(int256) {
        return _collateralValue(trader, true);
    }

    function _collateralValue(address trader, bool weighted) internal view returns (int256 normMargin) {
        Collateral[] memory assets = supportedCollateral;
        Collateral memory _collateral;

        for (uint i = 0; i < assets.length; i++) {
            _collateral = assets[i];

            int numerator = margin[i][trader] * oracle.getUnderlyingPrice(address(assets[i].token));
            uint denomDecimals = _collateral.decimals;
            if (weighted) {
                numerator *= int(_collateral.weight);
                denomDecimals += 6;
            }
            int _margin = numerator / int(10 ** denomDecimals);
            normMargin += _margin;
        }
    }

    // Privileged

    function syncDeps(IRegistry registry) public onlyOwner {
        clearingHouse = IClearingHouse(registry.clearingHouse());
        oracle = IOracle(registry.oracle());
        insuranceFund = IInsuranceFund(registry.insuranceFund());
        vusd = VUSD(registry.vusd());
    }

    // @todo rename to whitelistCollateral
    function addCollateral(address _coin, uint _weight) external onlyOwner {
        _addCollateral(_coin, _weight);
    }

    // @todo function to change weight of an asset

    // Internal

    function _addCollateral(address _coin, uint _weight) internal {
        require(_weight <= PRECISION, "weight > 1e6");

        Collateral[] memory _collaterals = supportedCollateral;
        for (uint i = 0; i < _collaterals.length; i++) {
            require(address(_collaterals[i].token) != _coin, "collateral exists");
        }
        supportedCollateral.push(
            Collateral({
                token: IERC20(_coin),
                weight: _weight,
                decimals: ERC20Detailed(_coin).decimals() // will fail if .decimals() is not defined on the contract
            })
        );
    }
}
