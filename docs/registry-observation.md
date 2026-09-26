# Opaque registry observations

`readRegistryFeedbackObservation` in `src/feedback/registryObservation.ts` is a
read-only observation of **one** raw reference-registry `NewFeedback` slot. It
requires an explicit chain/genesis, Identity/Reputation address pair, exact event
coordinates and a numbered/hash-qualified observation. No City document,
signature, supporting bundle or URI fetch is involved.

The reader checks the receipt and unique selected log, every selected coordinate,
canonical raw ABI encoding, indexed tag hash, reference value/decimal bounds,
registry link/version/interface descriptions, cumulative index and stored tuple.
All storage calls use the observation's numbered block. Source and observation
hashes are rechecked after the other reads. These are RPC-derived consistency
checks, not finality, cryptographic state proofs or known-code provenance.

The output keeps `authenticity` (`matched`, `mismatched`, `orphaned`, `unavailable`)
separate from `revocation` (`active`, `revoked`, `unknown`). A source reorg is
orphaned; a changed observation or unavailable archive is unavailable. Failed
qualification always clears active/revoked to unknown. Retained event/storage
fields are intermediate evidence, not permission to ignore the top-level finding.
Version strings and the identity link are descriptive; an upgradeable lookalike
can return them. They do not prove the reference implementation is active.

Tags, endpoint and URI are **raw hex bytes**, not text. Invalid UTF-8, a BOM, NUL,
and empty slots remain present and byte-exact. There is no optional text projection
to mistake for authority. Agent IDs, feedback indices, values and last indices are
exact decimal strings; unsupported unsafe numeric transaction/log coordinates are
explicitly rejected, never rounded. Non-City or opaque publications remain
inspectable slots without acquiring City eligibility, signature validity, quality,
coverage or scoring weight.

Actual routed contract calls are supported. The selected event's client address
selects the storage tuple, not the outer transaction sender/destination. City's
separate `readFeedbackPublication` is unchanged: it still requires a City document,
direct-to-registry transaction and matching EOA sender. Raw routed authenticity is
not support for contract-signed City feedback.

## Bounded work and caller responsibilities

Optional limits can lower or raise finite defaults only within these hard ceilings:

| Limit | Default | Ceiling |
| --- | ---: | ---: |
| Total elapsed milliseconds | 10,000 | 30,000 |
| Each RPC elapsed milliseconds | 2,000 | 10,000 |
| RPC calls | 16 | 32 |
| Receipt logs | 256 | 4,096 |
| Aggregate receipt log data + topics bytes | 1,048,576 | 8,388,608 |
| Each log data / contract-result ABI bytes | 65,536 | 262,144 |

Log counts and raw payload sizes are checked before ABI decoding; loops and
contract results are bounded too. Receipt byte accounting covers inspected log
data and topics, **not the full HTTP/JSON response**. The supplied `PublicClient`
already parsed the JSON by then. The caller must provide transport response-size,
timeout and retry bounds; transport implementation and credentials stay outside
this module. It must also account for unexpected extra JSON fields and block
transaction arrays before parsing. This reader does not install a transport or
fetch documents.

`signal` cancellation, total deadlines and per-RPC deadlines stop waiting and
prevent new RPC work. Timers and abort listeners are removed on every exit.
Viem's generic `PublicClient.request` does not accept this operation's AbortSignal;
an already-started transport request/retry may continue after this reader returns.
Use a caller-owned cancellable transport if network-level cancellation is needed.
JavaScript synchronous work cannot be preempted: byte/count ceilings bound that
work, with elapsed checks before/after it. Any exhausted bound returns unavailable
with unknown revocation, never a favorable fallback or cached active answer.

Owned-Anvil tests cover real ordinary, opaque and routed publication/revocation,
strict City compatibility, malformed/contradictory RPC boundaries, reorgs, budgets
and cancellation. Run `npm run test:feedback` or the required `npm run check`.
