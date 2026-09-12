// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

contract LowSeverity {
    function usesTime() external view returns (bool) {
        return block.timestamp > 0;
    }

    function usesPreviousHash() external view returns (bytes32) {
        return block.blockhash(block.number - 1);
    }

    function usesLegacyHash(bytes memory value) external pure returns (bytes32) {
        return sha3(value);
    }
}
