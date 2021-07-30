pragma solidity 0.8.4;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "./VUSD.sol";
import "hardhat/console.sol";

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
    mapping(uint => mapping(address => uint256)) public margin;

    VUSD public vUSD; // should be the supportedCollateral
    mapping(address => int256) public vUSDBalance;

    modifier onlyClearingHouse() {
        require(msg.sender == address(clearingHouse), "Only clearingHouse");
        _;
    }

    constructor(address _vUSD) {
        vUSD = VUSD(_vUSD);
    }

    function setClearingHouse(IClearingHouse _clearingHouse) public {
        clearingHouse = _clearingHouse;
    }

    function addMargin(uint idx, uint256 amount) external {
        address trader = msg.sender;
        supportedCollateral[idx].token.safeTransferFrom(trader, address(this), amount);
        margin[idx][trader] += amount; // take care of decimals, just using 6 rn for vusd and usdc
    }

    function removeMargin(uint idx, uint256 amount) external {
        // credit funding
        // check non-negative vusd balance
        address trader = msg.sender;
        margin[idx][trader] -= amount; // will revert if insufficient balance
        // if there are open positions, verifyMaintenanceMargin
        clearingHouse.verifyMaintenanceMargin(trader);
        supportedCollateral[idx].token.safeTransfer(trader, amount);
    }

    function getNormalizedMargin(address trader) external view returns(int256) {
        uint256 normMargin;
        for (uint i = 0; i < supportedCollateral.length; i++) {
            normMargin += margin[i][trader]; // price fixed at 1, normMargin has 6 decimals
            // normMargin += margin[i][trader] * supportedCollateral[i].oracle.price();
        }
        // uint -> int256 is unsafe typecast @todo fix it
        return int256(normMargin) + vUSDBalance[trader];
    }

    function realizePnL(address trader, int256 realizedPnl) onlyClearingHouse external {
        console.logInt(realizedPnl);
        int256 bal = vUSDBalance[trader];
        int256 toMint = realizedPnl;
        if (bal < 0) {
            toMint += bal; // reduce the vUSD to mint
        }
        if (toMint > 0) {
            vUSD.mint(address(this), uint(toMint));
        }
        vUSDBalance[trader] += realizedPnl; // -ve PnL will reduce balance
    }

    function addCollateral(address _coin, address _oracle) public {
        supportedCollateral.push(Collateral(IERC20(_coin), IOracle(_oracle)));
    }
}

interface IOracle {
    function price() external view returns(int256);
}

interface IClearingHouse {
    function verifyMaintenanceMargin(address trader) external;
}
