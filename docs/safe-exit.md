# Local encrypted backup and same-account exit

Run the owned local drill with Node 24.11.0, Anvil 1.7.1, Docker and a clean
checkout of the pinned Index source:

```sh
NANDA_INDEX_CHECKOUT=/absolute/path/to/pinned-index \
  node --import tsx --test test/identity/safeExit.integration.test.ts
```

The `same-account-clean-exit` proof stops and awaits the process holding the
original client, owner, runtime and payer credentials. A fresh process receives
only private enumerated exports, the password over IPC, and explicit public
network/account configuration. It restores the backup owner, replaces the primary
owner, then separately replaces runtime authorization and both service endpoints.
The Safe and both registry IDs stay unchanged. A new generated non-owner executor
is funded directly by the owned fixture, with no Safe reimbursement or original
payer subsidy. The report distinguishes the two cities during partial progress.

The separate `adversarial-revocation-companion` deliberately retains disposable
attacker keys. It proves that a retired owner cannot approve a fresh-current-nonce
call and that valid old-runtime signatures on unused interactions do not have
current authority. It does not sign with destroyed clean-exit keys.

Backups use standard Ethereum V3 JSON, asynchronous ethers 6.17.0 operations,
library-random salt/IV and scrypt N=131072, r=8, p=1. This bounded generated-export
slice accepts only that configuration and AES-128-CTR, not arbitrary wallet imports.
Password text uses explicit Unicode NFKC and must be well-formed, 1–1024 UTF-8
bytes before and after normalization. Whitespace and case remain significant.
There is no retry with a different interpretation. Raw-byte importers may require
the normalized text; universal external wallet compatibility is not claimed.

Keep the password separate. Passwords, credentials and keystore bytes must not be
passed in command arguments or environment variables, or placed in logs or Git.
The private directory is mode 0700; files are mode 0600. Metadata is private by
default too. It locates state but does not authorize it: restoration compares a
separately trusted owner/domain and independently reads canonical chain state.
JavaScript heap zeroization is not promised.

The drill retains exact cards, signed interactions and feedback bundles. Only
v0.2 bundles committed before runtime retirement can receive the history composer's
qualified carry-forward finding. This is not proof of service quality, use time,
compromise time, finality or permanent availability. Legacy evidence remains
conservative and ownership transfers do not qualify. A malicious primary that
removes the backup defeats this 1-of-2 loss-recovery mechanism. Public-chain writes,
real custody, passkeys, interactive wallet UX and independent operator custody
remain outside this local generated-credential demonstration.
