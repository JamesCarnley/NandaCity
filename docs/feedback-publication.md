# Local feedback documents and publication

The writer is an owned, disposable **loopback HTTP, chain 31337** fixture using generated
EOAs and the pinned reference Identity/Reputation 2.0.0 registries. It is not a
public-chain publisher, a reputation policy, a document server, or an Index sync.
No personal wallet, paid endpoint, provider permission to review, or live provider
is involved. Acceptance establishes that the provider accepted the request; it
does not give the provider approval over the review's sentiment.
The separate reader accepts an explicitly configured read-only public RPC client;
it does not broaden the local writer's permissions.

## Exact document

`encodeFeedbackDocument(envelope: unknown)` and
`decodeFeedbackDocument(bytes: Uint8Array)` in `src/feedback/document.ts` return
`{ bytes, documentHash, envelope, feedback }`. The document is the existing signed
feedback envelope itself, in exact compact UTF-8 JSON, at most **6 KiB**. The inner
feedback payload retains its existing **4 KiB** limit and fixed rubric/schema.
Unknown properties, duplicate fields, whitespace outside strings, BOM, malformed
Unicode, noncanonical Base64, and alternative JSON number/escape spellings are
rejected, not normalized. Property order is not globally sorted: every accepted
order commits its own original bytes. Decoding preserves a copy of those bytes.

`documentHash` is Keccak-256 of the **entire original document**, including the
envelope signature. `feedback.digest` separately commits the inner signed payload.
Changing only the envelope signature changes the former, not the latter. The
codec validates structure, not signature authority; unsupported envelope methods
can decode but cannot pass publication preflight.

## Prepare, persist, submit

The writer is `src/demo/feedbackPublication.ts`. All operations use object inputs
and exported input/result types. A typical flow is:

```ts
const prepared = await prepareLocalFeedbackPublication({
  publicClient, walletClient, identityRegistry, reputationRegistry,
  document: document.bytes, feedbackURI, allowedDocumentURL,
  originalProfile, request, acceptance, completion,
});
// Persist JSON.stringify(prepared) before any broadcast. No private key is present.
const result = await submitPreparedFeedback({
  publicClient, walletClient: unsignedTransportClient,
  prepared: JSON.parse(savedJSON),
});
```

`originalProfile` is a `ProfileCandidate`: exact original `agentURI` and
`cardBytes`, plus its agent reference. The writer reads the Identity snapshot at
the request's signed `profileBasis.blockNumber`, verifies those exact bytes, then
passes the independently derived profile to the unchanged pure historical
verifier. A caller-typed `VerifiedProfile` alone is not accepted as authority.
Required signatures, reviewer/request-caller linkage, service/registry linkage,
acceptance, original profile binding, and claimed-time consistency must all pass.
A completion claim needs its signed linked completion. A post-deadline
`no-result-observed` review needs no completion, but remains a reviewer claim.
Any supplied completion must also have a valid linked runtime signature.

Both clients must use the same explicit loopback HTTP URL. Preflight checks chain
31337, deployed registries, Identity 2.0.0/ERC-721, Reputation 2.0.0 and its Identity
link. Preparation requires a local undelegated EOA matching the feedback signer,
reviewer and request caller. It checks the contract's current self-feedback rule
(owner/approved operator), but does not require an unchanged original owner,
current original profile, or live provider. The registries can be upgraded;
version/link checks are fixture guards, not remote bytecode attestations.

Contract fields are derived, never accepted as a separate arbitrary score:
feedback `value`, decimals `0`, exact rubric as `tag1`, empty `tag2` and `endpoint`,
the exact URI and full `documentHash`. The URI is at most **2048 UTF-8 bytes** and
must exactly equal the caller-selected `allowedDocumentURL` (including origin,
path and query). Only normalized loopback HTTP URLs without credentials or
fragments are allowed. The writer **never fetches** the URI or AgentCard.

Preparation estimates and signs one EIP-1559 transaction without broadcasting.
The JSON-safe prepared value includes the raw signed bytes, computed transaction
hash, nonce, RPC/domain, action and expected event projection. Publication also
retains the exact document as Base64. Persist it securely: while it contains no
private key, raw signed bytes are broadcast authorization. Serialize a reviewer's
preparations; this module is not a cross-process nonce allocator.

Submission needs no account or private key and never signs. Reloaded data is
strictly validated: a canonical low-s transaction signature is required, and its
recovered sender, chain, destination, zero value, nonce and exact calldata must
match the document/domain/projection.
It checks for an existing receipt before sending. It makes at most three
same-byte broadcast attempts with twenty 100 ms receipt polls per attempt.
Configure bounded HTTP timeouts/retries on the explicit clients; those transport
timeouts add to polling time. Transport retries always carry the same signed
bytes. A lost broadcast reply can recover a mined receipt. Repeated submission
after restart returns the original transaction/event/index, not another review.

`FeedbackSubmissionUnresolvedError` exposes `transactionHash` and either
`nonce-replacement-unresolved` (nonce consumed, or a competing pending nonce with
the original transaction absent) or
`receipt-unresolved`. Retain the original prepared value and reconcile; there is
no automatic fresh-nonce transaction, fee bump, or claim that a timeout means the
write did not happen. A reverted receipt is reported as failure, not resubmitted
as a new operation. Exactly one matching expected registry event is required.

