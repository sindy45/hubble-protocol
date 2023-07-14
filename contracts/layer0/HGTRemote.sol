// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.9;

import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Pausable } from "@openzeppelin/contracts/security/Pausable.sol";
import { Initializable } from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
// below imports Ownable from openzeppelin
import { NonblockingLzApp, BytesLib } from "@layerzerolabs/solidity-examples/contracts/lzApp/NonblockingLzApp.sol";
import { IERC20, AggregatorV3Interface, ERC20Detailed } from "../Interfaces.sol";
import { IHGTRemote, IStargateReceiver, IStargateRouter } from "./L0Interfaces.sol";

contract HGTRemote is IHGTRemote, IStargateReceiver, Initializable, Pausable, NonblockingLzApp {
    using BytesLib for bytes;
    using SafeERC20 for IERC20;

    uint constant USDC_IDX = 0;
    uint constant PT_SEND = 1;
    uint constant BASE_PRECISION = 1e18;

    uint8 constant TYPE_SWAP_REMOTE = 1; // stargaet router swap function type
    IStargateRouter public stargateRouter;
    uint16 public hubbleL0ChainId; // L0 chain id

    mapping(address => mapping(address => uint256)) public rescueFunds;
    mapping(address => bool) public whitelistedRelayer;

    struct SupportedToken {
        address token;
        // these fields are used for multi-hop deposit/withdrawals
        address priceFeed; // if a token has a price feed, it can be used for 2 hop transfers
        uint collectedFee; // will accumulate because we charge L0 native fee in token being deposited
        uint srcPoolId; // stargate pool id for token on local chain
        uint decimals; // decimals of the token
    }
    SupportedToken[] public supportedTokens;
    address public nativeTokenPriceFeed;

    uint256[50] private __gap;

    receive() external payable {
        emit DepositFees(msg.value, block.timestamp);
    }

    modifier checkWhiteList {
        require(whitelistedRelayer[msg.sender], "Not Valid Relayer");
        _;
    }

    modifier onlyMySelf() {
        require(msg.sender == address(this), "Only myself");
        _;
    }

    /**
     * @dev _lzEndPoint is immutable var in NonblockingLzApp
    */
    constructor(address _lzEndPoint) NonblockingLzApp(_lzEndPoint) {}

    function initialize(address _governance, address _starGateRouter, uint16 _hubbleL0ChainId, SupportedToken calldata _usdc, address _nativeTokenPriceFeed) external initializer {
        _transferOwnership(_governance);
        whitelistedRelayer[_starGateRouter] = true;
        stargateRouter = IStargateRouter(_starGateRouter);
        hubbleL0ChainId = _hubbleL0ChainId;
        _addSupportedToken(_usdc);
        require(AggregatorV3Interface(_nativeTokenPriceFeed).decimals() == 8, "HGTRemote: Invalid price feed address");
        nativeTokenPriceFeed = _nativeTokenPriceFeed;
    }

    /* ****************** */
    /*      Deposits      */
    /* ****************** */

    /**
     * @notice Deposit supported coins directly from the main bridge
    */
    function deposit(DepositVars calldata vars) external payable whenNotPaused {
        bytes memory metadata = _validations(vars);
        address from = _msgSender();
        _debitFrom(from, vars.amount, vars.tokenIdx);
        this.sendLzMsg(vars, metadata, msg.value);
    }

    function _validations(DepositVars memory vars) internal view returns (bytes memory metadata) {
        require(vars.amount != 0, "HGTRemote: Insufficient amount");
        require(vars.tokenIdx < supportedTokens.length, "HGTRemote: Invalid token index");
        if (vars.tokenIdx == USDC_IDX) {
            require(vars.amount >= vars.toGas, "HGTRemote: deposit < airdrop");
            metadata = abi.encode(vars.toGas, vars.isInsuranceFund);
        } else {
            require(vars.isInsuranceFund == false && vars.toGas == 0, "HGTRemote: Can transfer only usdc to insurance fund and gas wallet");
            // when we add new supported tokens, it will be possible to encode custom metadata for them, if required
        }
        // @todo do we need any validations on adapter params?
    }

    function _debitFrom(address from, uint amount, uint tokenIdx) internal {
        IERC20 token = IERC20(supportedTokens[tokenIdx].token);
        token.safeTransferFrom(from, address(this), amount);
    }

    function _buildLzPayload(DepositVars memory vars, bytes memory metadata) internal pure returns (bytes memory) {
        return abi.encode(PT_SEND, vars.to, vars.tokenIdx, vars.amount, metadata);
    }

    function sendLzMsg(
        DepositVars memory vars,
        bytes memory metadata,
        uint _nativeFee
    ) public onlyMySelf {
        bytes memory lzPayload = _buildLzPayload(vars, metadata);
        _lzSend(hubbleL0ChainId, lzPayload, vars.refundAddress, vars.zroPaymentAddress, vars.adapterParams, _nativeFee);
        uint64 nonce = lzEndpoint.getOutboundNonce(hubbleL0ChainId, address(this));
        emit SendToChain(hubbleL0ChainId, nonce, lzPayload);
    }

    /**
    * @notice This function will be called by stargate router after sending funds to this address
    * @param amountLD final amount of token received from stargate
    * layer0 fee is deducted from the amountLD to send it further to hubbleNet
    * there can be slippage in the amount transferred using stargate
    * @param payload payload received from stargate router
    * @param _token receiving token address
    * @dev stargate router address needs to be added as a whitelist relayer
    */
    function sgReceive(
        uint16 _srcChainId,
        bytes memory /* _srcAddress */, // the remote Bridge address
        uint nonce,
        address _token, // the token contract on the local chain
        uint amountLD, // the qty of local _token contract tokens received
        bytes memory payload
    ) override external checkWhiteList {
        DepositVars memory vars;
        address from;
        (
            from, vars.to, vars.tokenIdx, vars.amount, vars.toGas, vars.isInsuranceFund,
            vars.zroPaymentAddress, vars.adapterParams
        ) = abi.decode(payload, (address, address, uint, uint, uint, bool, address, bytes));
        vars.refundAddress = payable(address(this));
        bytes memory metadata = _validations(vars);
        require(supportedTokens[vars.tokenIdx].token == _token, "HGTRemote: token mismatch");
        emit ReceivedFromStargate(_srcChainId, nonce, _token, amountLD, payload);

        // The token (amountLD) is received, but we need to deduct the layer0 fee from it, which is paid in form of the native gas token
        // this problem only arises in multihop, because in single hop, it is sent as msg.value

        (int nativeTokenPrice, int tokenPrice) = _getTokenPrices(vars.tokenIdx);
        if (tokenPrice <= 0 || nativeTokenPrice <= 0) { // some issue with the price feed, should not happen
            return _registerDepositSecondHopFailure(_srcChainId, nonce, vars.to, _token, amountLD);
        }

        // _buildLzPayload() will need to be called again because actual deposit amount will change based on L0 fee
        // but we still construct this payload on a best-effort basis because the L0 fee will vary with payload length
        (uint nativeFee,) = lzEndpoint.estimateFees(hubbleL0ChainId, address(this), _buildLzPayload(vars, metadata), false /* _useZro */, vars.adapterParams);
        // since amountLD is in token being transferred precision, l0Fee being charged should also be in the same precision
        uint l0Fee = _calculateL0Fee(nativeFee, uint(nativeTokenPrice), uint(tokenPrice), vars.tokenIdx);
        if (amountLD <= l0Fee) {
            return _registerDepositSecondHopFailure(_srcChainId, nonce, vars.to, _token, amountLD);
        }
        vars.amount = amountLD - l0Fee;

        if (vars.tokenIdx == USDC_IDX && vars.amount <= vars.toGas) {
            // if the remaining amount is less than the desired airdrop, then send the whole amount as gas airdrop
            vars.toGas = vars.amount;
            vars.isInsuranceFund = false; // redundant, but just to be sure
        }

        try this.sendLzMsg(vars, metadata, nativeFee) {
            supportedTokens[vars.tokenIdx].collectedFee += l0Fee;
        } catch {
            return _registerDepositSecondHopFailure(_srcChainId, nonce, vars.to, _token, amountLD);
        }
    }

    function _registerDepositSecondHopFailure(uint16 srcChainId, uint nonce, address to, address token, uint256 amount) internal {
        rescueFunds[token][to] += amount;
        emit DepositSecondHopFailure(srcChainId, nonce, to, token, amount);
    }

    /**
    * @notice returns native token and token[tokenIdx] price in 6 decimals
    */
    function _getTokenPrices(uint tokenIdx) internal view returns (int256 nativeTokenPrice, int256 tokenPrice) {
        nativeTokenPrice = getLatestRoundData(nativeTokenPriceFeed);
        tokenPrice = getLatestRoundData(supportedTokens[tokenIdx].priceFeed); // will revert for tokens that are not whitelisted for multi hops
    }

    /**
    * @notice returns layer0 fee coverted to token being transferred and its precision
    */
    function _calculateL0Fee(uint nativeFee, uint nativeTokenPrice, uint tokenPrice, uint tokenIdx) internal view returns (uint) {
        return nativeFee * nativeTokenPrice / tokenPrice / (10 ** (18 - supportedTokens[tokenIdx].decimals)); // nativeFee is 18 decimals, tokenPrice is 6 decimals
    }

    /* ****************** */
    /*     Withdrawals    */
    /* ****************** */

    function _nonblockingLzReceive(uint16 _srcChainId, bytes memory /* _srcAddress */, uint64 nonce, bytes memory payload) internal override {
        (
            uint16 packetType, address to, uint tokenIdx, uint amount, uint16 secondHopChainId, uint amountMin, uint dstPoolId
        ) = abi.decode(payload, (uint16, address, uint, uint, uint16, uint, uint));
        require(tokenIdx < supportedTokens.length, "HGTRemote: Invalid token index");

        // check for amount and user, should not happen as we have already validated it in HGT
        require(amount != 0 && to != address(0x0), "HGTRemote: Insufficient amount or invalid user");

        bool lzSendSuccess = true;
        if (secondHopChainId != 0) {
            // It is called while withdrawing funds from hubbleNet to anyEVMChain (other than direct bridge chain)
            lzSendSuccess = _callSecondHop(tokenIdx, amount, to, secondHopChainId, amountMin, dstPoolId);
            if (!lzSendSuccess) emit WithdrawSecondHopFailure(secondHopChainId, nonce, to, supportedTokens[tokenIdx].token, amount);
        } else if (packetType == PT_SEND) {
            _creditTo(to, tokenIdx, amount);
        } else {
            revert("HGTCore: unknown packet type");
        }
        emit ReceiveFromHubbleNet(_srcChainId, to, amount, lzSendSuccess, nonce);
    }

    function _creditTo(address _toAddress, uint tokenIdx, uint amount) internal returns(uint) {
        IERC20 token = IERC20(supportedTokens[tokenIdx].token);
        token.safeTransfer(_toAddress, amount);
        return amount;
    }

    struct Vars {
        uint nativeFee;
        uint l0Fee;
    }

    /**
    * @notice This function will be called when withdrawing funds from HubbleNet to remote chain to anyEvmChain
    * @dev stargate is used to transfer funds from remote chain to anyEvmChain
    * layer0 fee is deducted from the amount transferred to send it further to anyEvmChain
    */
    function _callSecondHop(uint tokenIdx, uint256 amount, address _to, uint16 _dstChainId, uint amountMin, uint _dstPoolId) internal returns (bool lzSendSuccess) {
        SupportedToken memory supportedToken = supportedTokens[tokenIdx];
        Vars memory vars;
        bytes memory _toAddress = abi.encodePacked(_to);
        {
            try stargateRouter.quoteLayerZeroFee(_dstChainId, TYPE_SWAP_REMOTE, _toAddress, new bytes(0), IStargateRouter.lzTxObj(0, 0, "0x")) returns(uint256 _fees, uint) {
                vars.nativeFee = _fees;
            } catch {
                _registerWithdrawalSecondHopFailure(_to, supportedToken.token, amount);
                return false;
            }

            (int nativeTokenPrice, int tokenPrice) = _getTokenPrices(tokenIdx);

            if (tokenPrice <= 0 || nativeTokenPrice <= 0) {
                _registerWithdrawalSecondHopFailure(_to, supportedToken.token, amount);
                return false;
            }

            vars.l0Fee = _calculateL0Fee(vars.nativeFee, uint(nativeTokenPrice), uint(tokenPrice), tokenIdx);
            if (amount <= vars.l0Fee) {
                _registerWithdrawalSecondHopFailure(_to, supportedToken.token, amount);
                return false;
            }
            amount -= vars.l0Fee;
        }

        IERC20(supportedToken.token).safeApprove(address(stargateRouter), amount);
        try stargateRouter.swap{value: vars.nativeFee}(
            _dstChainId,
            supportedToken.srcPoolId,
            _dstPoolId,
            payable(address(this)),
            amount,
            amountMin,
            IStargateRouter.lzTxObj(0, 0, "0x"),
            _toAddress,
            bytes("")
        ) {
            lzSendSuccess = true;
            supportedTokens[tokenIdx].collectedFee += vars.l0Fee;
        } catch {
            // l0Fee is not charged in this case
            _registerWithdrawalSecondHopFailure(_to, supportedToken.token, amount + vars.l0Fee);
        }
        // resetting allowance for safety
        IERC20(supportedToken.token).safeApprove(address(stargateRouter), 0);
    }

    function _registerWithdrawalSecondHopFailure(address to, address token, uint256 amount) internal {
        rescueFunds[token][to] += amount;
    }

    /* ****************** */
    /*       Common       */
    /* ****************** */

    function estimateSendFee(DepositVars memory vars) public view returns (uint,uint) {
        bytes memory metadata = _validations(vars);
        return lzEndpoint.estimateFees(hubbleL0ChainId, address(this), _buildLzPayload(vars, metadata), false /* _useZro */, vars.adapterParams);
    }

    function estimateSendFeeInUSD(DepositVars memory vars) external view returns (uint) {
        int256 latestPrice = getLatestRoundData(nativeTokenPriceFeed);
        if (latestPrice <= 0) return 0;
        (uint nativeFee,) = estimateSendFee(vars);
        return nativeFee * uint(latestPrice) / BASE_PRECISION;
    }

    function quoteStargateFeeInUSD(uint16 _dstChainId, uint8 _functionType, bytes calldata _toAddress,  bytes calldata _transferAndCallPayload, IStargateRouter.lzTxObj memory _lzTxParams) external view returns(uint) {
        int256 latestPrice = getLatestRoundData(nativeTokenPriceFeed);
        if (latestPrice <= 0) return 0;
        (uint nativeFee,) = stargateRouter.quoteLayerZeroFee(_dstChainId, _functionType, _toAddress, _transferAndCallPayload, _lzTxParams);
        return nativeFee * uint(latestPrice) / BASE_PRECISION;
    }

    function rescueMyFunds(address token, uint256 amount) external {
        address to = _msgSender();
        require(rescueFunds[token][to] >= amount, "HGTRemote: Insufficient pending funds");
        rescueFunds[token][to] -= amount;
        IERC20(token).safeTransfer(to, amount);
    }

    function feeCollected(uint tokenIdx) external view returns (uint) {
        return supportedTokens[tokenIdx].collectedFee;
    }

    function getLatestRoundData(address priceFeed) internal view returns (int256 price) {
        (, price,,,) = AggregatorV3Interface(priceFeed).latestRoundData();
        return (price / 100);
    }

    /* ****************** */
    /*     Governance     */
    /* ****************** */

    function setWhitelistRelayer(address _whitelistRelayer, bool isWhiteList) external onlyOwner {
        whitelistedRelayer[_whitelistRelayer] = isWhiteList;
    }

    function setStargateConfig(address _starGateRouter) external onlyOwner {
        stargateRouter = IStargateRouter(_starGateRouter);
    }

    function addSupportedToken(SupportedToken calldata token) external onlyOwner {
        _addSupportedToken(token);
    }

    function _addSupportedToken(SupportedToken memory token) internal {
        require(token.token != address(0x0), "HGTRemote: Invalid token address");
        require(token.collectedFee == 0, "HGTRemote: Invalid collected fee");
        if (token.priceFeed != address(0x0)) { // supported for multihops
            require(AggregatorV3Interface(token.priceFeed).decimals() == 8, "HGTRemote: Invalid price feed address");
            require(token.srcPoolId != 0, "HGTRemote: Invalid pool id");
        }
        token.decimals = ERC20Detailed(token.token).decimals(); // will revert if .decimals() is not defined in the contract
        supportedTokens.push(token);
    }

    // @todo add swap function to swap usdc to native token
}
