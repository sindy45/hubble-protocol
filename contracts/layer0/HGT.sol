// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

import { Initializable } from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
// below imports Ownable from openzeppelin
import { NonblockingLzApp, BytesLib } from "@layerzerolabs/solidity-examples/contracts/lzApp/NonblockingLzApp.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Pausable } from "@openzeppelin/contracts/security/Pausable.sol";

import { IMarginAccountHelper, IMarginAccount, IERC20 } from "../Interfaces.sol";
import { IHGT } from "./L0Interfaces.sol";

/**
 * @title Hubble Gas Token for HubbleNet
 */

contract HGT is IHGT, Initializable, Pausable, NonblockingLzApp {
    using BytesLib for bytes;
    using SafeERC20 for IERC20;

    IMarginAccountHelper public marginAccountHelper;
    IMarginAccount public marginAccount;
    uint256 public constant SCALING_FACTOR = 1e12;
    uint16 public constant PT_SEND = 1;
    uint public constant USDC_IDX = 0; // usdc index in supportedTokens array

    struct SupportedToken {
        address token;
        uint circulatingSupply;
        bool isEnabledForMultiHop;
    }
    SupportedToken[] public supportedTokens;

    uint256[50] private __gap;

    event DepositFees(uint256 amount, uint256 time);

    receive() external payable {
        emit DepositFees(msg.value, block.timestamp);
    }

    constructor(address _lzEndPoint) NonblockingLzApp(_lzEndPoint) {}

    function initialize(address _governance, address _marginAccountHelper) external initializer {
        _transferOwnership(_governance);
        marginAccountHelper = IMarginAccountHelper(_marginAccountHelper);
        marginAccount = IMarginAccount(marginAccountHelper.marginAccount());
        SupportedToken memory usdc = SupportedToken({
            token: address(0), // usdc
            circulatingSupply: 0,
            isEnabledForMultiHop: true
        });
        supportedTokens.push(usdc);
    }

    /* ****************** */
    /*      Deposits      */
    /* ****************** */

    function _nonblockingLzReceive(uint16 _srcChainId, bytes memory /* _srcAddress */, uint64 _nonce, bytes memory _payload) internal override {
        (uint16 packetType, address to, uint tokenIdx, uint amount, bytes memory metadata) = abi.decode(_payload, (uint16, address, uint, uint, bytes));
        require(
            amount != 0 && to != address(0x0),
            "HGT: Insufficient amount or invalid user"
        );
        require(tokenIdx < supportedTokens.length, "HGT: Invalid token index");
        if (packetType != PT_SEND) {
            revert("HGTCore: unknown packet type");
        }

        if (tokenIdx == USDC_IDX) {
            (uint toGas, bool isInsuranceFund) = abi.decode(metadata, (uint, bool));
            _creditTo(to, amount, toGas, isInsuranceFund);
        } else {
            // optionally remove this and add custom handling for metadata
            require(metadata.length == 0, "HGT: Invalid metadata");
            _creditNonUsdcToken(to, amount, tokenIdx);
        }
        emit ReceiveFromChain(_srcChainId, to, tokenIdx, amount, metadata, _nonce);
    }

    /**
    * @notice Credits margin, gas and insurance fund amount to the user
    * @param _toAddress Address of the user
    * @param _amount Total amount to be deposited, 1e6 precision
    * @param _toGas Amount to be deposited to user's gas wallet, 1e6 precision
    * @param _isInsuranceFund True if (_amount - _toGas) is to be deposited to insurance fund, false if to margin account
    */
    function _creditTo(address _toAddress, uint _amount, uint _toGas, bool _isInsuranceFund) internal whenNotPaused returns(uint, uint) {
        supportedTokens[USDC_IDX].circulatingSupply += _amount * SCALING_FACTOR;

        if (_toGas > 0) {
            _amount -= _toGas; // will revert if _toGas > _amount, but this should not happen because we took care of it in HGTRemote
            _toGas *= SCALING_FACTOR;
            (bool success, ) = payable(_toAddress).call{value: _toGas}("");
            require(success, "HGT: failed to airdrop gas to user");
        }

        if (_amount > 0) {
            if (_isInsuranceFund) {
                marginAccountHelper.depositToInsuranceFund{value: _amount * SCALING_FACTOR}(_amount, _toAddress);
            } else {
                marginAccountHelper.addVUSDMarginWithReserve{value: _amount * SCALING_FACTOR}(_amount, _toAddress);
            }
        }
        return (_amount, _toGas);
    }

    function _creditNonUsdcToken(address _toAddress, uint _amount, uint _tokenIdx) internal {
        supportedTokens[_tokenIdx].circulatingSupply += _amount;
        marginAccount.getCollateralToken(_tokenIdx).safeApprove(address(marginAccount), _amount);
        marginAccount.addMarginFor(_tokenIdx, _amount, _toAddress); // will fail unless this contract has these tokens
    }

    /* ****************** */
    /*     Withdrawals    */
    /* ****************** */

    function withdraw(WithdrawVars memory vars) external payable whenNotPaused {
        // @todo do we need any validations on adapter params?
        if (vars.secondHopChainId != 0) {
            require(supportedTokens[vars.tokenIdx].isEnabledForMultiHop, "HGT: not allowed for 2 hops");
        }
        uint nativeFee = msg.value;
        uint amount = vars.amount;
        require(amount != 0 && vars.to != address(0x0), "HGT: Insufficient amount or invalid user");
        if (vars.tokenIdx == USDC_IDX) {
            require(nativeFee >= amount, "HGT: Insufficient native token transferred");
            nativeFee -= amount;
            vars.amount = amount / SCALING_FACTOR;
        } else {
            IERC20 token = IERC20(supportedTokens[vars.tokenIdx].token);
            // @todo maybe we will change this code here to be able to withdraw margin from user's behalf
            token.safeTransferFrom(_msgSender(), address(this), amount); // will revert if vars.tokenIdx >= supportedTokens.length
        }
        supportedTokens[vars.tokenIdx].circulatingSupply -= amount;
        _sendLzMsg(_msgSender(), vars, nativeFee);
    }

    function _sendLzMsg(address _from, WithdrawVars memory vars, uint _nativeFee) internal {
        // @todo should dstPoolId be taken from the user or whitelisted here with a mapping?
        _lzSend(vars.dstChainId, _buildLzPayload(vars), vars.refundAddress, vars.zroPaymentAddress, vars.adapterParams, _nativeFee);
        uint64 nonce = lzEndpoint.getOutboundNonce(vars.dstChainId, address(this));
        emit SendToChain(vars.dstChainId, _from, vars.to, vars.tokenIdx, vars.amount, nonce);
    }

    function estimateSendFee(WithdrawVars memory vars) external view returns (uint,uint) {
        return lzEndpoint.estimateFees(vars.dstChainId, address(this), _buildLzPayload(vars), false /* _useZro */, vars.adapterParams);
    }

    function _buildLzPayload(WithdrawVars memory vars) internal pure returns(bytes memory) {
        return abi.encode(PT_SEND, vars.to, vars.tokenIdx, vars.amount, vars.secondHopChainId, vars.amountMin, vars.dstPoolId);
    }

    /* ****************** */
    /*       Getters      */
    /* ****************** */

    function getSupportedTokens() external view returns(SupportedToken[] memory) {
        return supportedTokens;
    }

    function circulatingSupply(uint tokenIdx) external view returns(uint) {
        return supportedTokens[tokenIdx].circulatingSupply;
    }

    /* ****************** */
    /*     Governance     */
    /* ****************** */

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function setMarginAccountHelper(address _marginAccountHelper) external onlyOwner {
        marginAccountHelper = IMarginAccountHelper(_marginAccountHelper);
    }
}
