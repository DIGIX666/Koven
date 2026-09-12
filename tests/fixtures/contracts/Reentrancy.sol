// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

contract Reentrancy {
    mapping(address => uint256) private balances;

    function deposit() external payable {
        balances[msg.sender] += msg.value;
    }

    function withdraw() external {
        uint256 balance = balances[msg.sender];
        payable(msg.sender).transfer(balance);
        balances[msg.sender] = 0;
    }
}
