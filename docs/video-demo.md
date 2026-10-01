# NANDA City: five-minute walkthrough

[One-minute overview](overview.md) · [Full setup](../README.md#setup-and-checks)

## The story

Your personal agent wants to plan an evening in Chicago or Boston. It discovers
three specialist services, compares their evidence, asks one, and leaves feedback
that a later client can use. The operator controls its identity and service
record; an Index helps find it but cannot rewrite that authority.

The prototype puts that whole loop on screen. It is a reference application,
not an official NANDA release.

## Start

Follow [the setup prerequisites](../README.md#setup-and-checks). The credential-free
launcher is `npm run demo:session`. For real reasoning, first configure the
[isolated OpenClaw roster](../runtime/openclaw/README.md), then run:

```sh
npm run demo:openclaw -- --index-checkout /absolute/path/to/pinned/nanda-index-v2 --port 3000
```

Open the printed `http://127.0.0.1:3000` address. Allow about a minute for startup.
Keep the launcher running and record only the City page, never authentication,
wallet material or the OpenClaw administration screen.

## Show these five moments

1. **Discover and choose.** The actor scene shows your City demo client searching
   two Indexes, checking owner records, then asking the chosen specialist directly.
   Follow the Discover → Choose journey links and compare Chicago. Each operator
   also serves Boston; food, culture and travel/value are competing complete
   evening plans. Open “Why this position?” for the policy explanation, then the
   nested JSON only if exact evidence is useful. “Why doesn't every rating count?”
   explains the disclosed accepted-reviewer rule without calling newcomers bad.
2. **Ask a specialist.** Select one, leave the $150/two-person example or change
   the dollar budget and preference, then press Ask. Show the model's explanation,
   dinner/activity/transport itinerary, and signed request timeline. Its milestones
   reflect sent → accepted → completed → byte-check observations, not animation. A signed
   response proves who said what, not that its advice is correct.
3. **Make feedback useful.** Publish a usefulness rating and compare again.
   Show the score and its evidence. This disclosed demo reviewer is admitted by
   the selection policy; a new reviewer can publish but does not automatically
   acquire ranking influence. No positive review approval is granted to the seller.
   A single 5/5 review displays a 3.67/5 policy score: this policy pulls small
   samples toward a neutral starting point rather than awarding instant perfection.
4. **Remove the middleman.** In Try resilience, stop Index A, then compare.
   Index B still discovers authentic services. Recover A, tamper with it, stop B,
   and compare again: altered records are rejected, not treated as operator truth.
   Recover both Indexes before continuing.
5. **Keep identity through change.** Recover and migrate an operator. Compare
   again and ask it: the familiar specialist card and both city IDs remain while
   its owner, runtime signer and
   endpoints change. Then recompute the frozen ranking in a fresh process to
   show that selection can be checked rather than merely trusted.

Optional closing: select Boston; show the deliberate signed failure (injected
before inference, not a failed model call); or run the
explicit chain-free comparison. Reset rebuilds the local fixture and waits for
its owned cleanup. It does not erase OpenClaw history or refill the model allowance.

The page retains native forms if browser enhancement is unavailable. With
enhancement, status refreshes preserve the current city, edits and focus where
the generation and selection still match; custom dollar amounts are converted
to the existing cents field. A no-JavaScript form shows cents directly.

For a short video, lead with the working journey, then the two Index failure
controls and identity recovery. Show exact evidence only when explaining one
claim; the full JSON is available without making it the main presentation.
Model calls and recovery can take several seconds. Wait for the operation to
complete before the next click; do not reset just because a button is disabled.

## What is real, and what is simulated?

| Working local execution | Deliberate demo boundary |
| --- | --- |
| Two actual pinned NANDA Index instances with separate databases | One computer, not separately operated infrastructure |
| ERC-8004 identity and reputation contracts; Safe recovery/migration | Ephemeral local Anvil chain, not a Sepolia deployment |
| Signed A2A requests, acceptance, completion and reviewer feedback | Generated operator/customer keys; simulated custody |
| Real OpenClaw model calls in the optional launcher | Fictional venues, routes and prices; no Maps/events feeds |
| Evidence-based selection and fresh-process reconstruction | Same verifier/host, bounded coverage and selected reviewer policy |

Ethereum supplies shared identity/update authority and feedback commitments in
the default profile. Indexes remain replaceable search caches. The separate
origin-authority comparison makes the alternative and its different continuity
assumptions inspectable; it is never an automatic downgrade after chain failure.

Next development gates are permitted live data, useful-answer comparison against
direct tools, public-registry history compatibility, and approved Sepolia
publication. Payments and independent-operator onboarding follow the core loop.

## Rehearse without clicking

```sh
npm run demo:rehearse -- --index-checkout /absolute/path/to/pinned/nanda-index-v2
# Explicitly opt into real model calls:
npm run demo:rehearse -- --index-checkout /absolute/path/to/pinned/nanda-index-v2 --openclaw
```

The rehearsal checks all six services, feedback/ranking, Index loss/tampering,
recovery/migration, provider loss and the separate origin comparison. It creates
read-only HTML/JSON in a new temporary directory, then cleans up its own chain,
databases and service processes. It is not run by CI or default tests. The saved
snapshot explains the run; it cannot resurrect its stopped chain or replace a
live authority source for future independent checks.
