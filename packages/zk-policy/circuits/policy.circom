pragma circom 2.2.3;

include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/poseidon.circom";
include "./merkle.circom";

/// Proves an amount cap, recipient membership and exact payment binding.
/// Outputs are the only public signals and their declaration order is stable.
template PolicyV1(depth) {
    signal input amount;
    signal input recipient;
    signal input nonce;
    signal input resourceHash;
    signal input cap;
    signal input pathElements[depth];
    signal input pathIndices[depth];

    signal output commitment;
    signal output root;
    signal output capPublic;

    component amountRange = Num2Bits(64);
    component capRange = Num2Bits(64);
    component nonceRange = Num2Bits(248);
    component resourceHashRange = Num2Bits(248);

    amountRange.in <== amount;
    capRange.in <== cap;
    nonceRange.in <== nonce;
    resourceHashRange.in <== resourceHash;

    component withinCap = LessEqThan(64);
    withinCap.in[0] <== amount;
    withinCap.in[1] <== cap;
    withinCap.out === 1;

    component recipientPath = MerkleVerify(depth);
    recipientPath.leaf <== recipient;
    for (var i = 0; i < depth; i++) {
        recipientPath.pathElements[i] <== pathElements[i];
        recipientPath.pathIndices[i] <== pathIndices[i];
    }
    root <== recipientPath.root;

    component paymentCommitment = Poseidon(4);
    paymentCommitment.inputs[0] <== amount;
    paymentCommitment.inputs[1] <== recipient;
    paymentCommitment.inputs[2] <== nonce;
    paymentCommitment.inputs[3] <== resourceHash;
    commitment <== paymentCommitment.out;

    capPublic <== cap;
}

component main = PolicyV1(3);
