// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

import { IClearingHouse, IMarginAccount, IJoeRouter02, IJoePair, IJoeFactory, IVUSD } from "../Interfaces.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";

contract BatchLiquidator is Ownable {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;
    using SafeCast for int256;

    struct JoeCallbackData {
        address trader;
        uint minProfit;
    }

    IClearingHouse public immutable clearingHouse;
    IMarginAccount public immutable  marginAccount;
    address public immutable vusd;
    IERC20 public immutable usdc;
    IERC20 public immutable wavax;
    IJoeRouter02 public immutable joeRouter;
    IJoeFactory public immutable joeFactory;
    address[] public path;

    constructor(
        IClearingHouse _clearingHouse,
        IMarginAccount _marginAccount,
        address _vusd,
        IERC20 _usdc,
        IERC20 _wavax,
        IJoeRouter02 _joeRouter,
        IJoeFactory _joeFactory
    ) {
        clearingHouse = _clearingHouse;
        marginAccount = _marginAccount;
        vusd = _vusd;
        usdc = _usdc;
        wavax = _wavax;
        joeRouter = _joeRouter;
        joeFactory = _joeFactory;

        address[] memory _path = new address[](2);
        _path[0] = address(wavax);
        _path[1] = address(usdc);
        path = _path;
        // infinite approval to save gas
        IERC20(vusd).safeApprove(address(marginAccount), type(uint).max);
        usdc.safeApprove(vusd, type(uint).max);
        wavax.safeApprove(address(joeRouter), type(uint).max);
    }

    function liquidate(address[] calldata traders) external {
        for (uint i; i < traders.length; i++) {
            clearingHouse.liquidate(traders[i]);
        }
    }

    function liquidateMakers(address[] calldata traders) external {
        for (uint i; i < traders.length; i++) {
            clearingHouse.liquidateMaker(traders[i]);
        }
    }

    function liquidateTakers(address[] calldata traders) external {
        for (uint i; i < traders.length; i++) {
            clearingHouse.liquidateTaker(traders[i]);
        }
    }

    /**
    * @notice Liquidate a margin account, assuming this contract has enough vusd
    */
    function liquidateAndSellAvax(address trader, uint repay, uint minUsdcOut) external {
        uint seizeAmount = marginAccount.liquidateExactRepay(trader, repay, 1, 0);

        // sell avax
        joeRouter.swapExactTokensForTokens(
            seizeAmount,
            minUsdcOut, // asserts minimum out amount
            path,
            address(this),
            block.timestamp
        );
    }

    /**
    * @notice Liquidate a margin account, assuming no funds in hand
    * @param minProfit minimum profit in avax
    * token0 -> wavax
    * token1 -> usdc
    */
    function flashLiquidateWithAvax(address trader, uint repay, uint minProfit) external {
        address pool = joeFactory.getPair(address(wavax), address(usdc));
        bytes memory data = abi.encode(JoeCallbackData(trader, minProfit));
        IJoePair(pool).swap(0, repay, address(this), data);
    }

    function withdraw(IERC20 token) external {
        token.safeTransfer(owner(), token.balanceOf(address(this)));
    }

    /**
    * @notice callback function for joe swap
    */
    function joeCall(
        address /* sender */,
        uint256 /* amount0 */,
        uint256 repay,
        bytes calldata data
    ) external {
        // verify callback
        address pool = joeFactory.getPair(address(wavax), address(usdc));
        require(msg.sender == pool, "BL: Invalid Callback");

        JoeCallbackData memory decoded = abi.decode(data, (JoeCallbackData));
        // deposit usdc to get vusd
        IVUSD(vusd).mintWithReserve(address(this), repay);
        // liquidate margin account
        uint seizeAmount = marginAccount.liquidateExactRepay(decoded.trader, repay, 1, 0);
        // return loan in avax
        uint[] memory amounts = joeRouter.getAmountsIn(repay, path);
        require(seizeAmount >= amounts[0] + decoded.minProfit, "BL: Insufficient seize amount");
        wavax.safeTransfer(pool, amounts[0]);
    }
}
