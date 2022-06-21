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
        IJoeRouter02 _joeRouter
    ) {
        clearingHouse = _clearingHouse;
        marginAccount = _marginAccount;
        vusd = _vusd;
        usdc = _usdc;
        wavax = _wavax;
        joeRouter = _joeRouter;
        joeFactory = IJoeFactory(_joeRouter.factory());

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

    function liquidateMarginAccount(address trader, uint debt) external {
        uint vusdBal = IVUSD(vusd).balanceOf(address(this));
        uint usdcBal = usdc.balanceOf(address(this));
        // do we have enough vusd?
        if (vusdBal >= debt) {
            liquidateAndSellAvax(trader, debt, 0);
        } else if (vusdBal + usdcBal >= debt) {
            IVUSD(vusd).mintWithReserve(address(this), debt - vusdBal);
            liquidateAndSellAvax(trader, debt, 0);
        } else {
            flashLiquidateWithAvax(trader, debt, 0);
        }
    }

    /**
    * @notice Liquidate a margin account, assuming this contract has enough vusd
    */
    function liquidateAndSellAvax(address trader, uint repay, uint minProfit) public {
        uint seizeAmount = wavax.balanceOf(address(this));
        marginAccount.liquidateExactRepay(trader, repay, 1, 0);
        seizeAmount = wavax.balanceOf(address(this)) - seizeAmount;

        // sell avax
        joeRouter.swapExactTokensForTokens(
            seizeAmount,
            repay + minProfit, // asserts minimum out amount
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
    function flashLiquidateWithAvax(address trader, uint repay, uint minProfit) public {
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
        uint[] memory amounts = joeRouter.getAmountsIn(repay, path);
        marginAccount.liquidateExactRepay(decoded.trader, repay, 1, amounts[0] + decoded.minProfit);

        // return loan in avax
        wavax.safeTransfer(pool, amounts[0]);
    }
}
