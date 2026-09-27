# Advancing-chain authority

`readIdentityContinuity` is a read-only adapter for the pinned local reference
Identity Registry. It returns `unchanged`, `changed`, or `unknown` over explicit
owner/URI snapshots. It does not change the pure interaction or historical
feedback verifiers, prove when signatures existed, or establish finality.

The configured domain includes chain ID, registry, block-zero genesis hash, and
a known implementation address and runtime-code hash. The owned deployment
helper `deployRegistryWithDomain` captures these from its own pinned-artifact
deployment, not an Index candidate or first-seen arbitrary runtime. The existing
`deployRegistry` address-returning API is preserved. This local reference model
is not generic proxy, Safe, wallet, or public-chain support.

The reader checks numbered canonical bounds and the locked OpenZeppelin ERC-1967
implementation slot/code at both ends. An unknown basis implementation is always
unknown. It scans only `(basis, current]` in chunks of at most 64 blocks for this
subject's `URIUpdated` and ERC-721 `Transfer`, plus registry-wide `Upgraded`.
Any such event—including same-URI, self-transfer, or away-and-back changes—means
changed. A canonical upgrade from a known basis means changed even if the new
implementation is unfamiliar. An unexpected implementation without that event
is unknown. Metadata, agentWallet, approvals and admin ownership do not themselves
declare City's runtime signer; their URI/transfer/upgrade effects remain covered.

The maximum configured interval is 4096 blocks and 1024 matching logs. The reader
checks raw returned log filters, coordinates, removed flags and numbered hashes,
deduplicates block reads, and rechecks both interval bounds. Missing/failed chunks,
malformed logs, limits, unavailable history and reorganizations return unknown.
Reads have a five-second per-operation and ten-second total continuity deadline.
Fixture and verifier HTTP transports cap streamed responses at 512 KiB before
JSON decoding and refuse redirects; custom callers must also use a bounded
transport (the exported `boundedRpcFetch` is available).

**Source assumption:** unchanged assumes the configured RPC returned every
matching log in each requested range. Ordinary RPC cannot detect silently omitted
events or prove its own completeness. Equal endpoints alone are insufficient.
No history is promoted to cryptographic proof or independent signature existence.

## Feedback authority epoch

`readIdentityFeedbackEpoch` is a separate ranking-scoped observation over
`(basis, observation]`. Unlike the live reader, it reads both numbered owner/URI
boundaries itself. It decodes the basis registration, requires the selected
agent locator, active authorization and `ownerAtPublication`, then projects the
ordered URI, transfer and upgrade events against the independently read final
owner and exact URI. Callers do not supply owner or URI snapshots to this API.

A valid URI update is neutral when it keeps the tracked ERC-721 owner, runtime
`receiptSigner` and active authorization. This permits declaration-level endpoint,
card-digest and revision migration; the reader does not fetch intermediate cards
or carry endpoint/card-specific admissions forward. Any transfer (including
self-transfer or away-and-back), runtime signer replacement, or `active: false`
permanently returns `retired`, even if later declarations restore the original
values. Approved operators may publish URI updates because `updatedBy` is not
the authority owner. The first retirement coordinate is retained as diagnostic
evidence.

An upgrade, malformed or stale-owner intermediate registration, contradictory
event, missing chunk, exceeded bound, unsupported implementation, final-state
disagreement or reorganization returns `unknown`. Unknown outranks a provisional
retirement while retaining its `firstBreak`. URI event data and both boundary
`tokenURI` returns are checked as exact ABI bytes before use: at most 64 KiB,
canonical padding and no suffix, fatal UTF-8 decoding without stripping a BOM,
followed by the existing strict 32 KiB registration codec. Each boundary header
must match its expected number and hash before any owner or URI state call is
dispatched. Every boundary RPC is independently guarded by the captured
cancellation signal and invocation deadline, so a returned cancellation or
deadline cannot start later snapshot work. Genesis, both boundaries and every
referenced event block are rechecked. The same 4096-block, 1024-log,
64-block-chunk and ten-second invocation bounds apply.

The epoch reader accepts a supplied `PublicClient`; ranking composition must give
that client the existing borrowed shared-lane bounded transport. The outer batch
owns physical cancellation and aggregate call/byte/deadline limits. The result is
`rpc-derived-not-state-proof`: it assumes complete RPC log responses and does not
prove historical signature existence, card validity, endpoint liveness, service
quality, current City eligibility, or finality. Existing `readIdentityContinuity`
semantics remain intentionally stricter for live journeys: every URI edit still
returns `changed`, including an otherwise neutral endpoint-only migration.

Journey verification rechecks the exported `currentObservation` at its own
numbered block, then reads latest separately. Successful reports retain both in
`authorityObservations: { exported, latest }`; changed and unknown continuity
stop at `authority-continuity`. Unrelated advancement after export is permitted;
forged exported observations are not. The original signed statement and evidence
formats remain 0.1: no signed fields changed. The report adds observational fields,
and standalone verifier/client configuration now requires genesis and known
implementation values from the separately trusted deployment setup.
