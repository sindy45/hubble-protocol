// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { VUSD } from "./VUSD.sol";
import { IMarginAccount, IInsuranceFund, IVUSD, IRegistry } from "./Interfaces.sol";
import { HubbleBase } from "./legos/HubbleBase.sol";
import { IHGT } from "./layer0/HGT.sol";

/**
 * @title Helper contract for (un)wrapping tokens (vusd) before/after deposting/withdrawing from margin account/insurance fund
 * @notice USDC is both the gas token and the token backing vusd; which is the currency used in the margin account and insurance fund;
 * Therefore, this contract serves as a helper to (unwrap) usdc (gas token)
*/
contract MarginAccountHelper is HubbleBase {
    using SafeERC20 for IERC20;

    uint constant VUSD_IDX = 0;
    uint256 private constant SCALING_FACTOR = 1e12;

    IMarginAccount public marginAccount;
    IVUSD public vusd;
    IInsuranceFund public insuranceFund;
    IHGT public hgt;

    uint256[49] private __gap;

    function initialize(
        address _governance,
        address _vusd,
        address _marginAccount,
        address _insuranceFund,
        address _hgt
    ) external initializer {
        _setGovernace(_governance);
        vusd = IVUSD(_vusd);
        marginAccount = IMarginAccount(_marginAccount);
        insuranceFund = IInsuranceFund(_insuranceFund);
        hgt = IHGT(_hgt);
        IERC20(_vusd).safeApprove(_marginAccount, type(uint).max);
        IERC20(_vusd).safeApprove(_insuranceFund, type(uint).max);
    }

    receive() external payable {}

    /**
     * @notice Accepts gas token (usdc), wraps it for vusd and deposits it to margin account for the trader
     * @param amount Amount of vusd to deposit. msg.value has to be exactly 1e12 times `amount`
    */
    function addVUSDMarginWithReserve(uint256 amount, address to) external payable {
        vusd.mintWithReserve{value: msg.value}(address(this), amount);
        marginAccount.addMarginFor(VUSD_IDX, amount, to);
    }

    /**
     * @notice Remove margin on trader's behalf, enter the withdrawal Q and process the withdrawals
    */
    function removeMarginInUSD(uint256 amount) external {
        address trader = msg.sender;
        marginAccount.removeMarginFor(VUSD_IDX, amount, trader);
        vusd.withdrawTo(trader, amount);
        vusd.processWithdrawals();
    }

    /**
    * @notice Withdraw margin from margin account to supportedEVMChain
    * @param to address to withdraw to at the destination chain
    * @param amount Amount of token to withdraw from margin account
    * @param dstChainId ChainId of the direct bridge chain
    * @param secondHopChainId ChainId of the final destination chain, 0 if the destination chain is the direct bridge chain
    * @param amountMin min amount of token to be received on the destination chain (used in stargate call)
    * @param dstPoolId stargate pool id on the secondHop chain (dstChain)
    * @dev layer0 fee should be passed as msg.value
    */
    function withdrawMarginToChain(address to, uint amount, uint tokenIdx, uint16 dstChainId, uint16 secondHopChainId, uint amountMin, uint dstPoolId, bytes calldata adapterParams) external payable {
        address trader = msg.sender;
        IHGT.WithdrawVars memory withdrawVars = IHGT.WithdrawVars({
            dstChainId: dstChainId,
            secondHopChainId: secondHopChainId,
            dstPoolId: dstPoolId,
            amount: amount,
            amountMin: amountMin,
            to: to,
            tokenIdx: tokenIdx,
            refundAddress: payable(trader),
            zroPaymentAddress: address(0),
            adapterParams: adapterParams
        });

        marginAccount.removeMarginFor(tokenIdx, amount, trader);
        if (tokenIdx == VUSD_IDX) {
            vusd.withdrawTo(address(this), amount);
            vusd.processWithdrawals();
            uint amountScaled = amount * SCALING_FACTOR;
            require(address(this).balance >= msg.value + amountScaled, "MarginAccountHelper: Margin withdrawal failed");
            withdrawVars.amount = amountScaled;
            hgt.withdraw{value: msg.value + amountScaled}(withdrawVars);
        } else {
            IERC20 token = marginAccount.getCollateralToken(tokenIdx);
            require(token.balanceOf(address(this)) >= amount, "MarginAccountHelper: Margin withdrawal failed");
            hgt.withdraw{value: msg.value}(withdrawVars);
        }
    }

    /**
    * @notice Withdraw from insurance fund to supportedEVMChain
    * @param to address to withdraw to at the destination chain
    * @param shares amount insurance fund shares to withdraw
    * @param dstChainId ChainId of the direct bridge chain
    * @param secondHopChainId ChainId of the destination chain, 0 if the destination chain is the direct bridge chain
    * @param amountMin min amount of USDC to be received on the destination chain (used in stargate call)
    * @param dstPoolId stargate pool id on the secondHop chain (dstChain)
    * @dev layer0 fee should be passed as msg.value
    */
    function withdrawFromInsuranceFundToChain(address to, uint shares, uint16 dstChainId, uint16 secondHopChainId, uint amountMin, uint dstPoolId, bytes calldata adapterParams) external payable {
        address trader = msg.sender;
        uint amount = _withdrawFromInsuranceFund(shares, trader, address(this));
        amount = amount * SCALING_FACTOR;
        require(address(this).balance >= msg.value + amount, "MarginAccountHelper: IF withdrawal failed");

        IHGT.WithdrawVars memory withdrawVars = IHGT.WithdrawVars({
            dstChainId: dstChainId,
            secondHopChainId: secondHopChainId,
            dstPoolId: dstPoolId,
            amount: amount,
            amountMin: amountMin,
            to: to,
            tokenIdx: VUSD_IDX,
            refundAddress: payable(trader),
            zroPaymentAddress: address(0),
            adapterParams: adapterParams
        });
        hgt.withdraw{value: msg.value + amount}(withdrawVars);
    }

    /**
    * @notice Deposit vusd to insurance fund using gas token (usdc)
    */
    function depositToInsuranceFund(uint256 amount, address to) external payable {
        vusd.mintWithReserve{value: msg.value}(address(this), amount);
        insuranceFund.depositFor(to, amount);
    }

    /**
    * @notice Withdraw vusd from insurance fund and get gas token (usdc)
    */
    function withdrawFromInsuranceFund(uint256 shares) external {
        address user = msg.sender;
        _withdrawFromInsuranceFund(shares, user, user);
    }

    function _withdrawFromInsuranceFund(uint256 shares, address user, address to) internal returns(uint256 amount){
        amount = insuranceFund.withdrawFor(user, shares);
        vusd.withdrawTo(to, amount);
        vusd.processWithdrawals();
    }

    /* ****************** */
    /*     Governance     */
    /* ****************** */

    function syncDeps(address _registry) public onlyGovernance {
        IRegistry registry = IRegistry(_registry);
        vusd = IVUSD(registry.vusd());
        marginAccount = IMarginAccount(registry.marginAccount());
        insuranceFund = IInsuranceFund(registry.insuranceFund());
    }

    function setHGT(address _hgt) external onlyGovernance {
        hgt = IHGT(_hgt);
    }

    function approveToken(address token, address spender, uint256 amount) external onlyGovernance {
        IERC20(token).safeApprove(spender, amount);
    }
}
