// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.9;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { ERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";

import { VanillaGovernable } from "./legos/Governable.sol";
import { IRegistry } from "./Interfaces.sol";

contract InsuranceFund is VanillaGovernable, ERC20Upgradeable {
    using SafeERC20 for IERC20;

    uint8 constant DECIMALS = 6;
    uint constant PRECISION = 10 ** DECIMALS;

    IERC20 public vusd;
    address public marginAccount;
    uint public pendingObligation;

    struct UnbondInfo {
        uint shares;
        uint unbondTime;
    }
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
    }

    function deposit(uint _amount) external {
        settlePendingObligation();
        // we want to protect new LPs, when the insurance fund is in deficit
        require(pendingObligation == 0, "IF.deposit.pending_obligations");

        uint _pool = balance();
        uint _totalSupply = totalSupply();
        if (_totalSupply == 0 && _pool > 0) { // trading fee accumulated while there were no IF LPs
            vusd.safeTransfer(governance, _pool);
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

    /* ****************** */
    /*        View        */
    /* ****************** */

    /**
    * @notice Just a vanity function
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

    /* ****************** */
    /*   onlyGovernance   */
    /* ****************** */

    function syncDeps(IRegistry _registry) public onlyGovernance {
        vusd = IERC20(_registry.vusd());
        marginAccount = _registry.marginAccount();
    }
}
