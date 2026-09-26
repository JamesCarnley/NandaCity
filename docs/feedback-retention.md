# Local feedback retention proof

This is a runnable synthetic loss drill, not a public deployment or a ranking
adapter. Index retains bounded opaque bytes; City separately checks their signed
meaning, original interaction links and chain publication.

## Run

Use Node 24+, Anvil 1.7.1 and a local Docker Unix socket. Prepare a clean checkout
of [the public Index source](https://github.com/JamesCarnley/nanda-index-v2/tree/416954077d408ab4de1e096414f004f02ee8ff10)
at `416954077d408ab4de1e096414f004f02ee8ff10`, with `npm ci` in its `server/` directory.
City rebuilds that exact source before starting either Index.

```sh
npm ci
npm run demo:feedback -- --index-checkout /absolute/path/to/nanda-index-v2
npm run demo:feedback -- --index-checkout /absolute/path/to/nanda-index-v2 --json
NANDA_INDEX_CHECKOUT=/absolute/path/to/nanda-index-v2 npm run check
```

The command owns its disposable Anvil, six synthetic A2A services, card/document
servers, two Index processes, separate databases and tmpfs PostgreSQL container.
It uses fresh ephemeral keys, not existing wallets or accounts. Normal completion,
startup failure and interruption clean only confirmed owned resources. The
returned loopback origins stop before the report is printed.

## What the drill demonstrates

1. Both Indexes discover the same Chicago specialist. An actual signed A2A request
   triggers its deliberate post-acceptance failure and signed failed completion.
   The provider stops before the caller signs and publishes a value-1 review linked
   to that completion. Acceptance is not provider permission to review.
2. Both databases independently acquire the exact public document from its
   explicitly allowed URL. A second publication about the same synthetic
   interaction is retained as a disposable fork suffix; it is not another sample.
3. Card and document origins stop. Both Indexes restart on their own databases at
   fresh origins; then A stops. Connection refusal is observed before a separate
   Node process reads B and the chain. It independently checks public bytes,
   publication, current revocation and original supporting evidence. A separate
   missing-bundle check preserves incomplete interaction evidence.
4. The chain reverts the suffix and mines conflicting replacement blocks through
   the old checkpoint. B replays and re-adopts the unchanged prefix. The suffix
   event and bytes remain retained with withdrawn/orphaned Index qualification;
   the reader separately observes the numbered-block conflict. Revoking the
   surviving review changes its status without deleting its bytes.
5. B stops. Only A's exact owned database is rebuilt while every configured byte
   origin remains down. A recovers the surviving chain commitment and revocation,
   but its document bytes remain unavailable. B's offline database is not claimed
   destroyed. No database copy or parent-memory seeding is used.

## Read boundaries

`src/feedback/indexClient.ts` reads only one exact caller-selected
`http://127.0.0.1:PORT` origin, using direct HTTP without proxy inheritance,
redirects, credentials or event-URI fetching. Its local source/event ID and raw
ABI decoders validate Index references; they do not turn the Index into authority.
uint256 and uint64 fields remain decimal strings. Unsupported historical-reader
coordinates are reported explicitly rather than rounded.

Acquisition limits are 5 seconds per body, 2 MiB per JSON response, 6 KiB per
document, 20 pages, 1,000 events, 8 MiB total HTTP payload and 30 seconds overall.
Limits apply while reading. Cursor cycles, changed source/generation/page basis,
truncated responses and digest mismatches fail the acquisition. Reaching a limit
does not establish complete history or absence of other feedback. Coverage and
membership remain **Index-reported**; exact-byte Keccak is independently checked.
Each history page retains its own coverage and event IDs in `historyPages`;
top-level coverage belongs to the later selected-event read. A re-adopted event
may therefore have different memberships at those explicit observations. The
frozen pagination boundary does not freeze live chain membership or merge those
observations into one snapshot.

The child historical verifier receives selected public configuration, event ID,
expected document commitment and numbered observation hash, plus an optional
caller-private bundle file. It receives no parent verdict, public document bytes,
database access or keys. It fetches public evidence from its selected Index and
uses the existing RPC-derived historical reader. The reader does not contact the
vanished provider, card origin or document URI, and does not require current
provider ownership or a still-live request deadline.

Supporting request, acceptance, optional completion and exact original card bytes
are kept separately in an exclusive 0600 regular file in an owned 0700 directory.
Descriptor reads enforce 128 KiB, no symlinks/hardlinks, ownership/mode and
before/after identity/change checks, then the existing strict bundle codec.
The file and directory are removed after the reader closes, including interruption.
Neither the private file path nor its contents appear in public reports/errors.
There is no answer or full A2A task upload to Index.

## Qualifications

Separate processes and databases on one host are not separate operators or
physical failure domains. The reviewer and service are synthetic fixture actors.
Signature validity and a failed signed completion do not establish service quality,
honesty, independent customers or Sybil resistance. This command neither ranks
services nor proves all reviews were found.

Publication and original authority are numbered, RPC-derived observations, not
state proofs or finality. Signer-claimed creation times still do not establish
historical signature existence. The follower starts from a known pre-deployment
lower bound, not an asserted exact proxy activation block. The fixture preserves
its random genesis ownership marker in the past and aligns block one with wall
UTC before deploying registries; signed chronology checks are not weakened.

The ephemeral chain stops during cleanup, so exported JSON is a record of this
run, not a durable independent RPC source. Real private-evidence distribution,
public document hosting, broader URL policies and public-chain spending require
separate decisions. See [feedback publication](feedback-publication.md),
[interaction format](interaction-format.md) and the separate
[pure reputation policy](reputation-policy.md).
