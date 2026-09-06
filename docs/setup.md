# Testnet setup

This guide covers A0.1: account provisioning and local configuration. Hedera
adapters, operational scripts and the Blocky402 smoke test follow in A0.2–A0.4.
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
accounts with the A0.3 account-creation script once A0.2 is available. No such
script is implemented by A0.1; do not mark provisioning complete until all six
accounts exist. This avoids assuming six portal accounts are available per login.

| Role | Account ID variable | Private key destination |
| --- | --- | --- |
| Operator | `HEDERA_OPERATOR_ID` | `HEDERA_OPERATOR_PRIVATE_KEY`; provisioning and operator scripts |
| Consumer | `CONSUMER_ACCOUNT_ID` | `CONSUMER_PRIVATE_KEY`; restricted signer only |
| Lender A | `LENDER_A_ACCOUNT_ID` | `LENDER_A_PRIVATE_KEY`; lender A process only |
| Lender B | `LENDER_B_ACCOUNT_ID` | `LENDER_B_PRIVATE_KEY`; lender B process only |
| Provider A | `PROVIDER_A_ACCOUNT_ID` | Keep offline locally; scan service only needs the payTo ID |
| Provider B | `PROVIDER_B_ACCOUNT_ID` | Keep offline locally; scan service only needs the payTo ID |

Keep provider recovery keys in a local password manager; no provider private-key
variable is required by the application. A provider's callback credential is a
separate service secret, not its Hedera private key. Use ECDSA private-key material,
not a mnemonic or an Ed25519 key, for the four configured signing accounts.

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

## Completion checklist

- [ ] Six distinct numeric testnet IDs are mapped to the roles above.
- [ ] All six accounts use ECDSA keys and have confirmed testnet funding.
- [ ] Four signing keys are stored locally and isolated by process ownership.
- [ ] Provider IDs and x402/ZK settings are filled without committing secrets.
- [ ] A0.3 balance verification is recorded before merging F02.

This guide and template do not certify that accounts have already been created
or funded. Network validation remains pending until the public account checks
and subsequent A0.3/A0.4 verification succeed.


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
  and its exact SDK dependency (checked with the registry command above).
- [Official Hiero JavaScript SDK source](https://github.com/hiero-ledger/hiero-sdk-js)
  (implementation checked against installed `2.85.0`).
- [Mirror topic-message REST API](https://docs.hedera.com/api-reference/topics/list-topic-messages-by-id).

See `docs/decisions.md` for the upstream protobuf peer warning; the SDK version
is deliberately kept aligned with x402.

### Recorded A0.2 testnet result

On 2026-09-06, the explicit integration test passed with a `SUCCESS` receipt for
1 tinybar operator → consumer:
[HashScan transaction](https://hashscan.io/testnet/transaction/0.0.10388631@1788723073.132973278).
This verifies the transfer adapter on testnet; topic adapters currently have
mocked SDK coverage, and Blocky402 settlement remains A0.4.
