# Gateway agent

Drafts a plan and answer in two gateway calls. It requires Node.js 22 or later and uses built-in APIs.

Run `node --test` to check the gateway client locally. These tests use synthetic data and require no app key or network access.

Complete `PROJECT_BRIEF.md` before building. Coding agents should follow `AGENTS.md`. Claude Code loads it through `CLAUDE.md`.

1. Put these files in your repository. Edit the source URL, owner, team, purpose, data classification, and models in `catalog-info.yaml` to describe your app. Replace the sample backup owner where present, or add one if the risk tier requires it.
2. In Frontstage, upload `catalog-info.yaml` through **Import**. Open the app in Inventory and complete any required review. Set the app to **Active**.
3. Issue a **Sandbox** app key in **Gateway playground**. Set `FRONTSTAGE_GATEWAY_KEY` in your shell from your secret store or local session.
4. Run the starter with synthetic input.

```sh
printf 'Draft a short agenda for a synthetic project kickoff.\n' | node agent.mjs
```

The default backend is `http://localhost:7007` and the default model is `gpt-4.1-mini`. Set `FRONTSTAGE_BACKEND_URL` and `FRONTSTAGE_MODEL` to match your workspace. Keep the model in your app’s declared model list. Calls and estimated cost appear on the app record. The local simulation labels its output.

The starter requests Sandbox by default. For approved live calls, use a Production key and set `FRONTSTAGE_GATEWAY_ENVIRONMENT=production`. Frontstage rejects a request when its key is scoped to a different environment.

Keep the key out of source control. If a key is exposed, revoke it in Frontstage.
