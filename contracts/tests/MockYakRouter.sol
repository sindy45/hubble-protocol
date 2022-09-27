// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IYakRouter } from '../Interfaces.sol';

contract MockYakRouter {
    function swapNoSplit(IYakRouter.Trade calldata trade, address to, uint) external {
        IERC20(trade.path[0]).transferFrom(msg.sender, address(this), trade.amountIn);
        address outToken = trade.path[trade.path.length - 1];
        IERC20(outToken).transfer(to, trade.amountOut);
    }
}
