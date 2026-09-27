# Synthetic HTTPS-origin comparison

Ethereum is City's default authority profile. This opt-in comparison runs one
synthetic Chicago service without a chain, using a temporary local CA and exact
literal-loopback HTTPS allowlists. It is not a deployed service, domain-recovery
system, independent-operator network, or claim about Chicago venues.

```sh
NANDA_INDEX_CHECKOUT=/absolute/path/to/clean/pinned/index npm run demo:origin
```

Use Node 24+, Docker with a local Unix socket, OpenSSL, and the clean Index pin
`b9c6ccef4907c5dc3c7d9d898cf671207166f435` with installed `server/` dependencies.
No Anvil or external enrollment is used by this command. The full City check
still needs its existing Anvil/Town prerequisites. The harness builds the pinned
Index and creates only disposable local credentials and two PostgreSQL databases.
`SMTP_URL=log` keeps synthetic verification local; tokens, private keys and private
interaction/card bytes are never report data. Neither system trust nor global TLS
verification is changed.

## What the comparison proves

Both actual Indexes independently acquire the same caller-owned public archive.
Each also accepts an authenticated synthetic organization declaration through its
normal replacement API. Generic service search yields an **untrusted pointer**;
City directly observes the HTTPS identity profile and card before retrying the
same signed interaction against the shared real A2A runtime. The initial signed
interaction bootstraps the frozen archive before the Indexes start. A positive
review is followed by a distinct negative revision; the selected review is 1/5.

The runtime, card listener and caller archive then stop. Both Index processes
restart against the **same still-running databases**; A stops. A separately spawned
consumer receives only B's origin, a scoped CA, exact allowed URLs, observation
time, frozen snapshot digest, explicit reviewer/group policy and the caller-private
bundle over stdin. It independently recomputes signatures, interaction links,
current identity authority and the retained negative review. The qualified score
is exactly `(6 + 1)/(2 + 1) = 7/3` in both processes. No raw request, answer, card
or private bundle is sent to an Index or printed in the report.

The comparison separately observes unavailable identity and rotated runtime keys:
retained negative history remains inspectable but current qualification and score
are withheld. Rebuilding A with the stopped archive yields unavailable bytes,
not reconstruction from hashes. Owned SIGINT/SIGTERM tests check process,
database-container, temporary TLS and runtime-store cleanup. This is process
restart evidence, **not container/host durability or permanent storage**.

## Evidence and policy boundaries

- `city-origin@0.1` has its own strict envelopes, purpose-specific EIP-712 domain
  and HTTPS service identity. Ethereum decoders and policy inputs remain strict.
- Snapshot `reviewer` is a scalar lowercase nonzero address, matching the released
  Index transport. Envelope signer and feedback/retraction/caller keys remain
  structured `secp256k1-key` references. Snapshot signer must equal reviewer.
- Full signed-document digests identify profile bases, archive slots and
  retraction targets. Request/acceptance/completion links use signed payload
  digests. Private bundles preserve exact signed profile/request/acceptance and
  optional completion bytes plus exact card bytes; no semantic answer replay is
  claimed without retained answer bytes.
- Qualification is `archive-snapshot-qualified`: complete retrieval of one finite,
  reviewer-declared selected sample, never global coverage or a latest head.
  Unseen withheld reviews cannot be detected. Missing early or late slots,
  unavailable potentially relevant variants, truncation and authenticated
  incompatible histories withhold automatic recommendation. Unsigned lookalike
  histories cannot suppress authenticated evidence.
- Order is authenticated selected-snapshot ordinal. Age is
  `reviewer-claimed-record-time`, not independently observed publication age.
  The 90-day window is unchanged. Latest distinct review is selected **before**
  retraction/age suppression; an older favorable revision never resurrects.
  Exact duplicate documents do not refresh order, age or weight.
- At most three eligible interactions contribute per reviewer. Reviewer means
  are averaged within each explicit control group, then scored with the shared
  exact-rational formula `(6 + sum(groupMeans))/(2 + groupCount)`. No groups means
  no score. Unknown reviewer keys carry no weight; every accepted reviewer has
  exactly one named group. The initial archive adapter supports one accepted
  reviewer/service pair; more accepted reviewers require more evidence and are
  unresolved here, not silently treated as empty histories.
- Curator inclusion is explicit consumer policy, never an Index badge. Native
  Town origin testing is `unsupported-not-tested`; endpoint/card changes cannot
  inherit a test pass. Endpoint changes under still-current keys can preserve
  retrospective attribution, not current invocation success.
- `originAuthority.current` and `historicalAuthority` are separate. A retained
  profile signed by still-current controller/runtime keys supplies weaker current
  attribution; it does not prove past TLS service, uninterrupted control, or
  unseen away-and-back key changes. Unavailable or changed keys cannot be repaired
  by an Index mirror. No chain coordinates, epochs or automatic fallback exist.

Both Indexes and the separate consumer still share one host and a synthetic
local trust root. Signatures and retention do not prove usefulness, safety,
independent custody, omission-free reviews or future availability.
