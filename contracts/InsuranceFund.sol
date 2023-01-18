// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { ERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";

import { VanillaGovernable } from "./legos/Governable.sol";
import { IRegistry, IOracle, IMarginAccount, ERC20Detailed } from "./Interfaces.sol";

contract InsuranceFund is VanillaGovernable, ERC20Upgradeable {
    using SafeERC20 for IERC20;

    uint8 constant DECIMALS = 6;
    uint constant PRECISION = 10 ** DECIMALS;

    IERC20 public vusd;
    address public marginAccount;
    IOracle public oracle;
    uint public pendingObligation;
    uint public startPriceMultiplier;
    uint public auctionDuration;

    struct UnbondInfo {
        uint shares;
        uint unbondTime;
    }

    struct Auction {
        uint startPrice;
        uint startedAt;
        uint expiryTime;
    }
    /// @notice token to auction mapping
    mapping(address => Auction) public auctions;

    mapping(address => UnbondInfo) public unbond;
    uint256 public withdrawPeriod;
    uint256 public unbondPeriod;
    uint256 public unbondRoundOff;

    uint256[50] private __gap;

    event FundsAdded(address indexed insurer, uint amount, uint timestamp);
    event Unbonded(address indexed trader, uint256 unbondAmount, uint256 unbondTime, uint timestamp);
    event FundsWithdrawn(address indexed insurer, uint amount, uint timestamp);
    event BadDebtAccumulated(uint amount, uint timestamp);

    modifier onlyMarginAccount() {
        require(msg.sender == address(marginAccount), "IF.only_margin_account");
        _;
    }

    function initialize(address _governance) external initializer {
        __ERC20_init("Hubble-Insurance-Fund", "HIF");
        _setGovernace(_governance);

        unbondPeriod = 2 days;
        withdrawPeriod = 1 days;
        unbondRoundOff = 1 days;
        startPriceMultiplier = 1050000; // 1.05
        auctionDuration = 2 hours;
    }

    function deposit(uint _amount) external {
        settlePendingObligation();
        // we want to protect new LPs, when the insurance fund is in deficit
        require(pendingObligation == 0, "IF.deposit.pending_obligations");

        uint _pool = _totalPoolValue();
        uint _totalSupply = totalSupply();
        uint vusdBalance = balance();
        if (_totalSupply == 0 && vusdBalance > 0) { // trading fee accumulated while there were no IF LPs
            vusd.safeTransfer(governance, vusdBalance);
            _pool = 0;
        }

        vusd.safeTransferFrom(msg.sender, address(this), _amount);
        uint shares = 0;
        if (_pool == 0) {
            shares = _amount;
        } else {
            shares = _amount * _totalSupply / _pool;
        }
        _mint(msg.sender, shares);
        emit FundsAdded(msg.sender, _amount, _blockTimestamp());
    }

    function unbondShares(uint shares) external {
        address usr = _msgSender();
        require(shares <= balanceOf(usr), "unbonding_too_much");
        uint _now = _blockTimestamp();
        uint unbondTime = ((_now + unbondPeriod) / unbondRoundOff) * unbondRoundOff;
        unbond[usr] = UnbondInfo(shares, unbondTime);
        emit Unbonded(usr, shares, unbondTime, _now);
    }

    function withdraw(uint shares) external {
        // Checks
        address usr = _msgSender();
        require(unbond[usr].shares >= shares, "withdrawing_more_than_unbond");
        uint _now = _blockTimestamp();
        require(_now >= unbond[usr].unbondTime, "still_unbonding");
        require(!_hasWithdrawPeriodElapsed(_now, unbond[usr].unbondTime), "withdraw_period_over");

        // Effects
        settlePendingObligation();
        require(pendingObligation == 0, "IF.withdraw.pending_obligations");
        uint amount = balance() * shares / totalSupply();
        unchecked { unbond[usr].shares -= shares; }
        _burn(usr, shares);

        // Interactions
        vusd.safeTransfer(usr, amount);
        emit FundsWithdrawn(usr, amount, _now);
    }

    function seizeBadDebt(uint amount) external onlyMarginAccount {
        pendingObligation += amount;
        emit BadDebtAccumulated(amount, block.timestamp);
        settlePendingObligation();
    }

    function settlePendingObligation() public {
        if (pendingObligation > 0) {
            uint toTransfer = Math.min(vusd.balanceOf(address(this)), pendingObligation);
            if (toTransfer > 0) {
                pendingObligation -= toTransfer;
                vusd.safeTransfer(marginAccount, toTransfer);
            }
        }
    }

    function startAuction(address token) external onlyMarginAccount {
        if(!_isAuctionOngoing(auctions[token].startedAt, auctions[token].expiryTime)) {
            uint currentPrice = uint(oracle.getUnderlyingPrice(token));
            uint currentTimestamp = _blockTimestamp();
            auctions[token] = Auction(
                currentPrice * startPriceMultiplier / PRECISION,
                currentTimestamp,
                currentTimestamp + auctionDuration
            );
        }
    }

    /**
    * @notice buy collateral from ongoing auction at current auction price
    * @param token token to buy
    * @param amount amount to buy
    */
    function buyCollateralFromAuction(address token, uint amount) external {
        Auction memory auction = auctions[token];
        // validate auction
        require(_isAuctionOngoing(auction.startedAt, auction.expiryTime), "IF.no_ongoing_auction");

        // transfer funds
        uint vusdToTransfer = _calcVusdAmountForAuction(auction, token, amount);
        address buyer = _msgSender();
        vusd.safeTransferFrom(buyer, address(this), vusdToTransfer);
        IERC20(token).safeTransfer(buyer, amount); // will revert if there wasn't enough amount as requested

        // close auction if no collateral left
        if (IERC20(token).balanceOf(address(this)) == 0) {
            auctions[token].startedAt = 0;
        }
    }

    /* ****************** */
    /*        View        */
    /* ****************** */

    /**
    * @notice Just a vanity function
    * @return The hUSD amount backing each Insurance Fund share
    */
    function pricePerShare() external view returns (uint) {
        uint _totalSupply = totalSupply();
        uint _balance = balance();
        _balance -= Math.min(_balance, pendingObligation);
        if (_totalSupply == 0 || _balance == 0) {
            return PRECISION;
        }
        return _balance * PRECISION / _totalSupply;
    }

    function getAuctionPrice(address token) external view returns (uint) {
        Auction memory auction = auctions[token];
        if (_isAuctionOngoing(auction.startedAt, auction.expiryTime)) {
            return _getAuctionPrice(auction);
        }
        return 0;
    }

    function calcVusdAmountForAuction(address token, uint amount) external view returns(uint) {
        Auction memory auction = auctions[token];
        return _calcVusdAmountForAuction(auction, token, amount);
    }

    function isAuctionOngoing(address token) external view returns (bool) {
        return _isAuctionOngoing(auctions[token].startedAt, auctions[token].expiryTime);
    }

    function balance() public view returns (uint) {
        return vusd.balanceOf(address(this));
    }

    function decimals() public pure override returns (uint8) {
        return DECIMALS;
    }

    function _blockTimestamp() internal view virtual returns (uint256) {
        return block.timestamp;
    }

    /* ****************** */
    /*   Internal View    */
    /* ****************** */

    function _beforeTokenTransfer(address from, address to, uint256 amount) override internal view {
        if (from == address(0) || to == address(0)) return; // gas optimisation for _mint and _burn
        if (!_hasWithdrawPeriodElapsed(_blockTimestamp(), unbond[from].unbondTime)) {
            require(amount <= balanceOf(from) - unbond[from].shares, "shares_are_unbonding");
        }
    }

    function _hasWithdrawPeriodElapsed(uint _now, uint _unbondTime) internal view returns (bool) {
        return _now > (_unbondTime + withdrawPeriod);
    }

    function _getAuctionPrice(Auction memory auction) internal view returns (uint) {
        uint diff = auction.startPrice * (_blockTimestamp() - auction.startedAt) / auctionDuration;
        return auction.startPrice - diff;
    }

    function _isAuctionOngoing(uint startedAt, uint expiryTime) internal view returns (bool) {
        if (startedAt == 0) return false;
        uint currentTimestamp = _blockTimestamp();
        return startedAt <= currentTimestamp && currentTimestamp <= expiryTime;
    }

    function _calcVusdAmountForAuction(Auction memory auction, address token, uint amount) internal view returns(uint) {
        uint price = _getAuctionPrice(auction);
        uint _decimals = ERC20Detailed(token).decimals();  // will fail if .decimals() is not defined on the contract
        return amount * price / 10 ** _decimals;
    }

    function _totalPoolValue() internal view returns (uint totalBalance) {
        IMarginAccount.Collateral[] memory assets = IMarginAccount(marginAccount).supportedAssets();

        for (uint i; i < assets.length; i++) {
            uint _balance = IERC20(address(assets[i].token)).balanceOf(address(this));
            if (_balance == 0) continue;

            uint numerator = _balance * uint(oracle.getUnderlyingPrice(address(assets[i].token)));
            uint denomDecimals = assets[i].decimals;

            totalBalance += (numerator / 10 ** denomDecimals);
        }
    }

    /* ****************** */
    /*   onlyGovernance   */
    /* ****************** */

    function syncDeps(address _registry) public onlyGovernance {
        IRegistry registry = IRegistry(_registry);
        vusd = IERC20(registry.vusd());
        marginAccount = registry.marginAccount();
        oracle = IOracle(registry.oracle());
    }
}
