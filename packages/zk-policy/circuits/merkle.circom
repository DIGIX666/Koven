pragma circom 2.2.3;

include "circomlib/circuits/poseidon.circom";

/// Computes the root reached by a binary Poseidon authentication path.
/// A path index of zero places the current node on the left; one places it on
/// the right. The explicit boolean constraint prevents forged interpolation.
template MerkleVerify(depth) {
    signal input leaf;
    signal input pathElements[depth];
    signal input pathIndices[depth];

    signal output root;

    signal nodes[depth + 1];
    signal left[depth];
    signal right[depth];
    component hashes[depth];

    nodes[0] <== leaf;

    for (var i = 0; i < depth; i++) {
        pathIndices[i] * (pathIndices[i] - 1) === 0;

        left[i] <== nodes[i] + pathIndices[i] * (pathElements[i] - nodes[i]);
        right[i] <== pathElements[i] + pathIndices[i] * (nodes[i] - pathElements[i]);

        hashes[i] = Poseidon(2);
        hashes[i].inputs[0] <== left[i];
        hashes[i].inputs[1] <== right[i];
        nodes[i + 1] <== hashes[i].out;
    }

    root <== nodes[depth];
}
