pragma solidity 0.8.4;

contract Oracle {
    function price() external pure returns(int256) {
        return 1e6 * 2000; // $2000
    }
}
