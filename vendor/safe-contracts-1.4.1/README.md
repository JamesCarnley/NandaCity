# Safe 1.4.1 static bundle

Extracted from the public `@safe-global/safe-contracts@1.4.1-2` npm archive.
`provenance.json` records the upstream URL, archive integrity, publisher-reported
Git commit, artifact hashes, compiler input/build-info hashes and source hashes.
The six JSON artifacts are byte-for-byte upstream files. Five support contracts
are deployed; SafeProxy is the factory-created proxy reference. Solidity sources
have not been modified. This is packaging extraction, not a security audit,
independent compiler rebuild, publisher attestation, or legal opinion.

`compiler-input.json` contains all 53 literal source units and the original
Standard JSON compiler settings. Sources and their copyright/SPDX notices can
be extracted from each `sources[path].content` value. Use Solidity
`0.7.6+commit.7338295f` with that Standard JSON input to reproduce compilation;
optimization is disabled. City's separate 0.8.24 compiler is not used here.
The original output-heavy build-info is not duplicated; its archive path and
exact hash are retained in provenance. MultiSend has a 32-byte self-address
immutable at runtime offset 224; runtime verification substitutes only that word.

Safe contributors retain their rights. `LICENSE` is the unchanged upstream
LGPL-3.0 text, and `COPYING` is the accompanying unchanged GPL-3.0 text from
<https://www.gnu.org/licenses/gpl-3.0.txt>. OpenZeppelin MIT source notices remain
in the full input. This directory is not relicensed by City's root MIT license.
Run `npm run safe:vendor:check` for offline byte, source, metadata and notice checks.
