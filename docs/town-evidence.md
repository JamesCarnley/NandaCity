# Native Town evidence adapter

City can read one narrowly approved, synthetic same-host Nanda Town receipt as
test evidence. The adapter does not turn Town into an accreditation authority,
does not attest answer quality, and does not make receipt contents true.

`readTownEvidence` accepts only a local bundle directory plus an explicitly
pinned Town checkout and Python 3.12.13 virtual-environment entry. It snapshots
the eight native verification files into a City-owned temporary directory,
checks the exact clean Town commit, and invokes the native receipt and bundle
verifiers under one ten-second deadline. It exports only bounded protocol
observations; answer bodies, keys, arbitrary bundle fields, and local paths are
not returned.

The virtual-environment entry path is deliberately retained for invocation.
City separately resolves and validates its executable target, but invoking that
target directly can discard the selected environment's `sys.prefix` and
site-packages. Python still runs with `-I -B`, `PYTHONNOUSERSITE=1`, and a
minimal `PATH`; no inherited `PYTHONPATH` is used.

CI pins the Town source and interpreter, then uses Town's existing editable
installation path. Town does not yet publish a dependency lock, so this bounds
the reviewed prototype but is not a claim of fully locked dependency resolution.

`qualifyTownTestAdmission` is an internal composer seam, not a public trust
boundary. It only projects bridge output after the composer supplies an
accepted observer, the independently verified historical/current City profile
and exact current card, the retained request's valid City signature, and a
fresh `readIdentityFeedbackEpoch` result. Only a `same` authority epoch can
qualify as valid. Endpoint/card migration, a retired epoch, failed or incomplete
Town coverage, stale windows, or disclosed replay gaps remain invalid; an
unknown epoch stays unknown.

The signed limitations are retained verbatim:

- Synthetic same-host observer selected by demo policy; not independent operators or official Town accreditation.
- Protocol shape and one exact retry only; not Ethereum authorization, EIP-712 validity, or ownership verification.
- No certification of truthful venues, answer quality, or semantic task success.
- One observed retry is not global exactly-once execution.
- Replay evaluates retained observer records, not an independent rerun or proof the observer told the truth.

Run the focused proof with the pinned local checkouts:

```sh
NANDATOWN_CHECKOUT=/absolute/clean/nandatown \
NANDATOWN_PYTHON=/absolute/clean/nandatown/.venv/bin/python \
node --import tsx --test test/reputation/townEvidence.test.ts

NANDA_INDEX_CHECKOUT=/absolute/clean/nanda-index-v2 \
NANDATOWN_CHECKOUT=/absolute/clean/nandatown \
NANDATOWN_PYTHON=/absolute/clean/nandatown/.venv/bin/python \
node --import tsx --test --test-concurrency=1 \
  test/reputation/townEvidence.integration.test.ts
```

The integration proof creates a disposable Town observer and lets native Town
perform card fetch, `message/send`, exact retry, and task polling against one
owned Chicago service. City then independently reads the current profile and
authority epoch before deriving the test admission.
