# Testnet setup

This guide covers F02 (A0.1–A0.4): local configuration, Hedera adapters,
account/topic provisioning and the Blocky402 settlement smoke test.
Use disposable, low-balance **testnet** accounts only. Never reuse mainnet keys.

## Create the local configuration

From the repository root, copy the template only if `.env` does not already exist:

```sh
cp -n .env.example .env
chmod 600 .env
```

Fill values in a local editor. `.env` is ignored by Git; `.env.example` contains
placeholders only. Do not paste keys into issues, PRs, chat, terminal commands or
logs. Existing `.env` files must be updated manually with new template variables.

The root `.env` is a local provisioning inventory, not an environment to inject
wholesale into every service. Service launch configuration must pass only the
credentials each process needs. The consumer/orchestrator must never receive the
consumer private key.

## Provision six distinct ECDSA accounts

Open the [Hedera developer portal](https://portal.hedera.com/), sign up or sign in,
and select **testnet**. Create an account with **ECDSA / secp256k1** keys for the
operator. Record its numeric account ID (`0.0.…`) and private key locally. An EVM
address or public-key alias is not a substitute for the numeric ID in Koven.

Prepare a separate ECDSA account/key pair for each remaining role. Do not reuse
the operator account for another role. Portal account limits may prevent creating
all six there: in that case bootstrap the operator now, then create the remaining
accounts with `scripts/hedera-create-accounts.ts`. Do not mark provisioning
complete until all six accounts exist.

| Role | Account ID variable | Private key destination |
| --- | --- | --- |
| Operator | `HEDERA_OPERATOR_ID` | `HEDERA_OPERATOR_PRIVATE_KEY`; provisioning and operator scripts |
| Consumer | `CONSUMER_ACCOUNT_ID` | `CONSUMER_PRIVATE_KEY`; restricted signer in the application, also used by the explicit A0.4 diagnostic |
| Lender A | `LENDER_A_ACCOUNT_ID` | `LENDER_A_PRIVATE_KEY`; lender A process only |
| Lender B | `LENDER_B_ACCOUNT_ID` | `LENDER_B_PRIVATE_KEY`; lender B process only |
| Provider A | `PROVIDER_A_ACCOUNT_ID` | Keep offline locally; scan service only needs the payTo ID |
| Provider B | `PROVIDER_B_ACCOUNT_ID` | Keep offline locally; scan service only needs the payTo ID |

For script-created providers, keep recovery keys in the local `.env` entries
`PROVIDER_A_PRIVATE_KEY` / `PROVIDER_B_PRIVATE_KEY`; these are provisioning-only
values and must not be passed to scan services. Back them up privately. A
provider's callback credential is a separate service secret, not its Hedera key.
Use ECDSA private-key material for the four configured signing accounts.

## Fund and record the accounts

Use the portal's testnet refill or [testnet faucet](https://portal.hedera.com/faucet)
for each existing account, subject to the displayed limits and cooldowns. The
faucet funds an account; it does not replace account creation. If a refill is
unavailable, wait for its cooldown or use the operator funding script in A0.3.
Only request test HBAR; keep balances limited to development needs.

Record all six public IDs in your local `.env`. Check each account's testnet
explorer page and balance. Do not assume a successful faucet submission proves
funding has reached consensus. Before merging F02, A0.3 must verify all six funded
accounts with `scripts/hedera-balances.ts`; attach public IDs/links and verification
results to the PR, never keys. Testnet resets may require reprovisioning.

Hedera documents portal refills, faucet funding and account reset behavior in its
[portal and faucet announcement](https://hedera.com/blog/introducing-a-new-testnet-faucet-and-hedera-portal-changes/).
Follow current portal limits rather than hardcoding the announcement's quotas.

## Payment and proof configuration

The template fixes:

```dotenv
HEDERA_NETWORK=testnet
HEDERA_MIRROR_NODE_URL=https://testnet.mirrornode.hedera.com
X402_NETWORK=hedera:testnet
X402_ASSET=0.0.0
X402_FACILITATOR_URL=https://api.testnet.blocky402.com
ZK_ARTIFACTS_DIR=./packages/zk-policy/artifacts
ZK_CIRCUIT_ID=koven-policy-v1
```

`0.0.0` identifies HBAR in the payment requirements; amounts are decimal tinybar
strings (1 HBAR = 100,000,000 tinybars). Set `X402_PAY_TO_ACCOUNT_ID` to the same
numeric ID as `PROVIDER_A_ACCOUNT_ID` for the initial single-provider deployment.
Do not put a shell-variable reference into the value: environment expansion is
not assumed. The second provider will use its own payTo in M4.

The facilitator fee payer is read from `/supported` and validated at runtime in
A0.4; it must not be pinned in `.env`. Leave `HCS_AUDIT_TOPIC_ID` empty until A0.3
creates the topic. ZK artifacts are produced/pinned in A1; the directory setting
alone does not mean a proof bundle or verification key exists. Mission roots and
caps come from trusted policy provisioning, not invented setup values.

## Checklist for a new local setup

- [ ] Six distinct numeric testnet IDs are mapped to the roles above.
- [ ] All six accounts use ECDSA keys and have confirmed testnet funding.
- [ ] Four signing keys are stored locally and isolated by process ownership.
- [ ] Provider IDs and x402/ZK settings are filled without committing secrets.
- [ ] A0.3 balance verification is recorded before merging F02.

Complete this checklist for each new environment. The recorded results below
describe the verified development accounts; another clone needs its own keys.


## A0.2 adapter verification

Implemented APIs are exported by `@koven/hedera`: `createClient`,
`getBalanceTinybar`, `transferHbar`, `createTopic`, `submitTopicMessage`,
`getTopicMessages`, and `explorerUrl`, plus shared SDK primitives. Always close
clients in `finally`. Pass the three operator environment fields explicitly to
`createClient`; it refuses any network other than testnet.

Offline checks from the repository root:

```sh
pnpm --filter @koven/hedera typecheck
pnpm --filter @koven/hedera test
```

The explicit integration check loads root `.env` (Node 20.6+ for `--env-file`),
checks the configured operator public key against the existing account, and sends
**1 tinybar operator → consumer**, plus normal testnet network fees:

```sh
pnpm --filter @koven/hedera test:integration
```

It requires `HEDERA_NETWORK`, `HEDERA_OPERATOR_ID`,
`HEDERA_OPERATOR_PRIVATE_KEY`, and `CONSUMER_ACCOUNT_ID`; the consumer private key
is not needed. It prints a public HashScan link after a `SUCCESS` receipt. The
command creates a real new transaction each run. If submission becomes uncertain,
reconcile its account history before retrying; this helper is not the durable
repayment/outbox implementation planned in later milestones.

For mirror reads, pass `{ mirrorNodeUrl: HEDERA_MIRROR_NODE_URL }` explicitly.
`getTopicMessages` reads one ascending page (25 messages by default, maximum 100).
Pass the last result's `sequenceNumber` as `afterSequenceNumber` to read the next
page. Payloads remain base64 and are not yet trusted audit events. Multi-chunk
messages and JSON integers beyond JavaScript's safe range are rejected explicitly.

Primary references:

- [Published x402 Hedera package](https://www.npmjs.com/package/@x402/hedera)
  and its exact SDK dependency (checked with
  `pnpm view @x402/hedera@2.24.0 dependencies --json`).
- [Official Hiero JavaScript SDK source](https://github.com/hiero-ledger/hiero-sdk-js)
  (implementation checked against installed `2.85.0`).
- [Mirror topic-message REST API](https://docs.hedera.com/api-reference/topics/list-topic-messages-by-id).

See `docs/decisions.md` for the upstream protobuf peer warning; the SDK version
is deliberately kept aligned with x402.

### Recorded A0.2 testnet result

On 2026-09-06, the explicit integration test passed with a `SUCCESS` receipt for
1 tinybar operator → consumer:
[HashScan transaction](https://hashscan.io/testnet/transaction/0.0.10388631@1788723073.132973278).
This verifies the transfer adapter on testnet. Topic creation is also exercised
by the A0.3 script below; the package's HCS submission and message-reading
adapters currently have offline coverage. A0.4 settlement evidence follows below.


## A0.3 provisioning commands

See [the scripts guide](../scripts/README.md) for arguments, transaction journals,
locking and recovery. With the operator, consumer and lenders configured:

```sh
pnpm tsx scripts/hedera-create-accounts.ts --role provider-a --initial-tinybar 100000000
pnpm tsx scripts/hedera-create-accounts.ts --role provider-b --initial-tinybar 100000000
pnpm tsx scripts/hedera-balances.ts
pnpm tsx scripts/hedera-create-topic.ts
```

Each provider starts with 1 test HBAR from the operator. The scripts save its
key, account ID and transaction reference locally without printing secrets.
The topic ID is also saved in `.env`. To replenish a balance later:

```sh
pnpm tsx scripts/hedera-fund.ts --role provider-a --target-tinybar 100000000
```

This sends only the shortfall, not an additional 1 HBAR each time.

### Recorded A0.3 testnet result

Verified on 2026-09-06. All six accounts exist, use a single ECDSA secp256k1 key,
and have positive balances. These are point-in-time testnet results, not fixed
configuration values for another clone.

| Role | Account ID | Verified balance (tinybar) |
| --- | --- | --- |
| Operator | `0.0.10388631` | `99647373289` |
| Consumer | `0.0.10395759` | `100000000001` |
| Lender A | `0.0.10395803` | `100000000000` |
| Lender B | `0.0.10395927` | `100000000000` |
| Provider A | `0.0.10396537` | `100000001` |
| Provider B | `0.0.10396546` | `100000000` |

Public transaction evidence:

- [Provider A creation, initial 1 HBAR](https://hashscan.io/testnet/transaction/0.0.10388631@1788724281.314160195).
- [Provider B creation, initial 1 HBAR](https://hashscan.io/testnet/transaction/0.0.10388631@1788724321.838683202).
- [Audit topic creation: `0.0.10396556`](https://hashscan.io/testnet/transaction/0.0.10388631@1788724369.039019584).
- [Provider A funding-script test: 1 tinybar](https://hashscan.io/testnet/transaction/0.0.10388631@1788724401.518583150).

Repeated account/topic creation commands recognized the stored IDs and skipped
creation. Repeating the same funding target sent no additional transfer. The
final balance command confirmed all six funded accounts. Keys and provisioning
journal entries remain only in the ignored local `.env`.

### Recorded A0.4 settlement result

The Blocky402 smoke test completed on 2026-09-06 with the advertised exact
Hedera testnet scheme. It read the facilitator fee payer from `/supported`,
created a partially signed HBAR transfer from the consumer, received a valid
response from `/verify`, and settled one payment of `1000000` tinybars to
provider A. The public receipt is the [HashScan transaction](https://hashscan.io/testnet/transaction/0.0.7162784@1788725329.539946918).

Run it explicitly from the repository root:

```sh
pnpm tsx scripts/x402-smoke.ts
```

Without a saved smoke transaction, the command constructs one payment and
checks `/verify` before calling `/settle` once. It records the transaction ID in
`KOVEN_X402_SMOKE_TX_ID` before settlement, with `KOVEN_X402_SMOKE_STATE=pending`.
It checks the returned transaction ID, network and payer, then independently
verifies the successful HBAR transfer and exact amounts through the testnet
mirror. Only then is the state set to `confirmed`.

Reruns with a saved ID perform reconciliation only, including after a timeout.
Mirror visibility can lag; retrying the command later does not send another
payment. Raw signed transaction bytes are neither logged nor saved. A previous
payment made before the journal was introduced can be checked without another
settlement:

```sh
pnpm tsx scripts/x402-smoke.ts --reconcile 0.0.7162784@1788725329.539946918
```

The Blocky402 response uses `transaction` (the x402 v2 field), not
`transactionId`. No facilitator rejection was observed during the successful test.

The consumer paid `1000000` tinybars. The facilitator fee payer paid the network
fee; the operator only pays for the diagnostic account queries. The smoke test
requires the testnet facilitator/mirror URLs shown above and rejects conflicting
network/asset settings. It does not exercise the later scan authorization gate.

API reference: [Blocky402 facilitator endpoints](https://blocky402.com/docs/api-reference/).
