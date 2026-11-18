# AI App Governance

A Backstage portal for registering AI apps, agents, and automations and reviewing critical apps before launch. The governance backend owns the records. A Backstage entity provider publishes them as `AIApp` entities, using the app ID as the entity name.

## Run locally

Use Node.js 24.15+ or 26.13+ within the corresponding major version, and Yarn 4.13.0 via Corepack.

```sh
corepack enable
yarn install --immutable
yarn start
```

Open [http://localhost:3000](http://localhost:3000) and sign in as Guest. Use `user:default/guest` as the owner, `group:default/platform` as the team, and `user:default/backup` for shared or critical apps. The local database is persisted under `.local/`.

To try the review workflow, register a critical app as Guest, stop the dev server, then start it with the local reviewer identity. Sign in again in a private browser window.

```sh
yarn start --config ../../app-config.reviewer.yaml
```

## Register apps

- **Intake form.** Use Register to enter app details and preview the tier. The backend recalculates the tier before saving.
- **Repository.** Commit a descriptor using [examples/ai-app.yaml](examples/ai-app.yaml), then upload it under Import or submit it from CI. Repository discovery is a later phase.
- **Bulk import.** A reviewer or authorized Backstage service can submit a spreadsheet exported as UTF-8 CSV using the [sample columns](packages/app/public/examples/ai-apps.csv), or JSON in the form `{"apps":[...]}`. Each entry uses the descriptor's `spec` fields. In CSV, set `usesAiAtRuntime` to No and leave `models` blank for software that runs without AI. Use `trial`, `poc`, `pilot`, or `production` in `deliveryStage`. Separate model names with `|`, use Yes or No for booleans, and put multiple connections in a JSON array inside the connections cell. Include `hosted.provider`, `hosted.workspace`, `hosted.sharing`, `hosted.dataAccess`, and, when applicable, `hosted.dataClassification` for provider-hosted apps. Batches of up to 100 records are atomic. In Import, select **Validate file** to preview calculated tiers and detect duplicate source URLs before saving. API consumers can send `?dryRun=true` to the repository or bulk import endpoint for the same preview.

The API accepts Backstage credentials. Use a Backstage service credential for automation and the shortest applicable access scope in its configuration.

| Method | Path below `/api/governance` | Use                                                                |
| ------ | ---------------------------- | ------------------------------------------------------------------ |
| GET    | `/apps`, `/apps/:id`         | List or read records                                               |
| POST   | `/apps`                      | Register an app                                                    |
| PUT    | `/apps/:id`                  | Replace the editable fields, recalculate tier, or update lifecycle |
| PATCH  | `/apps/:id/lifecycle`        | Update lifecycle independently                                     |
| POST   | `/repository`                | Register a descriptor with `{"content":"<YAML>"}`                  |
| POST   | `/imports`                   | Import with `{"apps":[...]}` or `{"csv":"<CSV>"}`                  |
| POST   | `/apps/:id/reviews`          | Record an approval or request changes with notes                   |
| GET    | `/apps/:id/history`          | Export reviewer-only record and gateway key history                |

Set optional risk floors in `governance.tierPolicy`. The keys are `audience`, `classification`, `hostedSharing`, and `connection`. Values 1 through 3 can raise the built-in requirements. For example, set `governance.tierPolicy.classification.confidential: 3` to require critical review for confidential data. The live questionnaire uses `POST /api/governance/tier-preview`.

Critical apps start pending review and require a current approval before they can become active. Owners and backup owners cannot approve their own apps. Reviews expire after six months. Changing a critical app’s purpose, ownership, evidence, or risk inputs reopens its review and returns an active app to experimental. Moving a critical app to the production delivery stage also requires fresh approval. Changing the accountable owner revokes any existing gateway key. The new owner can issue a replacement. Review decisions require the current `updatedAt` value as `expectedUpdatedAt`. Reviewers can open **Audit history** on an app and download its record and key history as JSON. The record events are SHA-256-linked and saved in the same transaction as each change. Key events record the action, actor, and time in a separate SHA-256 chain. Verify a downloaded file offline with `yarn audit:verify path/to/export.json`. Save the final SHA-256 digest shown in Audit history separately. Supply it as the second argument to check that the export ends at the saved digest. For a newer export, use `yarn audit:verify path/to/export.json --checkpoint <digest>` to verify that the chain still contains the earlier checkpoint. To verify the key history against a separately saved digest, add `--key-head <digest>` using the final key event digest shown in Audit history. Upgraded databases establish the key chain from their stored events at migration time. Older exports without key digests still support record-chain verification.

## App templates

Open **Templates** and choose **AI-assisted software** for projects built with coding agents that do not call models at runtime. Every ZIP includes shared `AGENTS.md` instructions, a `CLAUDE.md` import, a project brief, and a registration descriptor. Choose a delivery stage and data classification before downloading to customize the brief and registration defaults. The instructions scale from trial and proof of concept through pilot and production. Delivery stage is separate from the calculated risk tier.

For apps that call AI at runtime, choose the assistant, agent, or automation starter. Choose a model that the workspace approves for that classification. The ZIP and registration form use both choices. The generated client defaults to the workspace’s configured backend URL. Each ZIP includes a dependency-free Node.js client, a Frontstage registration descriptor, and activation instructions. Use **Register from template** to start the form with the starter’s defaults, or import its edited descriptor. The agent drafts a plan and answer in two gateway calls. The automation summarizes a local text file.

## Gateway demo

The gateway checks active catalog ownership before issuing or rotating a key and before forwarding a permitted model call. Missing or inactive ownership blocks that call. If the catalog is unavailable, the gateway returns a retryable error.

The local development profile enables a simulated gateway. It exercises the same key, lifecycle, review, and model controls as the live adapter and keeps prompts on the machine. Use synthetic data for the demo.

```sh
yarn start --config ../../app-config.reviewer.yaml
```

In another terminal, run `yarn demo:seed` once the backend is running. The script waits for the local catalog’s demo identities before registering apps. It creates five demo records on behalf of the local Guest owner. Open Inventory and sign in as Guest using the reviewer profile above.

1. Open **Meeting summary demo**. Issue a gateway key, select `gpt-4.1-mini`, and send a synthetic meeting prompt. The result is labelled simulated. The app record updates its all-time live, simulated, and blocked call counts. Only live calls contribute to the live cost estimate.
2. Open **Restricted intake demo**. Issue a key and send a synthetic prompt with `gpt-4.1-mini`. The gateway blocks the call while review is pending.
3. Record an approval in that app’s details and set its lifecycle to **Active**. Retry with the same key and model. Then select `gpt-4.1-nano` and retry. The gateway still rejects that model for restricted data.

For the software-only path, compare **Stock count proof of concept** with **Purchase order pilot**. Both run without models. The first is Tier 1. The second is Tier 3 because it acts in another system. Open it from **Reviews**, record an approval for the sandbox scope, and set it to **Active**. Its app record does not offer gateway keys. In **Reports**, select a runtime AI count to open its matching records.

For the hosted path, open **Hosted workspace demo** and check its scorecard. Activation is blocked while the declared workspace is **Personal sandbox**. Change it to **Company sandbox** under **Edit app details**, then activate the app. The reviewer profile uses a fictional provider and workspace for this check.

Seeding leaves existing demo records in their current state. The end-to-end test creates its own database for a clean replay.

### Live OpenAI call

Set `OPENAI_API_KEY` in your shell, then start with the live adapter overlay. Use **Meeting summary demo** for the live call. The live overlay permits only public and internal data. The restricted scenario is intended for the simulation.

```sh
APP_CONFIG_governance_gateway_openaiApiKey="$OPENAI_API_KEY" \
  yarn start --config ../../app-config.reviewer.yaml --config ../../app-config.gateway-openai.yaml
```

A software app can call the same endpoint, `POST /api/governance/gateway/chat`, with its app key as the bearer credential and JSON containing `model` and `prompt`. The portal uses Backstage credentials for `POST /api/governance/apps/:id/gateway-key` and `GET /api/governance/apps/:id/usage`.

The gateway stores app key hashes and usage metadata. The app panel shows input and output token counts for live calls with token data. Estimates use the rates in `app-config.development.yaml`. Set a model’s `maxCompletionTokens` to adjust its per-call live output limit. The default is 1,024 tokens. The Builder guide lists the gateway’s approved models and data classifications. Key issuance replaces the app’s previous gateway key. Set `governance.gateway.requestsPerMinute` to cap accepted requests per app in each UTC minute. Excess requests return `429` with `Retry-After` and appear in policy block reporting. The development limit is 30 per app. Set `governance.gateway.appRateLimits` to a list of `sourceUrl` and `requestsPerMinute` pairs to override the default for specific apps. The app’s gateway panel shows its effective limit. Configure `governance.gateway.appSpendThresholds` with `sourceUrl` and `monthlyUsd` pairs to display month-to-date estimated live spend and flag when it reaches the threshold. Reviewers can see apps that reached their threshold in Portfolio Reports. Thresholds are informational by default. Set `stopAtThreshold: true` on an entry to block new live calls after the recorded estimate reaches its threshold. Calls already in flight can take the estimate above it. Owners and reviewers can check key status or revoke a key from the playground. Revocation blocks subsequent requests and records the actor and time. Retiring an app or switching it to no runtime AI automatically revokes its key. Reactivating an app requires a fresh key.

## Separate critical sign-offs

To require two independent sign-offs, configure `governance.reviewTracks.security` and `governance.reviewTracks.dataProtection` as disjoint lists of Backstage user references. Reviewers can record a decision only for their assigned track. Both approvals must be current before launch. The default local demo uses a combined reviewer decision.

With split reviews enabled, reviewers can select **My pending sign-offs** in Reviews to find apps still waiting for their assigned Security or Data Protection decision.

## Review evidence

An owner or reviewer can link an existing work item using **Review ticket URL** in app details. Owners, backup owners, and reviewers can open the linked ticket. Changing the link preserves the current approval. The ticket system continues to manage ticket access and status.

Use **Edit app details** in the app details to save links to test evidence, a data-flow diagram, or an incident plan. The owner, backup owner, and reviewers can read the links. Changing evidence reopens a critical app’s review.

## Owner attestation

In Inventory, switch **Ownership** to **My apps** to see your apps, with upcoming and overdue governance work shown first. The accountable owner of a Tier 2 app can confirm its current purpose, ownership, and declared risk inputs in the app details. Frontstage records the attestation in the audit history and sets the next review date one year later. After an ownership transfer, the new Tier 2 owner’s first attestation is due immediately. Owners, backup owners, and reviewers can download an individual review or attestation date as a calendar file with a seven-day reminder. Use **Apps I back up** to find records where you’re listed as backup owner. Both ownership views let you download the scheduled dates for the current filtered list in one calendar file.

## App scorecards

Owners, backup owners, and reviewers can open **App scorecard** in an app’s details. It checks catalog ownership, review status, and, for gateway apps, activation and model policy. The activity check uses live calls recorded in the last 90 days and identifies simulation-only activity separately. For provider-hosted apps, set `governance.approvedHostedWorkspaces` to a list of `provider` and `workspace` pairs. The scorecard checks the app’s declared pair against that list. When configured, the list also prevents activation of apps whose declared workspace is unlisted. Actual provider settings still require separate verification.

## Portfolio reports

Inventory supports filtering by lifecycle and can download the current search and filter results as CSV. The export includes ownership, classification, risk, delivery stage, runtime AI use, and review status.

Open **Reports** for the non-retired inventory count, critical apps needing review, and the percentage of non-retired Tier 2 and Tier 3 apps past their review or attestation date. The lifecycle, platform, risk tier, and effective data classification breakdowns link to matching Inventory rows. The delivery-stage table counts all registered apps by runtime AI use, including retired records. Select a stage or a runtime AI count to open the matching Inventory records. Reviewers can open apps with missing or inactive owners, backup owners, or teams from the **Ownership issues** panel. The reviewer profile also shows successful gateway calls and estimated cost over a selectable 24-hour, seven-day, or 30-day window, searchable by app, team, model, and execution mode. Only calls recorded as live count toward the live estimate. The team table groups calls, blocks, and live estimates by each app’s current team. Select a team to filter the detailed usage and blocks below it. Switch the summary to Model to see successful calls and live estimated spend per model. The reporting window, selected team, and grouping are preserved in the shareable Reports URL. Reviewers can download the selected team or the full portfolio as separate CSV files. Earlier calls without a recorded mode remain visible separately. A separate table shows policy-blocked calls by app, reason, and execution mode. Reviewers can download the selected window as CSV with app and team labels, successful and blocked counts, and estimated cost. These events store no prompt, response, or key.

**Retirement review** lists active apps whose most recent recorded live gateway call was at least 90 days ago, regardless of the usage reporting window. The simulation-only demo leaves this panel empty. Open an app from the list and check with its owner for usage outside the gateway before updating its lifecycle. Retiring an app revokes its gateway key. You can record an optional lifecycle reason. It appears in Audit history and is covered by the record event’s digest.

**Median time to first Tier 3 decision** measures from the first pending submission to the first recorded overall approval or request for changes. It uses the available audit history across all reporting windows. The calculation includes elapsed time on UTC weekdays and excludes weekends. A partial sign-off or an app still waiting for a decision does not contribute to the median. Set `governance.firstDecisionTargetWeekdays` to a positive integer to flag pending reviews that reach your team’s target in Reports and the **Awaiting first decision** queue.

## Discover and claim a GitHub repository

The development profile scans public repositories in the Hugging Face organization tagged `llm`. The topic is a discovery signal. Check that the repository represents an app your team actually operates before claiming it in a real workspace.

1. Start with the reviewer profile and open **Discovery**. Select **Scan GitHub** to read repository metadata.
2. Select **Claim repository** on an unowned entry. Complete the prefilled registration with the app’s purpose, model, owner, team, and risk inputs.
3. Submit the form. The app appears in Inventory and the Discovery entry becomes **Registered**.

Reviewers can dismiss false positives with a reason and reopen them from the **Dismissed** filter. Dismissals survive rescans. Frontstage records who made each decision and when.

Set `governance.discovery.github.organization` and `topic` to use a different GitHub organization. For private repositories, supply a read-only GitHub token through `APP_CONFIG_governance_discovery_github_token`. Reviewers can run a scan and authenticated builders can claim a repository as its owner. The scan looks at up to 100 matches and indicates when GitHub returned partial results. Set `governance.discovery.github.scanIntervalMinutes` to enable automatic scans on a 15-minute to 7-day interval. The queue shows the last scan’s time, trigger, and outcome. Open a registered app directly from Discovery or Portfolio reports. The app details URL can be shared with signed-in teammates.

## Building frontend screens

Use the [workspace screen recipes](docs/workspace/README.md) for shared components, desktop and phone references, and the browser regression check.

Backstage Analytics receives semantic events when a registration is saved or a starter download begins. Event attributes use fixed source and starter categories, delivery stage, and runtime AI use. App names, model names, owners, and form content are excluded. An analytics provider is needed to collect these events in a deployment.

## Deployment and roadmap

The dev server uses seed identities and SQLite. Before deployment, configure company SSO and the Backstage identity catalog provider, map reviewers to company identities, supply Postgres and the production URLs, and configure permissions for accessing the inventory. Production gateway operations, provider controls, additional discovery connectors, escalation, and deeper reporting remain later phases.

```sh
yarn tsc --noEmit
yarn test --watch=false --runInBand
```

GitHub Actions validates the local reviewer configuration and runs the type check, lint, unit tests, production build, and Chromium tests on pull requests and pushes to `main`. The gateway browser test starts an isolated SQLite backend. CI also tests the key audit migration on PostgreSQL 17. Discovery unit tests use a simulated GitHub response and require no external credentials.