The JSON-safe result contains `receipt`, `event` (address, block/transaction/log
reference, reviewer, agent, feedback index), `payer`, and actual `gasCostWei =
gasUsed * effectiveGasPrice`. These are receipt observations from the supplied
RPC, **not independent canonical feedback read-back** or finality.

## Revocation

`prepareLocalFeedbackRevocation({ publicClient, walletClient,
originalPublication, publicationResult })` verifies the original signed
publication, obtains its actual receipt, compares the supplied receipt/event
reference, and checks the attributed stored record before signing. A third-party
event reference alone is not authority. The original reviewer must sign for the
exact original agent/index; the prepared revocation retains the original
publication/document/result. Submit through the same `submitPreparedFeedback`
mechanism. Resubmitting the same prepared revocation recovers its original
receipt; preparing another revocation for an already-revoked record refuses.
Revocation marks the record; it does not erase the original document or event.

## Independent numbered read-back

`readFeedbackPublication` in `src/feedback/publication.ts` has no writer or signing
dependency. It consumes an explicit public client, full registry domain, event
coordinates, exact retained document bytes (or `null` when unavailable), and a
required numbered observation block:

```ts
const observation = await readFeedbackPublication({
  client,
  domain: { chainId, identityRegistry, reputationRegistry, genesisHash },
  eventRef: { ...result.event, feedbackURI },
  documentBytes: document.bytes,
  observationBlock: selectedBlockNumber, // bigint; never implicit latest
});
```

`genesisHash` is the expected hash of block zero. `eventRef` requires decimal-string
`blockNumber`, `blockHash`, `transactionHash`, numeric `transactionIndex` and
`logIndex`, and the exact expected `feedbackURI`. Extra writer-result fields are
not trusted or used. The feedback signature commits the document contents, **not
the URI**; URI attribution comes from matching the canonical registry event to the
caller-selected expected URI. The reader never fetches that URI or an AgentCard.
Configure bounded timeouts/retries on the client; the reader adds no retries.
Malformed caller coordinates/domain or a missing numbered basis throw; missing
RPC evidence is a returned unavailable finding.

The reader checks RPC chain ID and genesis, receipt success and sender,
destination registry, exact log and its coordinates, and the event's indexed tag.
It compares the document's agent/reviewer/domain/value/rubric/full-envelope hash
with the event, requiring decimals `0` and empty second tag and endpoint. At the
selected observation block it reads Reputation 2.0.0, its Identity Registry link,
Identity 2.0.0/ERC-721, the feedback index bound, and stored value/decimals/tags/
revocation. Owner/profile changes after publication do not erase a record.
Both the publication and observation numbered block hashes are re-read after all
other reads. A later call may still supersede an earlier observation after a reorg.
These checks are RPC-derived consistency evidence, not cryptographic state proofs,
remote bytecode attestation, finality, or independence from the RPC operator.

The JSON-safe result keeps findings separate:

- `publication`: `matched`, `mismatched`, `orphaned`, or `unavailable`. A known
  projection contradiction is mismatched; a different canonical block hash at
  the publication height is orphaned. Missing receipts/state and transport errors
  are unavailable. A changed observation basis invalidates the whole qualification.
- `revocation`: `active`, `revoked`, or `unknown`, specifically for the authenticated
  event's registry tuple at the numbered observation. This can remain known with
  a missing or mismatched supplied document; it never describes signature validity.
  Domain/attribution failures, unavailable state, or changed block bases leave it
  unknown. A later revoked observation does not change an earlier active one.
- `document`: strict decoding, independently checked EOA signature and declared
  signer/reviewer binding, plus exact Base64 bytes, full document hash, inner digest,
  envelope and feedback when decodable. A matching byte commitment can coexist
  with an invalid signature. No universal verified/trusted boolean is returned.
- `source`, `observation`, `event`, `storage`, and `diagnostics`: actual numbered
  block/hash/timestamp, transaction/log order, reviewer/index, full event projection,
  storage and availability diagnostics. Integers that may exceed JavaScript's
  safe range are decimal strings. Retained document findings remain available
  when an event becomes orphaned.

`claimedFeedbackTime` separately flags a feedback `createdAt` later than its
publication block timestamp. A not-after-publication finding does not authenticate
that claimed time. `historicalExistence` and `historicalOrdering` remain `unknown`:
document commitment at a publication block cannot establish that acceptance
signatures existed earlier. The pure historical verifier is unchanged.

## Deliberately separate findings

Signature validity, request/acceptance linkage, original owner-published runtime
authority, on-chain publication, revocation, historical ordering, document
availability and semantic quality are distinct. In particular a feedback
commitment **does not prove the acceptance signature existed earlier**, nor that
the service was good or that a no-result claim was true. Signer-authored times
are chronology claims. Original profile reads are RPC-derived, not state proofs;
the pure verifier still reports historical existence/ordering as unknown and
publication/revocation as unevaluated.

Neither module publishes evidence artifacts, ensures URI availability, proves
independent customers, resists Sybils, ranks services, establishes economic finality,
or retains a durable chain after the owned Anvil is stopped. Two-Index retention,
reorg reconciliation, and second-client replay remain separate work.
