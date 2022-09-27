// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {
    IMarginAccount,
    IClearingHouse,
    IVUSD,
    IERC20,
    IRegistry,
    IYakRouter
} from "./Interfaces.sol";

/**
* @title This contract is used for creating stratageies with deposited collateral
*/
contract PortfolioManager {
    using SafeERC20 for IERC20;

    uint constant VUSD_IDX = 0;

    IMarginAccount public marginAccount;
    IClearingHouse public clearingHouse;
    IVUSD public vusd;
    IERC20 public reserveToken;
    IYakRouter public yakRouter;

    constructor(address _registry, address _yakRouter) {
        IRegistry registry = IRegistry(_registry);
        marginAccount = IMarginAccount(registry.marginAccount());
        clearingHouse = IClearingHouse(registry.clearingHouse());
        vusd = IVUSD(registry.vusd());
        yakRouter = IYakRouter(_yakRouter);
        reserveToken = IERC20(vusd.reserveToken());
        // infinite approvals
        reserveToken.safeApprove(address(vusd), type(uint).max);
    }

    /**
    * @notice Swap collateral
    * @param removeIdx index of collateral to sell
    * @param addIdx index of collateral to buy
    */
    function swapCollateral(uint removeIdx, uint addIdx, IYakRouter.Trade calldata _trade) external {
        address trader = msg.sender;
        IMarginAccount.Collateral[] memory assets =  marginAccount.supportedAssets();
        require(
            address(assets[removeIdx].token) == _trade.path[0] ||
            (removeIdx == VUSD_IDX && _trade.path[0] == address(reserveToken)),
            'PM: Invalid input token'
        );
        require(
            address(assets[addIdx].token) == _trade.path[_trade.path.length - 1] ||
            (addIdx == VUSD_IDX && _trade.path[_trade.path.length - 1] == address(reserveToken)),
            'PM: Invalid output token'
        );
        // this is not required as we are checking margin requirement at the end
        // int256 vusdMargin = marginAccount.margin(VUSD_IDX, trader);
        // require(vusdMargin >= 0 || addIdx == VUSD_IDX, 'PM: Settle USD debt first');

        // remove margin
        marginAccount.removeMarginFor(trader, removeIdx, _trade.amountIn);
        if (removeIdx == VUSD_IDX) {
            vusd.withdraw(_trade.amountIn);
            vusd.processWithdrawals(); // swap will revert if withdrawal not processed
        }

        // swap
        IERC20 tokenOut = IERC20(_trade.path[_trade.path.length - 1]);
        uint addAmount = tokenOut.balanceOf(address(this));

        _approveAmount(_trade.path[0], address(yakRouter), _trade.amountIn);
        yakRouter.swapNoSplit(_trade, address(this), 0);

        addAmount = tokenOut.balanceOf(address(this)) - addAmount;
        if (addIdx == VUSD_IDX) {
            vusd.mintWithReserve(address(this), addAmount);
        }

        // add margin
        _approveAmount(address(assets[addIdx].token), address(marginAccount), addAmount);
        marginAccount.addMarginFor(addIdx, addAmount, trader);
        // Check minimum margin requirement after swap
        clearingHouse.assertMarginRequirement(trader);
    }

    function _approveAmount(address token, address spender, uint amount) internal {
        IERC20(token).safeApprove(spender, 0);
        IERC20(token).safeApprove(spender, amount);
    }
}
