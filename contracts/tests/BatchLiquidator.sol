// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import { IClearingHouse, IMarginAccount, IJoeRouter02, IJoePair, IJoeFactory, IVUSD, IInsuranceFund } from "../Interfaces.sol";
import { Executor } from "./Executor.sol";

contract BatchLiquidator is Executor {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;
    using SafeCast for int256;

    uint constant WAVAX_IDX = 1;

    enum ActionType { Liquidation, IF_AUCTION }
    struct JoeCallbackData {
        address trader;
        uint idx; // idx of the collateral being seized as in marginAccount.supportedCollateral
        uint minProfit; // denominated in the seized asset
        uint purchase; // used only in IF seize
        ActionType actionType;
    }

    IClearingHouse public immutable clearingHouse;
    IMarginAccount public immutable  marginAccount;
    IInsuranceFund public insuranceFund;
    address public immutable vusd;
    IERC20 public immutable usdc;
    IERC20 public immutable wavax;
    IJoeRouter02 public immutable joeRouter;
    IJoeFactory public immutable joeFactory;
    address public immutable wavax_usdc_pool;
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
        insuranceFund = clearingHouse.insuranceFund();

        address[] memory _path = new address[](2);
        _path[0] = address(wavax);
        _path[1] = address(usdc);
        path = _path;

        // infinite approval to save gas
        IERC20(vusd).safeApprove(address(marginAccount), type(uint).max);
        IERC20(vusd).safeApprove(address(insuranceFund), type(uint).max);
        usdc.safeApprove(vusd, type(uint).max);
        wavax_usdc_pool = joeFactory.getPair(address(wavax), address(usdc));
    }

    function liquidate(address[] calldata traders) external {
        for (uint i; i < traders.length; i++) {
            clearingHouse.liquidate(traders[i]);
        }
    }

    function liquidateTakers(address[] calldata traders) external {
        for (uint i; i < traders.length; i++) {
            clearingHouse.liquidateTaker(traders[i]);
        }
    }

    function liquidateMulti(address trader, uint[] calldata repay, uint[] calldata idx, uint[] calldata minProfit) external {
        uint len = repay.length;
        require(idx.length == len && minProfit.length == len, "BL: Invalid data");
        for (uint i = 0; i < len; i++) {
            liquidateMarginAccount(trader, repay[i], idx[i], minProfit[i]);
        }
    }

    function liquidateMarginAccount(address trader, uint repay, uint idx, uint minProfit) public {
        uint vusdBal = IVUSD(vusd).balanceOf(address(this));
        uint usdcBal = usdc.balanceOf(address(this));
        // do we have enough vusd?
        if (vusdBal >= repay) {
            liquidateAndSell(trader, repay, idx, minProfit);
        } else if (vusdBal + usdcBal >= repay) {
            IVUSD(vusd).mintWithReserve(address(this), repay - vusdBal);
            liquidateAndSell(trader, repay, idx, minProfit);
        } else {
            flashLiquidate(trader, repay, idx, minProfit);
        }
    }

    /**
    * @notice Liquidate a margin account, assuming this contract has enough vusd
    * @param minProfit minimum profit in usdc
    */
    function liquidateAndSell(address trader, uint repay, uint idx, uint minProfit) public {
        IERC20 asset = IERC20(_idxToCollateral(idx));
        uint seizeAmount = asset.balanceOf(address(this));
        marginAccount.liquidateExactRepay(trader, repay, idx, 0);
        seizeAmount = asset.balanceOf(address(this)) - seizeAmount;

        address[] memory _path;
        if (idx == WAVAX_IDX) {
            _path = new address[](2);
            _path[0] = address(wavax);
            _path[1] = address(usdc);
        } else {
            _path = new address[](3);
            _path[0] = address(asset);
            _path[1] = address(wavax);
            _path[2] = address(usdc);
        }

        // sell asset
        uint amountInMax = seizeAmount - minProfit;
        IERC20(asset).safeApprove(address(joeRouter), 0);
        IERC20(asset).safeApprove(address(joeRouter), amountInMax);
        joeRouter.swapTokensForExactTokens(
            repay,
            amountInMax,
            _path,
            address(this),
            block.timestamp
        );
    }

    /**
    * @notice Liquidate a margin account, assuming no funds in hand
    * @param trader Trader whose margin account is being liquidated
    * @param repay Exact debt being repaid
    * @param idx Index of the collateral being seized
    * @param minProfit minimum profit, denominated in collateral being seized
    */
    function flashLiquidate(address trader, uint repay, uint idx, uint minProfit) public {
        bytes memory data = abi.encode(JoeCallbackData(trader, idx, minProfit, 0 /* unutilized */, ActionType.Liquidation));
        IJoePair(wavax_usdc_pool).swap(0, repay, address(this), data);
    }

    /**
    * @notice Arb insurance fund auction
    */
    function arbIFAuction(uint assetIdx, uint purchase, uint minProfit) external {
        uint repay = insuranceFund.calcVusdAmountForAuction(_idxToCollateral(assetIdx), purchase);
        bytes memory data = abi.encode(JoeCallbackData(address(0), assetIdx, minProfit, purchase, ActionType.IF_AUCTION));
        IJoePair(wavax_usdc_pool).swap(0, repay, address(this), data);
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
        require(msg.sender == wavax_usdc_pool, "BL: Invalid Callback");

        JoeCallbackData memory decoded = abi.decode(data, (JoeCallbackData));

        address asset = _idxToCollateral(decoded.idx);
        uint seized = IERC20(asset).balanceOf(address(this));

        uint[] memory amounts = joeRouter.getAmountsIn(repay, path); // amount[0] = wavax amount to return
        if (decoded.actionType == ActionType.Liquidation) {
            IVUSD(vusd).mintWithReserve(address(this), repay);
            marginAccount.liquidateExactRepay(decoded.trader, repay, decoded.idx, 0 /* minSeizeAmount */);
        } else if (decoded.actionType == ActionType.IF_AUCTION) {
            IVUSD(vusd).mintWithReserve(address(this), repay);
            insuranceFund.buyCollateralFromAuction(asset, decoded.purchase);
        }
        seized = IERC20(asset).balanceOf(address(this)) - seized;

        if (decoded.idx != WAVAX_IDX) {
            _exchangeForAvax(asset, seized - decoded.minProfit, amounts[0]);
        } else {
            require(amounts[0] <= seized - decoded.minProfit, "BL: not profitable");
        }
        wavax.safeTransfer(wavax_usdc_pool, amounts[0]);
    }

    function _exchangeForAvax(address asset, uint amountInMax, uint wavaxAmount) internal {
        // sell asset for avax
        address[] memory _path = new address[](2);
        _path[0] = asset;
        _path[1] = address(wavax);

        IERC20(asset).safeApprove(address(joeRouter), 0);
        IERC20(asset).safeApprove(address(joeRouter), amountInMax);
        joeRouter.swapTokensForExactTokens(
            wavaxAmount, // amountOut
            amountInMax, // amountInMax
            _path,
            address(this),
            block.timestamp
        );
    }

    function _idxToCollateral(uint idx) internal view returns(address) {
        return address(marginAccount.supportedAssets()[idx].token);
    }
}
