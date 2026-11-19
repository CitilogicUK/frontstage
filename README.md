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
- **Repository.** Commit a descriptor using [examples/ai-app.yaml](examples/ai-app.yaml), then upload it under Import, submit it from CI, or use it when claiming a repository in Discovery.
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

Critical apps start pending review and require a current approval before they can become active. Owners and backup owners cannot approve their own apps. Reviews expire after six months. Changing a critical app’s purpose, ownership, evidence, or risk inputs reopens its review and returns an active app to experimental. Moving a critical app to the production delivery stage also requires fresh approval. Changing the accountable owner revokes any existing gateway key. The new owner can issue a replacement. Review decisions require the current `updatedAt` value as `expectedUpdatedAt`. Reviewers can open **Audit history** on an app and download its record and key history as JSON. The record events are SHA-256-linked and saved in the same transaction as each change. Key events record the action, actor, and time in a separate SHA-256 chain. Verify a downloaded file offline with `yarn audit:verify path/to/export.json`. Save the final SHA-256 digest shown in Audit history separately. Supply it as the second argument to check that the export ends at the saved digest. For a newer export, use `yarn audit:verify path/to/export.json --checkpoint <digest>` to verify that the chain still contains the earlier checkpoint. To verify the key history against a separately saved digest, add `--key-head <digest>` using the final key event digest shown in Audit history. Use `--key-checkpoint <digest>` to check that a newer export still includes an earlier saved key digest. Upgraded databases establish the key chain from their stored events at migration time. Older exports without key digests still support record-chain verification.

## App templates

Open **Templates** and choose **AI-assisted software** for projects built with coding agents that do not call models at runtime. Every ZIP includes shared `AGENTS.md` instructions, a `CLAUDE.md` import, a project brief, and a registration descriptor. Choose a delivery stage and data classification before downloading to customize the brief and registration defaults. The instructions scale from trial and proof of concept through pilot and production. The brief includes exit criteria for the selected stage. The included `.gitignore` excludes local environment files and allows a placeholder-only `.env.example`. Delivery stage is separate from the calculated risk tier.

For apps that call AI at runtime, choose the assistant, agent, or automation starter. Choose a model that the workspace approves for that classification. The ZIP and registration form use both choices. The generated client defaults to the workspace’s configured backend URL. Each ZIP includes a dependency-free Node.js client, a Frontstage registration descriptor, and activation instructions. Use **Register from template** to start the form with the starter’s defaults, or import its edited descriptor. The agent drafts a plan and answer in two gateway calls. The automation summarizes a local text file.

## Gateway demo

