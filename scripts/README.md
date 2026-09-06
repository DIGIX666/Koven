# Operational scripts

Run from the repository root. Scripts read the root `.env` directly, require
`HEDERA_NETWORK=testnet`, validate the operator's ECDSA key against its account,
and never print private keys. An exported non-testnet `HEDERA_NETWORK` also stops
the command. Shell environment values do not override the provisioning inventory.

| Command | Behavior |
| --- | --- |
| `pnpm tsx scripts/hedera-balances.ts` | Verify six distinct ECDSA accounts, display tinybar balances, fail if any are missing or unfunded. |
| `pnpm tsx scripts/hedera-create-accounts.ts` | Create missing non-operator accounts with separate ECDSA keys and 1 HBAR each; validate and skip configured accounts. |
| `pnpm tsx scripts/hedera-create-accounts.ts --role provider-a --initial-tinybar 100000000` | Create only the selected missing role with an explicit initial balance. |
| `pnpm tsx scripts/hedera-fund.ts --role provider-a --target-tinybar 100000000` | Transfer only the shortfall needed to reach 1 HBAR. Skip if already funded to that target. |
| `pnpm tsx scripts/hedera-create-topic.ts` | Create and save an operator-administered audit topic, or validate the existing configured topic. |

All submitted transactions also incur normal testnet network fees, paid by the
operator. Existing funding destinations are checked with `AccountInfoQuery`
before any transfer. Account creation necessarily targets a new account; the
operator is checked first, and the newly created account/key is checked afterward.
Amounts are positive decimal tinybar strings bounded to signed int64.

## Local state and recovery

New account keys are saved in `.env` **before** submitting their creation
transaction, using the role's `*_PRIVATE_KEY` variable. The two provider keys are
recovery material only; do not pass them to scan services. Keep a private backup
of `.env`. The file is written atomically with mode `0600`, and existing comments
and unrelated values are preserved. Never edit it while a command is running.

`KOVEN_CREATE_*_TX_ID` and `KOVEN_FUND_*_TX_ID` entries are a local transaction
journal. Each transaction ID is saved before submission and its HashScan link
is printed. A rerun reconciles a pending ID through a receipt query; it does not
resubmit it or generate a replacement. Successful account/topic entries stay as
creation references; successful funding clears its pending entry.

Receipt availability is limited. If reconciliation cannot find a `SUCCESS`
receipt, inspect the printed transaction in HashScan and the relevant account
history. Do not delete journal entries and retry without establishing the result:
a transfer or creation may already have reached consensus. If creation succeeded
but the local ID was not saved, recover the account/topic ID from the transaction
and set the corresponding `.env` value, retaining its original key. These scripts
are conservative provisioning utilities, not the durable M5 outbox implementation.

A `.env.provision.lock` prevents simultaneous commands. Normal completion and
handled errors remove it. After a killed process, confirm that no provisioning
command is still running and reconcile pending transactions before manually
removing a stale lock. Do not run separate copies of the inventory concurrently.

The scripts fill `X402_PAY_TO_ACCOUNT_ID` from provider A only if it is empty,
and save `HCS_AUDIT_TOPIC_ID` after successful topic creation. The public-submit
HCS topic supports the independent lender hooks planned in M5; messages still
require provenance checks before being treated as audit evidence.

## Tests

```sh
pnpm typecheck:scripts
pnpm test:scripts
```

Both checks are included in the root `pnpm typecheck` / `pnpm test` commands.
Network operations run only through the explicit commands above.
