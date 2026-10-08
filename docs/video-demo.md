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

For the hosted credential-free demo, use its HTTPS link and start at **What is
City?** It runs authored fictional answers, not OpenClaw reasoning or live APIs.
The $150-for-two brief is fixed in this mode. Browser journeys are separate,
but the private development chain, feedback capacity and one-shot operator
recovery are shared. Index faults are real, observed, then automatically restored.
Public access to this website does not make its Ethereum chain public or prove
independent operator custody. A short hosted tour should show Discover → Ask →
signed stages → Reputation → temporary Index outage, with these limits stated.

Follow [the setup prerequisites](../README.md#setup-and-checks). The credential-free
launcher is `npm run demo:session`. For real reasoning, first configure the
[isolated OpenClaw roster](../runtime/openclaw/README.md), then run:

```sh
npm run demo:openclaw -- --index-checkout /absolute/path/to/pinned/nanda-index-v2 --port 3000
```

Open the printed `http://127.0.0.1:3000` address. Allow about a minute for startup.
Keep the launcher running and record only the City page, never authentication,
wallet material or the OpenClaw administration screen.

## Explain the purpose first

Open **What is City?** before using the controls. The goal is expert help without
platform lock-in: operators own their identity and profiles, interaction-linked
reputation travels across clients, and search directories remain replaceable.
NANDA Index provides search; Ethereum anchors shared ownership records and
feedback commitments. The client verifies records and chooses its ranking policy.

Use the same four benefits in the narration and show the controls as demonstrations
of them, not as a list of software features. The overview stays available in the
header and task navigation. A new visit opens it; existing task links still work.

## Show these five moments

1. **Discover and choose.** The persistent network map shows your City demo
   client, two parallel Index routes, three alternative operators and local
   Ethereum owner records. Compare Chicago in **Discover**. Each operator also
   serves Boston; food, culture and travel/value are competing complete plans.
   Select one; open “Why this position?” only for the policy explanation.
2. **Ask a specialist.** Select one, leave the $150/two-person example or change
   the dollar budget and preference, then press Ask. Show the model's explanation,
   dinner/activity/transport itinerary, and signed request timeline. Its milestones
   reflect sent → accepted → completed → byte-check observations, not animation. A signed
   response proves who said what, not that its advice is correct.
3. **Make feedback useful.** Open **Reputation** and publish a usefulness rating.
   Ranking refreshes automatically; inspect the updated score in **Discover**.
   This disclosed demo reviewer is admitted by
   the selection policy; a new reviewer can publish but does not automatically
   acquire ranking influence. No positive review approval is granted to the seller.
   A single 5/5 review displays a 3.67/5 policy score: this policy pulls small
   samples toward a neutral starting point rather than awarding instant perfection.
4. **Remove the middleman.** In **Experiments**, take Index A offline and watch
   its route and fresh result change while B still contributes verified services.
   Alter A's reply (the control restores A first if needed): the altered name is
   rejected against the owner record. Use the advanced B control to observe
   both-down discovery, then restore both. Each control rechecks the selected
   city inside one operation; do not run a separate compare just to see its effect.
5. **Keep identity through change.** In **Ownership**, recover and migrate an operator.
   The action checks the new endpoint in the previously selected city; inspect that
   result and ask it. The familiar specialist card and both city IDs remain while
   its owner, runtime signer and
   endpoints change. Then recompute the frozen ranking in a fresh process to
   show that selection can be checked rather than merely trusted.

Optional closing: select Boston; show the deliberate signed failure (injected
before inference, not a failed model call); or run the
explicit chain-free comparison. Reset rebuilds the local fixture and waits for
its owned cleanup. It does not erase OpenClaw history or refill the model allowance.

The page retains native forms and panel links if browser enhancement is unavailable.
With enhancement, status refreshes preserve the selected panel, open disclosures
and panel scroll within a generation; input edits remain scoped to the same city
and selection. Custom dollar amounts use the existing cents field. A no-JavaScript
form shows cents directly.

For a short video, lead with the purpose and benefits, then the working journey, two Index failure
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
