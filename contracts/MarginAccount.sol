pragma solidity 0.8.4;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract MarginAccount {
    using SafeERC20 for IERC20;

    uint8 constant vUSDidx = 0;

    IClearingHouse public clearingHouse;

    struct Collateral {
        IERC20 token;
        IOracle oracle;
    }
    Collateral[] public supportedCollateral;
    // supportedCollateral index => trader => balance
    mapping(uint => mapping(address => int256)) public margin;

    IERC20 public vUSD; // should be the supportedCollateral

    modifier onlyClearingHouse() {
        require(msg.sender == address(clearingHouse), "Only clearingHouse");
        _;
    }

    constructor(address _vUSD, address _vUSDOracle, address _clearingHouse) {
        vUSD = IERC20(_vUSD);
        supportedCollateral.push(Collateral(IERC20(_vUSD), IOracle(_vUSDOracle)));
        clearingHouse = IClearingHouse(_clearingHouse);
    }

    function addMargin(uint idx, int256 amount) external {
        address trader = msg.sender;
        supportedCollateral[idx].token.safeTransferFrom(trader, address(this), uint(amount));
        margin[idx][trader] += amount;
    }

    function removeMargin(uint idx, int256 amount) external {
        address trader = msg.sender;
        margin[idx][trader] -= amount; // will revert if insufficient balance
        clearingHouse.verifyMaintenanceMargin(trader);
        supportedCollateral[idx].token.safeTransfer(trader, uint(amount));
    }

    function getNormalizedMargin(address trader) external view returns(int256 normMargin) {
        for (uint i = 0; i < supportedCollateral.length; i++) {
            normMargin += margin[i][trader] * supportedCollateral[i].oracle.price();
        }
    }

    function realizePnL(address trader, int256 realizedPnl) onlyClearingHouse external {
        int256 bal = margin[vUSDidx][trader];
        margin[vUSDidx][trader] += realizedPnl;
        int256 toMint = realizedPnl;
        if (bal < 0) {
            toMint += bal; // reduce the vUSD to mint
        }
        if (toMint > 0) {
            // vUSD.mint(address(this), toMint); @todo
        }
    }
}

interface IOracle {
    function price() external view returns(int256);
}

interface IClearingHouse {
    function verifyMaintenanceMargin(address trader) external;
}
