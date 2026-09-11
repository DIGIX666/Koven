# Product scope

Koven demonstrates a source-bound, paid Solidity security scan inside the wider
credit and payment lifecycle. The scan is useful evidence for the demo, but its
findings are informational: they do not decide whether a payment settles or a
mission completes.

## Solidity scan engine

The reproducible local engine is Solhint 6.2.4 with a fixed security-focused
rule profile. It is implemented behind `ScanEngine`, so callers do not depend on
Solhint-specific output.

Solhint was selected because it runs as part of the Node.js workspace and keeps
`pnpm install` sufficient for a clean checkout. It is not a substitute for a
compiler, formal verification, or a deeper static analyser. Slither remains a
possible additional engine behind the same interface, but its Python toolchain
is outside the current reproducible demo scope.
