// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

contract Clean {
    function add(uint256 left, uint256 right) external pure returns (uint256) {
        return left + right;
    }
}
