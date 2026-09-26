# Pure explained usefulness policy

`calculatePolicy(input)` in `src/reputation/policy.ts` is a synchronous, bounded
calculator over explicit findings. It has no HTTP, chain, clock, filesystem,
wallet, Index, or Town adapter. Its literal tests are arithmetic and policy
vectors, **not evidence of cryptographic verification or deployed reputation**.

The algorithm is `city-usefulness` version `0.1`. The caller separately names
and versions the reviewer/curator/evaluator configuration. Both are returned.
Changing that configuration can change the result; no universal trust score,
independent people, semantic quality, liveness, or invocation safety is implied.

## Input contract

`PolicyInput` is exported for TypeScript callers. `calculatePolicy` accepts
`unknown`, validates and copies it, and throws on malformed or contradictory
input. All fields are required. Unknown fields are rejected at every level.
Outputs contain references, bounded findings and score factors, not private
requests, preferences, answers, or supporting bundles.

| Field | Meaning |
| --- | --- |
| `policy` | ID/version, accepted reviewer keys, explicit groups, curator keys and evaluator keys. Every reviewer must be in exactly one nonempty group, including singleton groups. Duplicate members/assignments/group keys reject. |
| `scope` | Exact city, task and rubric. No case folding or cross-namespace identity inference. |
| `observation` | Explicit ID, registry/domain key, canonical-order block number, Unix-second timestamp, time basis and provenance. No implicit latest block or current clock. |
| `candidates` | Exact service key, city/task, current profile finding, endpoint/card binding and history coverage finding. |
| `reviews` | One attributed publication observation per unique evidence ID: document digest, service/reviewer/interaction, city/task/rubric, rating, checks, authority-epoch finding, provenance, and publication findings. Keep aged, revoked and retired history. |
| `admissions` | Curator inclusions or scoped test findings, each with unique evidence ID, issuer, service/city/task, status and provenance. Tests additionally bind the current endpoint and exact card digest. |

Opaque keys are 1–160 ASCII characters, starting with an alphanumeric and then
using alphanumerics or `._:/@+-`. They are caller-canonical, case-sensitive
identifiers, never fetched URLs. Digests are lowercase `0x` plus 64 hex digits;
the adapter establishes their exact-byte meaning. The calculator does not hash
or compare original documents. Block numbers are canonical unsigned decimal
uint256 strings. Transaction/log indices are uint32 numbers. Timestamps are
whole Unix seconds from zero through `253402300799`. Ratings are integers 1–5.

In particular, the `endpoint` fields are exact **endpoint-binding keys**, not
arbitrary endpoint URL strings. An adapter derives the same bounded binding key
(for example, a namespaced digest) from the exact URL bytes for both profile and
test evidence. It must not normalize, truncate, or discard query/percent-escape
bytes to fit the key grammar. This calculator compares those keys only; it does
not parse arbitrary URLs or establish their binding to an original profile.

The structural limits are 64 candidates, 2,048 review publication observations,
512 admission observations, and 256 entries per policy role/group list. Every
accepted reviewer has exactly one group, so there are at most 256 assignments.
The whole input is also limited to 2 MiB serialized UTF-8, counted incrementally
while copying (including escaped keys/strings, punctuation and numbers), without
first allocating a whole-input serialization. Additional limits are 100,000 JSON nodes,
depth 12, 40 fields per object and 4,096 characters per string before schema
validation. Overflow rejects; it never truncates evidence into apparent coverage.
Only ordinary JSON-shaped values are supported: no accessors, custom prototypes,
cycles, sparse arrays, hidden/symbol fields, functions, bigint, undefined or
nonfinite numbers. Inputs must be inert data, not executable objects or proxies.

### Findings are not proofs

`supplied` and `adapter-observed` provenance is copied for the observation,
profile, history, every review and every admission. `adapter-observed` is itself
a caller declaration, not something this calculator establishes. The top-level
`qualification` is always `input-findings-not-verified-by-calculator`.

The adapter must establish the feedback, request and acceptance signatures;
all reviewer/caller/service/digest/signer links; original authority; consistent
claimed chronology; and qualifying result evidence. `checks.links: matched`
means **all** those link checks passed, not just that an interaction ID matches.
These are document links, not the separate event-to-document projection.
`signed-completion` and `signed-failure` require valid linked signed result
evidence. `post-deadline-reviewer-claim` permits negative feedback but remains a
reviewer claim, not objective proof that no result existed. Missing supporting
evidence is `unknown`, never an invented valid check or a known invalid signature.

Unavailable reviewer, interaction, scope or rating metadata is represented by
`null` together with unknown checks. Null with entirely valid document checks
rejects as contradictory. Known wrong scope, invalid checks or unaccepted
reviewers have no numeric weight. Unknown metadata remains potentially relevant.

Each publication also requires `projection: matched | mismatched | unknown`.
`matched` represents an adapter-established binding from the exact document
bytes/hash to the authenticated raw event and configured domain, client/reviewer,
agent ID, value, valueDecimals, tag1/rubric, tag2 and endpoint under the existing
City publication projection rules. A canonical event from an unrelated client
can copy a valid document digest without matching that projection. Keep the
document's true identities and signature/link findings unchanged; mark the
publication's projection mismatched. Projection is not a result/quality finding,
proof of signature existence, or an authority upgrade by this calculator.

