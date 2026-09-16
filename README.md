# NANDA City

NANDA City currently provides an identity foundation for a future city-specialist
agent experience. This repository does **not** yet provide discovery, live chain
reads, invocation, receipts, reputation, a user interface, or a deployed service.

The implemented slice validates an embedded ERC-8004 registration-v1 document,
City's namespaced profile fields, and the selected minimal A2A 0.3 AgentCard
shape. It can then verify those exact profile and card bytes against an authority
snapshot supplied by a caller. Verification is pure: it never fetches a URL or
queries a chain.

## Requirements

- Node.js 24 or newer
- npm

## Setup and checks

```sh
npm ci
npm test
npm run typecheck
npm run build
npm run check
```

`npm run check` runs typechecking, unit tests, and the production build. Generated
files are written to `dist/` and are not committed.

## Identity boundary

- Registration documents are base64 `application/json` data URIs capped at
  32 KiB of decoded bytes.
- AgentCards are capped at 64 KiB and validated only against City's selected A2A
  0.3 subset; this is not a full A2A conformance claim.
- `cardDigest` is Keccak-256 over the exact supplied AgentCard bytes.
- Verification also reports `agentUriDigest` over the exact UTF-8 token URI and
  `registrationDigest` over the exact decoded registration bytes. It never hashes
  a JSON reserialization for these commitments.
- `ownerAtPublication` is checked against `agentOwner` at the supplied block. It
  is a duplicate binding, not an independent source of authority. A profile from
  an earlier owner fails against a later-owner snapshot.
- A successful result describes the supplied historical snapshot. It does not
  claim that an agent is currently owned, live, safe, trusted, or endorsed.

The broader City vision—finding a specialist, invoking it, inspecting provenance,
and leaving portable feedback—remains future work. Chain adapters and signing
schemes are deliberately outside this slice.

## Source layout

- `src/identity/profile.ts`: registration and AgentCard codecs, byte limits, and
  exact-byte digest helper.
- `src/identity/verify.ts`: snapshot-bound, I/O-free profile verification.
- `test/identity/`: complete public fixtures and unit tests for the actual codec
  and verifier.

Licensed under the MIT License.
