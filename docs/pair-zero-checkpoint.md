# Fresh-pair zero checkpoint

`readFreshPairZeroCheckpoint` is an offline-tested, read-only adapter for the
separate `fresh-pair-zero-v1` evidence kind. It does not produce
`knownDeployment`, `registry-start-confirmed`, a state proof, historical signature
existence, City eligibility, or public-write permission. The
[coverage adapter](reputation-coverage.md#explicit-fresh-pair-checkpoint-path) and
[ranking composer](ranking-evidence.md#explicit-pair-zero-start) consume explicit
raw checkpoint configuration. The existing local activation reader is unchanged.

The caller explicitly supplies a chain/genesis/registry domain, trusted runtime
pins, a pre-registration basis A, registrations and their later profile bases,
the fixed zero basis C, named `(agentId, reviewer)` pairs, and observation B.
Each registration must satisfy `A < registration <= profileBasis <= C <= B`.
Registration mint/Registered receipt coordinates are authenticated separately
from owner, URI and exact AgentCard bytes at the profile basis: the original
Registered URI need not already contain the completed profile.

Both complete proxy runtimes, implementation slots and complete implementation
hashes, owners, versions and Reputation-to-Identity linkage are checked at every
relevant basis. Contiguous Initialized/Upgraded scans cover Identity `(A,B]` and
Reputation `(C,B]`. Any such event is unsupported, including no-op upgrades,
away-and-back in one transaction and standalone reinitialization. The adapter
does not silently move the checkpoint, replace a registry, fall back to latest,
or accommodate migrations.

For each exact pair, the getter and complete 32-byte raw `_lastIndex` word must
agree and equal zero at C. The namespaced mapping uses two **padded ABI** hashes,
not packed encoding, at base
`0xa03d7693f2b3746b2d03f163c788147b71aa82854399a21fdf4de143ba778301`.
At B, getter/raw equality establishes N; exactly one authenticated post-C
publication must cover each index 1..N in block/transaction/log order. Transactions
may route through another sender; the event reviewer is not inferred from
`transaction.from`. Complete receipt coordinates are checked, including logs
other than the selected event. The raw slot reader supplies exact projection and
current revocation findings. Revocation is a B-storage observation, not a claim
that a separate revocation transaction was authenticated.

Revoked, non-City and missing-document slots all remain covered. No documents,
cards, private supporting bundles, legacy client lists or response metadata are
fetched. Supplied card bytes are used only for the registration-profile check and
are not included in the returned finding or ledger. N=0 qualifies only the named
pair's empty post-C history. Genesis and every referenced numbered hash are
re-read without cache before success. Missing state/log chunks, failed final
reads, changed hashes, removed logs, inconsistent coordinates and exhausted
budgets cannot produce qualified pairs.

## Trusted pins are configuration, not discovered authority

The only proxy behavior supported by this mode is the reviewed **complete**
130-byte runtime pinned in the adapter, Keccak-256
`0xd0e45b1d89fa9b6cc7e97c1f155d64180e5c232aaccf9900ef9d4fd738c02b41`.
Changing compiler metadata still changes the full runtime pin. Both attempted
proxy full source-build comparisons remain false; findings always retain
`proxyFullBuildMatch: false` and `proxyQualification: exact-byte-behavior-reviewed`.
This behavioral review is not original deployment or storage-history evidence.

Implementation pins are caller-configured, not hardcoded Sepolia defaults. A
matching caller-supplied hash does not itself prove the source build. Never obtain
these trusted pins from an Index, candidate profile or provider response. A
production caller must independently configure the reviewed complete runtimes,
implementation addresses, source-build identifiers and proxy review identifier.
The reviewed implementation reference uses
`erc-8004/erc-8004-contracts@b9e466c250744a7e06b13dff9d3c2844ed64f825`, Solidity
`0.8.24+commit.e11b9ed9`, OZ 5.4.0, Shanghai, optimizer 200 and viaIR, retaining
metadata and the build's verified immutable-address substitutions:

| Pin | Identity | Reputation |
| --- | --- | --- |
| Implementation | `0x7274e874ca62410a93bd8bf61c69d8045e399c02` | `0x16e0fa7f7c56b9a767e34b192b51f921be31da34` |
| Complete runtime Keccak-256 | `0xa5f9624ea85e45b3f4b8558581f03bfb3e6cefab278d7bf0500ec9bd065dc16f` | `0x38602de97f1bd86f0a4729f7f3c0a78b1d27892e6eb581272cce5504a68fd00b` |
| Compiler-input SHA-256 build identifier | `23f3454a7b6b8aeb9984f4599db6f76bf3cfa20256001025c45526aae3c820a6` | `81315e10e32291f8b0f6941b7cb990a64b9b59187c609aeb8bfb411b7ed72cb1` |

These recorded implementation-build pins are not a fresh chain read. The literal
tests use conspicuously synthetic implementation bytes and build IDs: they test
adapter mechanics, not those Sepolia runtime bytes or archive readiness. Fixed-
fork/archive compatibility and a fresh retained zero checkpoint remain separate
readiness gates. Nothing here authorizes live acquisition or public transactions.

## Acquisition and private evidence

There is no caller-provided `PublicClient`. The adapter owns either a sequential
`literal-fixture` transport or an explicitly configured `bounded-http` source.
HTTP accepts loopback HTTP or HTTPS, uses zero retries, no batches/multicall, a
five-second maximum call timeout, no redirects and no content encoding. There is
no provider failover. Fixture responses are complete JSON-RPC UTF-8 byte arrays,
bounded and copied before awaiting work; method/params and numeric request IDs
must match. Both paths bound and charge wire bytes before JSON decoding. Optional
parent request leases compose with the local call/byte/deadline budget. Cleanup
aborts and drains owned I/O before releasing leases. Only identical immutable
state/transaction requests can be cached; header rechecks always acquire anew.
Every acquired HTTP chunk is charged once to both local and parent accounting,
including the chunk that crosses a byte or capture limit. A local rejection does
not suppress the parent charge. Capture omissions mark the ledger incomplete;
already acquired bytes that fit the local retention bounds can still be retained
when a parent budget rejects the acquisition, without decoding a result.

The return value is `{ finding, ledger }`. The independently serializable finding
contains only evidence references (Keccak-256 of UTF-8 `JSON.stringify([method,
params])` and `JSON.stringify(rawResult)`), not raw RPC replies. The private
ledger contains ordered method/params, request ID, complete acquired UTF-8 replies
and a disposition, including final hash rechecks. A transport failure is distinct
from an absent/invalid result or a JSON-RPC error; partial acquired bodies remain
bounded evidence of failure. No absent result receives an invented result hash.
Ledger exhaustion yields unavailable, never successful coverage with missing
referenced data. `ledger.complete` describes ledger retention, not chain history.

Only references should enter report sidecars. Keeping/exporting the ledger is an
explicit caller action. No provider URL, header, credential, card or supporting
bundle is added to it, but acquired provider replies are **untrusted private
data**, not sanitized public output. A provider may echo sensitive material.
Retained RPC bytes are retained evidence, not a fresh read or a self-authenticating
proof.

All limits apply together and can only be lowered: 4096 inclusive blocks,
64-block chunks, 48 pairs, 32 slots/pair, 512 slots total, 4096 physical RPC calls,
60 seconds total, 5 seconds/call, 8 MiB aggregate response wire, 512 KiB/response,
1024 scanned logs, 256 logs/receipt, 128 KiB decoded receipt data/topics,
64 KiB/log or input, and 32 KiB/code. Request metadata is bounded to 128 KiB/entry
and 2 MiB total; the entire JSON-serialized ledger is bounded to 12 MiB, including
the indexed JSON representation of `Uint8Array` bytes.

Assumptions remain trusted configured pins, truthful canonical RPC data and
complete logs, normal execution without invisible storage editing, and
upgradeable administration. Recording the owner does not prove honesty. The
checkpoint says nothing about pre-C registry meaning or unrelated mappings,
finality, service quality, signature timing or future availability.
