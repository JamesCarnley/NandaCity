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

Journey verification rechecks the exported `currentObservation` at its own
numbered block, then reads latest separately. Successful reports retain both in
`authorityObservations: { exported, latest }`; changed and unknown continuity
stop at `authority-continuity`. Unrelated advancement after export is permitted;
forged exported observations are not. The original signed statement and evidence
formats remain 0.1: no signed fields changed. The report adds observational fields,
and standalone verifier/client configuration now requires genesis and known
implementation values from the separately trusted deployment setup.
