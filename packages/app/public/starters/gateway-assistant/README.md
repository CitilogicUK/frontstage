# Gateway assistant

A Node.js CLI starter that sends prompts through the Frontstage gateway. It requires Node.js 22 or later and uses built-in APIs.

Complete `PROJECT_BRIEF.md` before building. Coding agents should follow `AGENTS.md`. Claude Code loads it through `CLAUDE.md`.

1. Put these files in your repository. Edit the source URL, owner, team, purpose, data classification, and models in `catalog-info.yaml` to describe your app. Replace the sample backup owner where present, or add one if the risk tier requires it.
2. In Frontstage, upload `catalog-info.yaml` through **Import**. Open the app in Inventory and complete any required review. Set the app to **Active**.
3. Issue an app key in **Gateway playground**. Set `FRONTSTAGE_GATEWAY_KEY` in your shell from your secret store or local session.
4. Run the starter with synthetic input.

```sh
printf 'Summarize this synthetic test: the team agreed to ship Friday.\n' | node assistant.mjs
```

The default backend is `http://localhost:7007` and the default model is `gpt-4.1-mini`. Set `FRONTSTAGE_BACKEND_URL` and `FRONTSTAGE_MODEL` to match your workspace. Keep the model in your app’s declared model list. Calls and estimated cost appear on the app record. The local simulation labels its output.

Keep the key out of source control. If a key is exposed, revoke it in Frontstage.
