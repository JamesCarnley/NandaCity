# Optional local OpenClaw roster

These small workspace files configure three City specialist personas. They are
not City operator keys, public A2A endpoints, or evidence of independent custody.
One local OpenClaw gateway may run all three with a shared model account.

| City emphasis | OpenClaw agent ID | Workspace files |
| --- | --- | --- |
| Food | `city-food` | Common files here plus `city-food/` |
| Culture | `city-culture` | Common files here plus `city-culture/` |
| Travel and value | `city-travel-value` | Common files here plus `city-travel-value/` |

For a disposable local setup, use the pinned official OpenClaw image
`ghcr.io/openclaw/openclaw:2026.9.6`, a dedicated state volume and a gateway port
published to `127.0.0.1` only. Do not mount a personal OpenClaw state directory,
the Docker socket, or host credentials. Onboard with the ordinary `main` agent,
sign in through OpenClaw's supported model-auth flow, and add the three named
agents with separate workspaces. The OpenClaw runtime shares model authentication
across them; credentials are never put in model prompts and tools are denied.
Never copy OAuth tokens or give agents the same `agentDir`. Copy
`workspace-agents.txt` as each workspace's `AGENTS.md`, then copy `BOOTSTRAP.md`
and `USER.md`, plus that role's `SOUL.md` and `IDENTITY.md`. Use
`tools.profile=minimal`, `tools.deny=["*"]`, and
`agents.defaults.heartbeat.every=0m`. Connect no messaging channels. The model
chooses from supplied options, so it needs no tools. The adapter's preflight
requires this configuration-level tool denial, a healthy gateway, the dedicated
named volume, dropped capabilities, no-new-privileges and loopback-only ports.

Test each agent with `openclaw models status --agent <id>` and a short
`openclaw agent --agent <id> --message ... --json` turn. A usable model route and
reply prove local inference access, not real city knowledge.

## Run through City

The adapter expects a running container named `nanda-city-openclaw`, one named
volume `nanda-city-openclaw-state` mounted at `/home/node/.openclaw`, and the
image tag above. It pins the local Docker Unix socket selected by the current
context; it does not use a remote daemon or silently create/alter a runtime.

```sh
npm run demo:openclaw -- --index-checkout /absolute/path/to/pinned/nanda-index-v2 --port 3000
```

All six City A2A services now route to the corresponding OpenClaw specialist.
Each request uses a unique gateway session. City sends only validated request
inputs and authored fictional options; wallet keys and private evidence are
excluded from that prompt. OpenClaw adds its configured persona/workspace
instructions. Model output is schema-checked and
selects one complete option rather than replacing its facts. The normal gateway
route uses the shared login; isolated `agent exec` is not used.

The launcher permits at most 18 model dispatches across all specialists, including
failures, for its lifetime. Reset does not replenish that allowance; starting a
new launcher does. Prompt size, response size and wall time are bounded. Token
counts are reported by OpenClaw **after** dispatch, not a provider-exact prepaid
limit. City does not retry a failed model call, although OpenClaw/provider internals
may retry. SIGTERM reaches the container CLI's gateway abort bridge; a broken
Docker connection or forced kill cannot prove remote cancellation, and no answer
is accepted in that case.

Synthetic requests and answers remain in this dedicated OpenClaw volume. City
reset clears its own fixture, not the gateway's session history or shared login.
Do not enter private information in this demo. The repository contains neither
model credentials nor a live data-source config. Personal OpenClaw installations
are unrelated and must not be mounted or modified.
