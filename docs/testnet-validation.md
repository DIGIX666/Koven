# Testnet competition validation

Validated on 2026-09-13 with the official policy artifacts, in `zk` mode.

The core run paid provider B, replayed its callback after restarting the services,
then used the same recorded success plus eight controlled failure events to select
and pay provider A. The failure events are scenario fixtures, not observed outages.
Both missions reached `closed`; their loans reached `repaid`.

Each mission obtained two verified offers, from lenders `0.0.10395803` and
`0.0.10395927`. The lower-fee offer from the first lender won. Proof generation
preceded credit, all three policy targets were provisioned through the registrar,
and callback replay preserved the original repayment transaction.

The Mirror Node independently returned `SUCCESS` and the exact recipient amounts
for every transaction listed below.

| Scenario | Provider payment | Loan principal | Repayment including credit fee |
| --- | --- | --- | --- |
| Provider B | 0.45 test HBAR to `0.0.10396546` | 0.45 test HBAR | 0.4545 test HBAR |
| Provider A | 0.80 test HBAR to `0.0.10396537` | 0.80 test HBAR | 0.8080 test HBAR |

| Core scenario | Funding | Payment | Repayment |
| --- | --- | --- | --- |
| Provider B | [funding](https://hashscan.io/testnet/transaction/0.0.10395803@1789298231.828417050) | [payment](https://hashscan.io/testnet/transaction/0.0.7162784@1789298237.074447801) | [repayment](https://hashscan.io/testnet/transaction/0.0.10395759@1789298253.439469991) |
| Provider A | [funding](https://hashscan.io/testnet/transaction/0.0.10395803@1789298384.252419170) | [payment](https://hashscan.io/testnet/transaction/0.0.7162784@1789298393.111688016) | [repayment](https://hashscan.io/testnet/transaction/0.0.10395759@1789298403.155313038) |

## Execution incident and cleanup

The first attempt exposed an incorrect fixture assumption: four failures did not
offset the cheaper provider’s price advantage. The shared fixture now injects eight
failures, with a regression test using the reference prices and latencies.

During diagnosis, an accidental fresh invocation created one additional provider B
mission and began a provider A mission before interruption. This was an execution
mistake, not an idempotency failure: the fresh invocation assigned new mission IDs.
The extra B mission completed and repaid normally. The interrupted A payment was
never submitted (`settlement_attempted = 0`), its authorization expired, and the
Mirror Node returned 404 for its transaction ID. Its 0.80 test HBAR principal plus
0.008 test HBAR fee were returned through a journaled operator compensation.

The compensation was confirmed before recording the interrupted mission as failed,
recovered and closed, and its loan as repaid in both local databases. It is not
counted as a successful paid-service mission or as restricted-signer repayment.
No completion report was fabricated. The operator recovery script and journal
remain in the ignored local recovery directory.

| Additional execution | Funding | Payment | Repayment / compensation |
| --- | --- | --- | --- |
| Extra provider B mission | [funding](https://hashscan.io/testnet/transaction/0.0.10395803@1789298330.530269374) | [payment](https://hashscan.io/testnet/transaction/0.0.7162784@1789298337.883321289) | [repayment](https://hashscan.io/testnet/transaction/0.0.10395759@1789298350.079855263) |
| Interrupted provider A mission | [funding](https://hashscan.io/testnet/transaction/0.0.10395803@1789298355.291123317) | Not submitted | [repayment](https://hashscan.io/testnet/transaction/0.0.10395759@1789298560.958251293) |

Total service payments were 1.70 test HBAR, including the unintended extra 0.45
test HBAR payment. Credit fees totaled 0.025 test HBAR across the four funded loans.
The eleven confirmed transfers charged 0.01859682 test HBAR in network fees across
the borrower, lender and facilitator accounts; paid account-query fees are additional.
All four loans are repaid; no new loan from this validation remains outstanding.

## Reproduction and local artifacts

See [setup instructions](setup.md#local-competition-services-and-trusted-registration).
The validation used the reference prices and latencies, a 1 test HBAR mission cap,
eight available loopback ports and an ignored `.env.testnet-validation` overlay.
The existing `.env` and the process already listening on port 3004 were preserved.

To continue after a completed provider B mission, use its recovery directory with
`KOVEN_TESTNET_RESUME_DIRECTORY` and `KOVEN_TESTNET_CONTINUE_COMPETITION=1`.
The original success event is reloaded, the old callback is replayed, and only the
provider A mission is created. Its `competition-history.json` preserves the exact
event snapshot used by this scenario.

Recovery databases, configuration overlays and operator journals are local only
under ignored paths. Commit this public evidence, not those runtime artifacts.