The adapter separately qualifies canonical publication, current revocation and
authority epoch at the selected observation. Epoch `same` means the same
uninterrupted owner/runtime-signer epoch, not merely equal start/end keys. Endpoint
migration can preserve that epoch; retirement, transfer, including away-and-back
transitions, cannot be inferred away by this calculator. Historical signature
ordering remains `unknown`. Signed dates do not prove pre-retirement existence.

`history` must cover canonical publication **and revocation**, from the declared
registry deployment/start block through the exact observation ID. A complete
finding requires `start: registry-start-confirmed`; `unproven`, partial, unavailable
or wrong-observation coverage withholds qualified rank. A claimed confirmed start
after an included canonical publication is contradictory and rejects. This
coverage requirement is independent of the 90-day scoring window. An adapter must
not retrieve only recent publications and call the resulting history complete.

## Selection and exact arithmetic

1. Exclude wrong service/scope/domain, unaccepted reviewers, known invalid checks,
   noncanonical or projection-mismatched publications, post-observation blocks
   and future publication times.
2. Group identical document digests. Their earliest canonical publication in the
   matching domain anchors age and revision order. Later identical publications
   neither add weight nor refresh age nor undo that anchor's revocation. Unknown
   earlier canonicality or projection leaves the first anchor unresolved; a known
   mismatched event cannot anchor or poison a correctly projected publication of
   the same document. Contradictory document
   metadata/checks/epoch or findings for one publication reject, rather than choosing
   whichever duplicate arrived first. Per-observation provenance may differ.
3. For each reviewer/service/interaction, choose the latest distinct valid document
   by its first-anchor block, transaction index, log index, then digest. This is a
   latest-published-revision rule, not truth or an inference of reviewer intent.
   A missing potentially later revision suppresses earlier positive fallback.
4. Only after revision selection, exclude revocation, retired authority, and age
   greater than 90 days. The exact 90-day boundary is included. A revoked latest
   revision cannot revive its own predecessor. Revocation can allow an older,
   **different** interaction into the sample. Unresolved relevant revocation/epoch
   withholds a qualified score.
5. Take each reviewer's three latest qualifying interactions for the service,
   average their ratings, then average contributing reviewer means in each declared
   group. Each group contributes once, regardless of its number of accepted keys.
6. For group means `r` and group count `g`, use `(6 + sum(r)) / (2 + g)`.
   Zero contributions produces `null`, never an automatic score of 3.

Every score and intermediate mean is a reduced exact rational with decimal-string
`numerator` and `denominator`. For example, one group rating 5 gives `11/3`;
groups rating 5 and 1 give `3/1`; groups rating 5, 1 and 4 give `16/5`.
No rounded stars participate in ordering. Presentation layers may render them.

Unknown document/first-anchor findings are conservatively unresolved even when
their supplied order appears earlier than another revision: uncertain findings
are not proof that omitted negative history is irrelevant. Provisional arithmetic
over other eligible known inputs may be shown in `provisionalScore`, but `score`
is null and the candidate cannot enter the qualified rated/newcomer lists.
Unknown later duplicates of an already known first anchor do not replace it.

## Candidate views and explanations

A relevant valid current profile is necessary for Recommended admission. A
valid inclusion from a named curator **or** an accepted scoped test from a named
evaluator then admits the candidate. Test `status: valid` is an adapter finding
covering authenticity, accepted test profile, coverage and freshness at the
observation. Endpoint and exact card must still match the current profile.
This module does not implement Town signature or cross-language JSON verification.
Admission never increases a review score.

Qualified admitted candidates with scores rank by exact score descending,
contributing group count descending, then stable service key ascending. The
`selection` object separates `rated`, ordinary unrated `newcomers`, `unassessed`,
`unresolved`, `explore`, and `excluded`. Newcomers never silently displace a
poor rated candidate. Valid profiles without accepted admission remain Explore;
invalid, inactive, unknown or irrelevant profiles are excluded. `profileEligible`
and `admitted` are policy findings only, not authority to invoke any service.

`prior-history-excluded` persists for otherwise-valid accepted-reviewer retired
history and negative **selected** revisions excluded by age or revocation.
Negative means 1–2 for this policy. Superseded negative corrections and normal
sample-cap exclusions alone do not create that warning. Invalid, wrong-scope and
unknown-wallet spam cannot create it. With no current contribution the additional
warning is `current-score-unassessed`, not a pristine newcomer label. Valid new
current reviews can establish a score alongside the prior-history warning.

Every review/admission ID has an explicit reason. Candidate explanations preserve
publication positions/time, anchor references, findings, attribution and
provenance; contributing groups list their exact evidence IDs and means.
Superseded, duplicate, capped and rejected IDs remain visible. Failed/partial
retrieval is `history-unresolved`, never evidence of zero reviews. Canonical sorting
and copied JSON-safe data permit deterministic serialized recomputation in a
separate process. That is calculation reproducibility, not independent evidence
retrieval, independent operator custody or a cryptographic history proof.
