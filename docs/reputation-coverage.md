# Accepted-reviewer publication coverage

`readAcceptedReviewerCoverage` is a read-only, owned-loopback adapter for selected
services and an explicitly accepted reviewer list. It independently verifies the
configured reference deployment, reads `getLastIndex` at one numbered/hash-qualified
observation, and authenticates every immutable publication slot from 1 through N.
Two configured Indexes supply candidate coordinates and public document bytes.
Their synchronization, canonicality and document metadata are assertions, not
authority. A qualified zero requires no working Index or selected event.

This is **RPC-derived evidence under configured deployment pins and complete
upgrade-log assumptions**, not a state/log proof, finality, global review history,
service quality, a score or a Town badge. It performs no writes or event-URI fetches.
Unknown reviewers are not enumerated. The same-host synthetic tests do not prove
independent operators or permanent availability.

## API and findings

```ts
const result = await readAcceptedReviewerCoverage({
  rpcOrigin, provenance, observation: { blockNumber, blockHash },
  agentIds, reviewers,
  indexes: [{ origin: indexA, source: sourceA }, { origin: indexB, source: sourceB }],
  signal,
});
```

Provenance is the exact configuration returned by the owned deployment helper,
not a previously successful activation finding. The adapter calls the independent
activation reader again. Configuration is bounded and copied before awaiting I/O.
Fresh clients use no retries, HTTP or multicall batching, fallback or response
caching. The observation hash is read before counters and after all coverage work.
An unavailable/changed final observation makes the batch unknown.

- `status` and each pair's `status` describe publication-slot coverage only.
  Missing necessary slots, contradictory authenticated coordinates/counters,
  unsupported deployment or required-work exhaustion cannot become empty history.
- `pairs[].slots[].observation` contains the actual opaque registry reader finding,
  including current revocation. Old, revoked, routed, non-City and invalid-text
  entries still occupy slots. Uint coordinates and raw string-slot bytes are
  preserved; unsafe numeric conversions are refused.
- `rows` is the bounded source sidecar. Slots refer to row indexes through
  `sources`, avoiding duplicated row payloads. Rejected, unsupported and unexamined
  assertions remain distinguishable. Unexamined extras are not authenticated facts.
- `acquisitions` records each source's complete/partial/unavailable pagination
  finding and per-page coverage/basis, without duplicating the retained rows.
  Complete acquisition means only successful Index pagination.
- `documents` is a success-only hash cache. Exact Keccak-verified bytes are separate
  from slot coverage. A missing document is unavailable, never implicitly ineligible;
  later City qualification must decide whether those missing bytes are necessary.

Identical authentic copies deduplicate. Independently disproven rows or bad document
copies from A cannot poison complete evidence from B. Each origin has its own
reserved call/byte/page/row pools. A complete good source cancels redundant slow
acquisition/authentication; hash retrieval runs independently across both origins.
Canonical contradictions already observed cannot be resolved by choosing an Index.

## Extracted Index reads

`readIndexFeedbackHistory({ origin, source, agentId, reviewer, signal?, work? })`
does not require a selected event. Each page is committed only after every row,
source, generation, basis, insertion fence and ordering check succeeds. Continuation
cursor validation follows page commit, so an invalid cursor or later failed page
preserves the validated prefix. A partly malformed page contributes no rows.
Invalid caller configuration throws; retrieval failures return bounded diagnostics.
Partial acquisition can still supply all canonical slots, alone or with the other
Index. A genuine remaining slot gap is unknown.

`readIndexFeedbackDocument({ origin, documentHash, signal?, work? })` directly reads
the hash endpoint, returning exact verified bytes or null on 404. It never repeats
history acquisition or follows a URI. Hash failures throw and cannot be cached as
another origin's failure.

The original `readIndexFeedback` remains a strict selected-event wrapper: incomplete
traversal throws, the selected event is reread and checked for drift, and the
document reference/digest is checked. One original 30-second/8MiB budget spans all
its internal calls, with the original 20-page/1,000-row ceilings and return shape.

## One shared work budget

Standalone coverage creates/disposes one `RankingReadBudget`. A composition can
create it once and pass it as the second argument; coverage borrows it and does
not reset or dispose it. The borrowed origin bindings must match exactly.

Future qualification can use the **same live ledger** for current profiles,
historical private-bundle reads and authority intervals, then perform its own final
post-qualification observation recheck and dispose the ledger. That composition
and qualification are not implemented here. A serialized result or snapshot is
not a fresh read or a resumable budget. Private bundle bytes must be charged once
before copy/decode; already charged public documents need no second byte charge.

| Bound | One consumer |
| --- | --- |
| Selection | 6 services, 8 reviewers, 48 pairs; 32 slots/pair, 512 total |
| Acquisition | 8 pages/pair/origin; 96 pages/1,024 rows per origin, 192/2,048 total; 100 rows/page |
| Calls | 8,192: 4,096 shared, 2,048 per origin across Index HTTP **and** candidate RPC |
| Bytes | 32MiB: 8MiB Index HTTP/origin, 4MiB candidate RPC/origin, 8MiB shared RPC/private bundles |
| Responses | 512KiB RPC, 2MiB Index JSON, 64KiB raw event, 6,144 bytes/document; 512 unique documents |
| Time/concurrency | One 120s deadline; at most 5s/request and remaining time; two exchanges total, one per origin across both transports |

These are ceilings, not a promise that a maximal-size input fits remaining work.
The pure calculator's separate 2MiB input limit is not additional network allowance.
Lower total/request deadlines can be set when creating a budget; ceilings cannot
be raised. Source-local exhaustion does not consume another origin's reservation.
HTTP/history exhaustion retains previously validated pages for RPC authentication.
Failed shared required work remains visible even if a nested reader caught its
transport error.

`ReadRequestBudget.open` reserves a permit. The first lease `check()` immediately
before synchronous dispatch charges exactly one call; no await intervenes before
starting I/O. Cancellation after admission but before that check costs zero calls.
Later checks do not recharge; dispatch failures and canceled dispatched requests
still count. Lease `close()` is idempotent and runs only after owned transport
teardown/settlement. Logical reader timeout alone never releases its permit.

Both existing body loops charge actual chunks before retention/JSON parsing,
including error/404 bodies. Content-Length is validated early but is not the byte
counter. Redirects and unexpected compression are refused. An oversized chunk may
arrive before cancellation: the bound concerns admitted bytes/work, not a physical
socket-byte hard cap. Each scoped reader's owned signal is aborted in `finally`,
even on success, and outstanding fetches are settled before returning. This handles
the raw reader's shorter logical timeout without changing any reader API.

Synchronous compilation/decoding cannot be preempted on the JS thread. Before/after
checks reject late results; no compiler cache or subprocess framework is introduced.
`dispose()` cancels only owned queues/I/O and waits for lease teardown.

Run the unit suite with `npm test`. `npm run test:integration` includes real owned
Anvil and two-Index coverage cases; it requires the same Anvil, Docker and clean
pinned `NANDA_INDEX_CHECKOUT` setup as the existing integration suites.
