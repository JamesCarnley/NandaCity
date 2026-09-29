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
agents with separate workspaces. They can read the shared model credential;
never copy OAuth tokens or give agents the same `agentDir`. Copy
`workspace-agents.txt` as each workspace's `AGENTS.md`, then copy `BOOTSTRAP.md`
and `USER.md`, plus that role's `SOUL.md` and `IDENTITY.md`. Use
`tools.profile=minimal`; the City prototype also denies
the `gateway` tool and connects no messaging channels.

Test each agent with `openclaw models status --agent <id>` and a short
`openclaw agent --agent <id> --message ... --json` turn. A usable model route and
reply prove local inference access, not real city knowledge or City integration.
The repository does not contain model credentials or a live data-source config.
