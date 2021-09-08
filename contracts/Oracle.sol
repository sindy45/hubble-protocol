pragma solidity 0.8.4;

contract Oracle {
    mapping(address => int256) prices;

    function setPrice(address asset, int256 _price) external {
        prices[asset] = _price;
    }

    function getUnderlyingPrice(address asset) external view returns(int256) {
        return prices[asset];
    }
}