Run this walkthrough with synthetic data. Follow [Run locally](#run-locally) for prerequisites, then start the reviewer profile against a fresh database. The default ports are 3000 and 7007. Use the parallel setup below if those ports are occupied.

```sh
export APP_CONFIG_backend_database_connection_directory="$(mktemp -d)"
yarn start --config ../../app-config.reviewer.yaml
```

In a second terminal at the repository root, run `yarn demo:seed` after the backend starts. Open [Frontstage](http://localhost:3000) in a private window and sign in as **Guest**. In this profile, Guest signs in as the reviewer. The seed creates six records owned by `user:default/guest`, a separate demo identity.

1. **Show both ways to build.** In **Templates**, compare **AI-assisted software** with **Gateway assistant**. In **Inventory**, **Stock count proof of concept** and **Purchase order pilot** both run without models or gateway keys. The stock count is Tier 1. The purchase order pilot is Tier 3 because it submits orders to a sandbox. **Meeting summary demo** uses a model at runtime. Issue a key, select `gpt-4.1-mini`, and send `Summarize these synthetic notes: the team agreed to test the sandbox on Friday.` The result is marked as simulated. See [App templates](#app-templates).
2. **Hand off a critical app for review.** Open **Restricted intake demo** from **Reviews**. Issue a key and attempt a synthetic call with `gpt-4.1-mini`. The pending review blocks it. Open **Edit review ticket**, enter `https://example.com/reviews/restricted-intake` as the **Ticket URL**, then save. Select **Copy app link** to share the app record with a signed-in reviewer. Record an approval with sandbox-only scope in **Review notes**, set **Lifecycle** to active, and select **Update lifecycle**. Retry with the same key and model. The playground lists `gpt-4.1-nano` as unavailable for restricted data. See [Review evidence](#review-evidence) and [Separate critical sign-offs](#separate-critical-sign-offs).
3. **Trace model impact.** In **Reports**, choose **Declared model** under **Group inventory by**, then select the count for `gpt-4.1-nano` to open the matching records. The count includes declarations even when a call is blocked or no call is recorded. Back in **Reports**, set **Group gateway usage** to **Model** to see the successful simulated calls under **Other calls**. **Gateway policy blocks** shows the denied attempts. Live estimated spend stays at zero. See [Portfolio reports](#portfolio-reports).

To check the hosted-app path, open **Hosted workspace demo** and check its scorecard. Activation is blocked while the declared workspace is **Personal sandbox**. Change it to **Company sandbox** under **Edit app details**, then activate the app. The demo uses a fictional provider and workspace. To demonstrate the owner confirmation, stop the reviewer server and restart it against the same database with the owner identity:

```sh
APP_CONFIG_auth_providers_guest_userEntityRef=user:default/guest yarn start --config ../../app-config.reviewer.yaml
```

Sign in as Guest in a fresh private window.

1. In **Inventory**, open **My workspace confirmations**, select **Hosted workspace demo**, and record the quarterly attestation. The app details show the next due date. Clear the review filter in **My apps** to include the newly scheduled date in **Download my review calendar**.
2. In **Inventory**, open **My pending access requests**, select **Warehouse reconciliation demo**, and open **Directory access requests**. Record a decision for the seeded requester. The app leaves the pending queue. The destination is an example URL, and the demo records the decision without provisioning access.

In the reviewer profile, the seed requester can see the pending or decided status of **Warehouse reconciliation demo** in **Directory**.

The gateway checks active catalog ownership before issuing or rotating keys and before forwarding calls. The simulation uses the same key, lifecycle, review, and model checks as the live adapter. Seeding again preserves existing records. Restart with a fresh temporary database to replay from the initial state.

### Run a second demo in a worktree

Use separate ports and a fresh database directory in the second worktree.

```sh
export APP_CONFIG_app_baseUrl=http://localhost:3414
export APP_CONFIG_backend_baseUrl=http://localhost:7414
export APP_CONFIG_backend_listen_port=7414
export APP_CONFIG_backend_cors_origin=http://localhost:3414
export APP_CONFIG_backend_database_connection_directory="$(mktemp -d)"
yarn start --config ../../app-config.reviewer.yaml
```

From another terminal in that worktree, seed the same port pair and open the app on port 3414.

```sh
FRONTSTAGE_DEMO_APP_PORT=3414 FRONTSTAGE_DEMO_BACKEND_PORT=7414 yarn demo:seed
```

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

With split reviews enabled, reviewers can select **My pending sign-offs** in Reviews to find apps still waiting for their assigned Security or Data Protection decision. The filtered queue can be downloaded as CSV, with the app, owner, team, pending sign-offs assigned to you, the scheduled review date when available, and a direct link to each app.

## Tier 3 renewal exceptions

An independent reviewer can grant an already-active Tier 3 app a renewal exception before its current approval expires. Record the reason and choose an expiry no more than 30 days after the scheduled review date. The original due date stays visible. Calls using an existing gateway key can continue until the exception expires or is revoked, subject to the usual ownership, data and model checks.

The app still needs fresh approval for first launch, reactivation after its approval has expired, or a material change. A new review decision or leaving the active lifecycle clears the exception. Grant and revoke actions appear in audit history. Separate critical sign-off tracks require their normal renewals.

## Engineering co-ownership

Set `governance.graduationGroups` to the Backstage groups that can accept co-ownership of Tier 3 production apps. An owner or reviewer can nominate an active direct member of one of those groups. The nominee finds the request in Inventory and records their decision. The handoff and decision appear in Audit history. The existing accountable owner and gateway access stay in place. If the co-owner leaves the role, the app owner or another reviewer can end the handoff with a reason and nominate a replacement. Audit history records who ended it, the former co-owner, and the reason.

For a local walkthrough, start the reviewer profile, open a Tier 3 app, and set its delivery stage to **Production**. In **Engineering co-owner**, nominate `user:default/engineer`. Stop the server and restart it against the same database with the engineering identity, then sign in in a new private browser session.

```sh
APP_CONFIG_auth_providers_guest_userEntityRef=user:default/engineer \
  yarn start --config ../../app-config.reviewer.yaml
```

Open the app from Inventory and accept or decline the nomination. The reviewer profile includes a synthetic engineering group. Set your own groups and identities in a deployment.

## Review evidence

An owner or reviewer can open **Edit review ticket** in a non-retired Tier 3 app’s details to link or remove an existing work item without editing the rest of the app. Owners, backup owners, and reviewers can open the linked ticket. Changing the link preserves the current approval. The ticket system continues to manage ticket access and status.

Use **Edit app details** in the app details to save links to test evidence, a data-flow diagram, or an incident plan. The owner, backup owner, and reviewers can read the links. Changing evidence reopens a critical app’s review.

## Owner attestation

In Inventory, switch **Ownership** to **My apps** to see your apps, with upcoming and overdue governance work shown first. The accountable owner of a Tier 2 app can confirm its current purpose, ownership, and declared risk inputs in the app details. Frontstage records the attestation in the audit history and sets the next review date one year later. After an ownership transfer, the new Tier 2 owner’s first attestation is due immediately. Owners, backup owners, and reviewers can download an individual review or attestation date as a calendar file with a seven-day reminder. Use **Apps I back up** to find records where you’re listed as backup owner. Both ownership views let you download scheduled tier reviews, yearly attestations, and hosted workspace confirmations for the current filtered list in one calendar file. Filters select which apps to export, and the calendar includes all scheduled dates for each matching app. Use **Due in the next 30 days** under **Review status** to focus on upcoming renewals and attestations.

## Backup owner handover

When Backstage marks an accountable owner inactive or no longer has their user record, the registered backup owner can open the app from **Inventory → Apps I back up** and confirm the handover. Tier 2 and Tier 3 apps need a different active backup owner. Frontstage checks the catalog and the current app revision before transferring ownership.

A handover revokes the old gateway key and appears in Audit history. Tier 2 apps need an attestation from the new owner. Tier 3 apps return to review before they can go live again.

## App scorecards

Owners, backup owners, and reviewers can open **App scorecard** in an app’s details. It checks catalog ownership, review status, and, for gateway apps, activation and model policy. The activity check uses live calls recorded in the last 90 days and identifies simulation-only activity separately. For provider-hosted apps, set `governance.approvedHostedWorkspaces` to a list of `provider` and `workspace` pairs. The scorecard checks the app’s declared pair against that list. When configured, the list also prevents activation of apps whose declared workspace is unlisted. Actual provider settings still require separate verification.

## Portfolio reports

Inventory supports filtering by lifecycle and can download the current search and filter results as CSV. Inventory and Reviews show elapsed days for overdue reviews and attestations with scheduled dates. The overdue Inventory filter puts the oldest due dates first, and the CSV includes the same overdue age for dated items and direct links to the app records. The export includes ownership, classification, risk, delivery stage, runtime AI use, and review status.

Open **Reports** for the non-retired inventory count, critical apps needing review, and the percentage of non-retired Tier 2 and Tier 3 apps past their review or attestation date. The lifecycle, platform, risk tier, and effective data classification breakdowns link to matching Inventory rows. The delivery-stage table counts all registered apps by runtime AI use, including retired records. Select a stage or a runtime AI count to open the matching Inventory records. Reviewers can open apps with missing or inactive owners, backup owners, or teams from the **Ownership issues** panel. The reviewer profile also shows successful gateway calls and estimated cost over a selectable 24-hour, seven-day, or 30-day window, searchable by app, team, model, and execution mode. Only calls recorded as live count toward the live estimate. The team table groups calls, blocks, and live estimates by each app’s current team. Select a team to filter the detailed usage and blocks below it. Switch the summary to Model to see successful calls and live estimated spend per model. The reporting window, selected team, and grouping are preserved in the shareable Reports URL. Reviewers can download the selected team or the full portfolio as separate CSV files. Earlier calls without a recorded mode remain visible separately. A separate table shows policy-blocked calls by app, reason, and execution mode. Reviewers can download the selected window as CSV with app and team labels, successful and blocked counts, and estimated cost. These events store no prompt, response, or key.

**Retirement review** lists active gateway apps whose latest recorded successful live call was at least 90 days ago, regardless of the reporting window. If the current activation date is known, it must also be at least 90 days ago. Older records without an activation date qualify based on their observed live call history. An app needs at least one recorded successful live call to qualify, so the simulation-only demo leaves this panel empty. A reviewer can open a review assigned to the app’s current owner. Opening a review leaves the app and its key active.

The owner checks for use outside the gateway and records a reason for keeping or retiring the app. Keeping the app defers another inactivity review for 90 days. Confirming retirement rechecks gateway activity and revokes the key. Ownership handover cancels a pending request. Requests and decisions appear in Audit history.

Set `governance.retirementReviewIntervalMinutes` to an integer from 15 to 10,080 to schedule retirement review requests. For a daily check, use `1440`. The task applies the same eligibility criteria and 90-day cooldown after a keep decision, then assigns a review to the app owner. The app’s lifecycle and gateway key stay as they were when the task opens a review. Audit history records the Backstage governance service as the requester. Leave the setting unset for reviewer-initiated requests.

**Median time to first Tier 3 decision** measures from the first pending submission to the first recorded overall approval or request for changes. It uses the available audit history across all reporting windows. The calculation includes elapsed time on UTC weekdays and excludes weekends. A partial sign-off or an app still waiting for a decision does not contribute to the median. Set `governance.firstDecisionTargetWeekdays` to a positive integer to flag pending reviews that reach your team’s target in Reports and the **Awaiting first decision** queue.

## Hosted workspace attestation

For provider-hosted apps where no admin API is available, the accountable owner can open the app details and confirm that the provider workspace, sharing, and data access match the declaration. Frontstage records who confirmed the settings and when in Audit history. The next confirmation is due in 90 days. Changing the owner or declared hosted settings clears the current confirmation. The scorecard highlights missing or overdue confirmations. Owners can open **My workspace confirmations** in Inventory to find their overdue and unconfirmed workspaces. Reviewers can open **Hosted workspace attestations** in Reports to find apps that need follow-up.

After a workspace is confirmed, owners, backup owners, and reviewers can select **Download workspace reminder** in the app details. The calendar event links to the app and includes a seven-day alert.

## Discover and claim a GitHub repository

The development profile scans public repositories in the Hugging Face organization tagged `llm`. HTTPS GitHub repository URLs match across case, trailing slashes, and the `.git` clone suffix. The topic is a discovery signal. Check that the repository represents an app your team actually operates before claiming it in a real workspace. On an unowned repository, **Check AI SDK dependencies** looks for recognized declarations in root `package.json`, `requirements.txt`, and `pyproject.toml` files on the default branch. For `pyproject.toml`, it checks standard project dependencies and optional extras. Results describe the files that could be checked. A declared SDK is a lead for review, and runtime use still needs separate verification.

1. Start with the reviewer profile and open **Discovery**. Select **Scan GitHub** to read repository metadata.
2. Select **Claim repository** on an unowned entry. You can prefill the form from a valid root `catalog-info.yaml` with an `AIApp` descriptor whose `spec.sourceUrl` matches the repository. Review the prefilled values before submitting. If the file is unavailable or invalid, complete the form manually.
3. Submit the form. The app appears in Inventory and the Discovery entry becomes **Registered**.

Reviewers can dismiss false positives with a reason and reopen them from the **Dismissed** filter. Dismissals survive rescans. Frontstage records who made each decision and when.

Signed-in builders can browse and claim repositories verified as public by Discovery. Reviewers can also work with private repositories that the configured discovery token can read. Rescan older discovery records to verify their visibility.

Set `governance.discovery.github.organization` and `topic` to use a different GitHub organization. For private repositories, supply a read-only GitHub token through `APP_CONFIG_governance_discovery_github_token`. A scan reads up to three pages of 100 matches, starting with the newest repositories. A complete scan removes missing unclaimed candidates from the queue and preserves their decision history. A partial scan keeps unseen candidates, including when a later page fails or the search exceeds 300 matches. Reviewers see whether a scan returned partial results. Set `governance.discovery.github.scanIntervalMinutes` to enable automatic scans on a 15-minute to 7-day interval. The queue shows the last scan’s time, trigger, and outcome. Open a registered app directly from Discovery or Portfolio reports. The app details URL can be shared with signed-in teammates.

## App directory

The **Directory** lets signed-in teammates find apps that their owners or reviewers have published. Open an active app in Inventory, enter a summary suitable for the directory and its HTTPS launch URL, then publish it. The listing shows the app name, summary, and launch link. The destination app handles access.

Owners and reviewers can update or remove a listing. The directory hides apps that no longer meet current launch requirements or whose catalog owners or team are unavailable. Leaving active status or transferring the accountable owner clears the listing.

A teammate can request access to a listed app with a short message. In the app details, the accountable owner or a reviewer can approve or decline the pending request. Owners can open **My pending access requests** in Inventory to find their apps awaiting a decision, including apps whose listing has since been removed. Requesters can use **Directory → My requests** to find pending requests and decisions for apps that are still listed. Frontstage records the decision. Provisioning and revoking access happen in the destination app.

## Approved connector registry

The **Builder guide** lists approved MCP servers and data connectors with their allowed access and highest data classification. Configure entries under `governance.approvedConnectors` with an ID, name, kind, description, access, classification, and optional HTTPS documentation URL. The reviewer profile uses two synthetic sandbox entries. The registry is guidance for registration and review. Runtime access and provider settings are managed separately.

## Building frontend screens

Use the [workspace screen recipes](docs/workspace/README.md) for shared components, desktop and phone references, and the browser regression check.

Backstage Analytics receives semantic events when a registration is saved or a starter download begins. Event attributes use fixed source and starter categories, delivery stage, and runtime AI use. App names, model names, owners, and form content are excluded. An analytics provider is needed to collect these events in a deployment.

## Deployment and roadmap

The dev server uses seed identities and SQLite. Before deployment, configure company SSO and the Backstage identity catalog provider, map reviewers to company identities, supply Postgres and the production URLs, and configure permissions for accessing the inventory. Production gateway operations, provider controls, additional discovery connectors, escalation, and deeper reporting remain later phases.

## Verify changes in a worktree

Run `yarn install --immutable` once per worktree. Use focused tests while editing and run `yarn verify:code` for reviewer configuration, TypeScript, lint, and unit tests. For a full checkpoint, install Chromium once with `yarn playwright install chromium` and run `yarn verify`. On Linux, use `yarn playwright install --with-deps chromium` if the browser system libraries are missing. If Playwright's Chromium build is unavailable on your development host, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to an installed Chromium executable.

Give concurrent worktrees different browser-test ports so they can run alongside the usual dev server. Playwright starts and stops each worktree's own server.

```sh
FRONTSTAGE_E2E_APP_PORT=3101 FRONTSTAGE_E2E_BACKEND_PORT=7101 yarn verify
```

Draft pull requests skip the automated verification job. Run checks in worktrees by default. Set the repository Actions variable `FRONTSTAGE_AUTOMATIC_VERIFICATION` to `enabled` to run the full check on a GitHub-hosted runner for ready PR updates, marking a PR ready, and pushes to `main`. Manual dispatch defaults to the local runner. Once this workflow lands on `main`, start the repository's isolated `frontstage-local` runner for on-demand verification. Dispatch the workflow from `main` and supply the reviewed commit to verify. The tested branch does not need its own copy of the dispatch inputs.

```sh
gh workflow run verify.yml --ref main -f verification_ref=REVIEWED_COMMIT_SHA
```

Use a commit you reviewed because the checkout runs its own install and test scripts on the local runner. When the runner is unavailable, run `yarn verify` in the feature worktree.

For an isolated Docker runner, register the Linux runner for this repository with `--ephemeral --labels frontstage-local`. Give it an isolated Docker network with a disposable PostgreSQL 17 container and set `BACKSTAGE_TEST_DATABASE_POSTGRES17_CONNECTION_STRING` in the runner container to that database. Set `BACKSTAGE_TEST_DISABLE_DOCKER=1` so Backstage uses the supplied test database without a Docker socket. The runner needs outbound access to GitHub and package registries and permission to install Playwright's Linux dependencies. The runner deregisters after the job, and you can remove its container, the test database, and the network.

The gateway browser test starts an isolated SQLite backend. To include PostgreSQL 17 in local unit checks, set `BACKSTAGE_TEST_DATABASE_POSTGRES17_CONNECTION_STRING` to a disposable test instance. Discovery unit tests use simulated GitHub responses.
