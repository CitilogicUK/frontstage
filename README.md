# AI App Governance

A Backstage portal for registering AI apps, agents, and automations and reviewing critical apps before launch. The governance backend owns the records. A Backstage entity provider publishes them as `AIApp` entities, using the app ID as the entity name. The published entity includes registration fields, ownership, lifecycle, and review status. Review notes, evidence links, tickets, and reminder state stay in governance records.

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

The **Risk assessment** preview shows which answers or workspace policy rules set the estimated tier. The same policy evaluates the record when you save. Owners, backup owners, and reviewers can expand **Current risk assessment** on saved records. If the current policy would assign a different tier, the panel also identifies the saved tier. Saving the app details again applies the current policy. Reviewers can open **Apps needing risk reassessment** in Reports to find non-retired records with a tier mismatch. The queue shows both tiers and puts increases first. Owners can open the reassessment notice in Inventory to see only their own apps that need an update.

- **Intake form.** Use Register to enter app details and preview the tier. The backend recalculates the tier before saving.
- **Repository.** Commit a descriptor using [examples/ai-app.yaml](examples/ai-app.yaml), then upload it under Import, submit it from CI, or use it when claiming a repository in Discovery.
- **Bulk import.** A reviewer or authorized Backstage service can submit a spreadsheet exported as UTF-8 CSV using the [sample columns](packages/app/public/examples/ai-apps.csv), or JSON in the form `{"apps":[...]}`. Each entry uses the descriptor's `spec` fields. Use the optional `starterId` field, for example `internal-api`, to retain a known starter in a bulk import. In CSV, set `usesAiAtRuntime` to No and leave `models` blank for software that runs without AI. Use `trial`, `poc`, `pilot`, or `production` in `deliveryStage`. Separate model names with `|`, use Yes or No for booleans, and put multiple connections in a JSON array inside the connections cell. Include `hosted.provider`, `hosted.workspace`, `hosted.sharing`, `hosted.dataAccess`, and, when applicable, `hosted.dataClassification` for provider-hosted apps. Batches of up to 100 records are atomic. In Import, select **Validate file** to preview calculated tiers and detect duplicate source URLs before saving. API consumers can send `?dryRun=true` to the repository or bulk import endpoint for the same preview.

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

### Read and register app records over MCP

From a checkout with dependencies installed, configure a local MCP client to launch `node /absolute/path/to/frontstage/scripts/catalog-mcp.mjs` over stdio. Set `FRONTSTAGE_MCP_BACKEND_URL` to the HTTPS Backstage backend base URL. For local development, a loopback URL such as `http://localhost:7007` also works. Supply an existing, authorized Backstage bearer credential as `FRONTSTAGE_MCP_TOKEN` through the client's secret or environment configuration.

Use `search_apps` to find registered apps by name or ID. It returns up to 20 matches by default and accepts a limit up to 50. Use `get_app` with the selected app ID. Both tools return catalog fields such as ownership, tier, lifecycle, and source URL.

Use `preview_risk` while drafting an app to check the effective data classification, calculated tier, and reasons. Provide the audience and classification along with any actions, connections, or hosted settings that apply. It uses the same policy as the registration questionnaire and saves no record.

Use `list_approved_models` with a Backstage user credential to read the gateway's approved model list and live output limits. Pass `classification` to see only models allowed for that data. The response also tells you whether the gateway is enabled and whether it supports production calls.

Use `list_approved_connectors` with a Backstage user credential to look up vetted MCP servers and data connectors. Pass `kind` as `mcp` or `data`, and pass the app's `classification` to filter by the connector's allowed data limit. Results include each connector's approved access and any configured documentation link.

Set `FRONTSTAGE_MCP_WRITE_ENABLED=true` in the MCP process environment to add the descriptor tools. Pass the YAML from a repository descriptor as `content` to `preview_descriptor` to check ownership, calculated tier, and source URL conflicts. After reviewing the preview, use `register_descriptor` with the same content to create the record. The MCP client controls interactive approval for `register_descriptor`. Backstage applies the same authentication, validation, and audit rules as the repository registration endpoint.

Set optional risk floors in `governance.tierPolicy`. The keys are `audience`, `classification`, `hostedSharing`, and `connection`. Values 1 through 3 can raise the built-in requirements. For example, set `governance.tierPolicy.classification.confidential: 3` to require critical review for confidential data. The live questionnaire uses `POST /api/governance/tier-preview`.

Critical apps start pending review and require a current approval before they can become active. Owners and backup owners cannot approve their own apps. Reviews expire after six months. Changing a critical app’s purpose, ownership, evidence, or risk inputs reopens its review and returns an active app to experimental. Moving a critical app to the production delivery stage also requires fresh approval. Changing the accountable owner revokes any existing gateway key. The new owner can issue a replacement. Review decisions require the current `updatedAt` value as `expectedUpdatedAt`. Reviewers can open **Audit history** on an app to see changes, including the previous and new tiers when a record is reassessed. The panel exports record and key history as JSON. The record events are SHA-256-linked and saved in the same transaction as each change. Key events record the action, actor, and time in a separate SHA-256 chain. Verify a downloaded file offline with `yarn audit:verify path/to/export.json`. Save the final SHA-256 digest shown in Audit history separately. Supply it as the second argument to check that the export ends at the saved digest. For a newer export, use `yarn audit:verify path/to/export.json --checkpoint <digest>` to verify that the chain still contains the earlier checkpoint. To verify the key history against a separately saved digest, add `--key-head <digest>` using the final key event digest shown in Audit history. Use `--key-checkpoint <digest>` to check that a newer export still includes an earlier saved key digest. Upgraded databases establish the key chain from their stored events at migration time. Older exports without key digests still support record-chain verification. The verifier identifies legacy exports separately from versioned exports with zero key events. You can combine a final digest and a checkpoint for either chain in one run to verify the endpoint and continuity with the history you previously reviewed.

## App templates

Open **Templates** and choose **AI-assisted software** for projects built with coding agents that do not call models at runtime. Every ZIP includes shared `AGENTS.md` instructions, a `CLAUDE.md` import, a project brief, and a registration descriptor. The instructions show how coding agents can use Frontstage MCP or the portal to check the project against workspace policy before registration. Choose a delivery stage and data classification before downloading to customize the brief and registration defaults. The instructions scale from trial and proof of concept through pilot and production. The brief includes exit criteria for the selected stage. The included `.gitignore` excludes local environment files and allows a placeholder-only `.env.example`. Delivery stage is separate from the calculated risk tier. Choose **Internal API** for a runnable Node.js starter with loopback-only defaults, a synthetic read-only endpoint, and tests. Choose **Internal web app** for a local browser interface with a read-only workflow and synthetic example data. Choose **Data validation** to check local JSON files and receive an exit code that scripts can use. All three runnable starters include the stage-specific brief and agent instructions.

For apps that call AI at runtime, choose the assistant, agent, or automation starter. Choose a model that the workspace approves for that classification. The ZIP and registration form use both choices. The generated client defaults to the workspace’s configured backend URL. Each ZIP includes a dependency-free Node.js client, offline client tests, a Frontstage registration descriptor, and activation instructions. Run `node --test` in the extracted folder with Node.js 24. Use **Register from template** to start the form with the starter’s defaults, or import its edited descriptor. Both paths record the declared starter on the app and in Audit history. In Reports, choose **Starter** under **Group inventory by** and select a count to open the matching Inventory records. The Inventory CSV includes the recorded starter ID. The agent drafts a plan and answer in two gateway calls. The automation summarizes a local text file.

## Gateway demo

Run this walkthrough with synthetic data. Follow [Run locally](#run-locally) for prerequisites, then start the reviewer profile against a fresh database. The default ports are 3000 and 7007. Use the parallel setup below if those ports are occupied.

```sh
export APP_CONFIG_backend_database_connection_directory="$(mktemp -d)"
yarn start --config ../../app-config.reviewer.yaml
```

In a second terminal at the repository root, run `yarn demo:seed` after the backend starts. Open [Frontstage](http://localhost:3000) in a private window and sign in as **Guest**. In this profile, Guest signs in as the reviewer. The seed creates seven records owned by `user:default/guest`, a separate demo identity, and prints a direct link to each record.

1. **Show both ways to build.** In **Templates**, compare **AI-assisted software** with **Gateway assistant**. In **Inventory**, **Stock count proof of concept** and **Purchase order pilot** both run without models or gateway keys. The stock count is Tier 1. The purchase order pilot is Tier 3 because it submits orders to a sandbox. Open it and try approving without human approval evidence, then confirm the safeguard and enter the synthetic link `https://example.com/evidence/sandbox-order-approval` to complete the review. Open **Audit history** to see the evidence on the decision. **Meeting summary demo** uses a model at runtime. Issue a key, select `gpt-4.1-mini`, and send `Summarize these synthetic notes: the team agreed to test the sandbox on Friday.` The result is marked as simulated. In **Reports**, group Inventory by **Starter** and select **Data validation** to open the stock count proof of concept. See [App templates](#app-templates).
2. **Hand off a critical app for review.** Open **Restricted intake demo** from **Reviews**. Issue a key and attempt a synthetic call with `gpt-4.1-mini`. The pending review blocks it. Open **Edit review ticket**, enter `https://example.com/reviews/restricted-intake` as the **Ticket URL**, then save. Select **Copy app link** to share the app record with a signed-in reviewer. Record an approval with sandbox-only scope in **Review notes**, set **Lifecycle** to active, and select **Update lifecycle**. Retry with the same key and model. The playground lists `gpt-4.1-nano` as unavailable for restricted data. See [Review evidence](#review-evidence) and [Separate critical sign-offs](#separate-critical-sign-offs).
3. **Trace model impact.** In **Reports**, choose **Declared model** under **Group inventory by**, then select the count for `gpt-4.1-nano` to open the matching records. The count includes declarations even when a call is blocked or no call is recorded. Back in **Reports**, set **Group gateway usage** to **Model** to see the successful simulated calls under **Other calls**. **Gateway policy blocks** shows the denied attempts. Live estimated spend stays at zero. See [Portfolio reports](#portfolio-reports).

4. **Verify the review and key history.** Reopen **Restricted intake demo**, expand **Audit history**, and download the audit JSON. Copy the final record and key event digests shown in the panel. From the repository root, run the following with the downloaded file and the two copied values. The output includes the number of verified events in each chain.

   ```sh
   yarn audit:verify path/to/export.json RECORD_DIGEST --key-head KEY_DIGEST
   ```

5. **Show how connector access changes risk.** Open **Stock count proof of concept**. In **Edit app details**, add `user:default/backup` as backup owner and add **Catalog sandbox** with **Read** access under **Connected systems**. Save and check that the app is now Tier 2. Edit the connection to **Inventory sandbox** with **Write** access and save again. The app moves to Tier 3 and enters Reviews even though it runs without AI. **Declared connections** also flags that the write connector is approved only for public data and this app declares internal data. In **Audit history**, check the removed read declaration, the added write declaration, and the risk-tier change.

6. **Reconcile usage outside the gateway.** In **Reports → Outside-gateway usage**, download the sample CSV, upload it, and select **Preview outside-gateway usage**. The seeded **Hosted workspace demo** matches 12 calls. The other 3 calls belong to an unregistered source. Select **Save reconciliation**, then open **Direct link to saved reconciliation** in the same signed-in browser to confirm what was recorded.
7. **Resolve the unmatched source.** Select **Recheck against current Inventory**, then choose **Unmatched** and **Start registration**. The source URL and observed model are prefilled. Confirm `gpt-4.1-mini` and register **Unregistered assistant demo** as an assistant, with synthetic purpose, **Code repo** as the platform, `user:default/guest` as owner, and `group:default/platform` as team. Back in Reports, open the new app record from **Current Inventory matches**. The summary now shows **0 unmatched (0 calls)**. Close the record and choose **Open original reconciliation** to see the original 3 unmatched calls. See [Review usage outside the gateway](#review-usage-outside-the-gateway).

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

### Reassess an app after a policy change

Start with the seeded reviewer demo above. Stop the dev server, then restart from the same shell so it uses the same database and ports. Raise the minimum tier for internal data in this local demo:

```sh
APP_CONFIG_governance_tierPolicy_classification_internal=2 yarn start --config ../../app-config.reviewer.yaml
```

1. Sign in as the reviewer and open **Reports**. Select **View apps needing reassessment**.
2. In Inventory, find **Stock count proof of concept**. Its saved tier is 1 and its current policy tier is 2. Open the record and expand **Current risk assessment** to see the policy reason.
3. Close the record and select **Reassess** on its row. Enter `user:default/backup` as **Backup owner**, then select **Save app details**. The app moves to Tier 2 and receives an attestation due date.
4. Open **Audit history** and check the Tier 1 to Tier 2 transition. Close the record to return to the queue, where the stock count app has cleared.

Use a fresh demo database to replay from the original tiers.

### Live OpenAI call

Set `OPENAI_API_KEY` in your shell, then start with the live adapter overlay. Use **Meeting summary demo** for the live call. In its gateway panel, select **Production** and issue a key explicitly. The live overlay permits only public and internal data. The restricted scenario is intended for the simulation.

```sh
APP_CONFIG_governance_gateway_openaiApiKey="$OPENAI_API_KEY" \
  yarn start --config ../../app-config.reviewer.yaml --config ../../app-config.gateway-openai.yaml
```

A software app can call the same endpoint, `POST /api/governance/gateway/chat`, with its app key as the bearer credential and JSON containing `model` and `prompt`. Set `expectedEnvironment` to `sandbox` or `production` to reject a key from the wrong environment before any provider call. Downloaded gateway starters send `sandbox` by default. The portal uses Backstage credentials for `POST /api/governance/apps/:id/gateway-key` and `GET /api/governance/apps/:id/usage`. Use `?environment=production` when issuing, checking or revoking a production key. Unqualified key requests use the sandbox slot. Sandbox calls are simulated even when the gateway is configured for live calls. Existing keys migrate to sandbox. Live integrations must issue and configure a new production key. Rolling back the key environment migration invalidates both types of key. Production issuance requires live mode and an active app that meets launch requirements.

The gateway stores app key hashes and usage metadata. The app panel shows input and output token counts for live calls with token data. Estimates use the rates in `app-config.development.yaml`. Set a model’s `maxCompletionTokens` to adjust its per-call live output limit. The default is 1,024 tokens. Set `governance.gateway.upstreamTimeoutMs` from 1,000 to 60,000 to bound live provider requests, including the response body. The default is 20,000 ms. Provider failures log the elapsed milliseconds and failure category without prompt or response content. The Builder guide lists the gateway’s approved models and data classifications. Key issuance rotates the key in the selected environment. Set `governance.gateway.requestsPerMinute` to cap accepted requests per app in each UTC minute. Excess requests return `429` with `Retry-After` and appear in policy block reporting. The development limit is 30 per app. Set `governance.gateway.appRateLimits` to a list of `sourceUrl` and `requestsPerMinute` pairs to override the default for specific apps. The app’s gateway panel shows its effective limit. Configure `governance.gateway.appSpendThresholds` with `sourceUrl` and `monthlyUsd` pairs to display month-to-date estimated live spend and flag when it reaches the threshold. Reviewers can see apps that reached their threshold in Portfolio Reports. Thresholds are informational by default. Set `stopAtThreshold: true` on an entry to block new live calls after the recorded estimate reaches its threshold. Calls already in flight can take the estimate above it. The playground shows when the threshold pauses production prompts and lets owners refresh usage after a policy change or the monthly reset. In a live deployment, the app scorecard and the owner’s scorecard issues also surface reached thresholds. Owners and reviewers can check key status or revoke a key from the playground. Revocation blocks subsequent requests and records the actor and time. Ownership transfer, retirement and switching to no runtime AI automatically revoke keys in both environments. Reactivating an app requires a fresh key.

Successful gateway responses include a `Server-Timing` header. The `frontstage` duration covers key and request-field validation through usage recording, with the upstream interval excluded. Live responses also include `provider`, measured from the upstream request through reading and validating its response body. Both durations are in milliseconds. Sandbox calls include only `frontstage`.

## Separate critical sign-offs

To require two independent sign-offs, configure `governance.reviewTracks.security` and `governance.reviewTracks.dataProtection` as disjoint lists of Backstage user references. Reviewers can record a decision only for their assigned track. Both approvals must be current before launch. The default local demo uses a combined reviewer decision.

With split reviews enabled, reviewers can select **My pending sign-offs** in Reviews to find apps still waiting for their assigned Security or Data Protection decision. When the first-decision wait is available, it breaks ties between equally urgent apps. The filtered queue can be downloaded as CSV, with the app, owner, team, pending sign-offs assigned to you, the scheduled review date, a direct link to each app, and the first-decision wait in weekdays when available.

## Tier 3 renewal exceptions

An independent reviewer can grant an already-active Tier 3 app a renewal exception before its current approval expires. Record the reason and choose an expiry no more than 30 days after the scheduled review date. The original due date stays visible. Calls using an existing gateway key can continue until the exception expires or is revoked, subject to the usual ownership, data and model checks.

The app still needs fresh approval for first launch, reactivation after its approval has expired, or a material change. A new review decision or leaving the active lifecycle clears the exception. Grant and revoke actions appear in audit history. Reviewers can open **Renewal exceptions** in Reports to see recorded exceptions on active Tier 3 apps, ordered by expiry. Separate critical sign-off tracks require their normal renewals.

## Engineering co-ownership

Set `governance.graduationGroups` to the Backstage groups that can accept co-ownership of Tier 3 production apps. An owner or reviewer can nominate an active direct member of one of those groups. The nominee receives a private Backstage notification linking to the app in Inventory and records their decision there. The accountable owner receives a private notification when the nominee accepts or declines. The handoff and decision appear in Audit history. The existing accountable owner and gateway access stay in place. If the co-owner leaves the role, the app owner or another reviewer can end the handoff with a reason and nominate a replacement. Audit history records who ended it, the former co-owner, and the reason.

For a local walkthrough, start the reviewer profile, open a Tier 3 app, and set its delivery stage to **Production**. In **Engineering co-owner**, nominate `user:default/engineer`. Stop the server and restart it against the same database with the engineering identity, then sign in in a new private browser session.

```sh
APP_CONFIG_auth_providers_guest_userEntityRef=user:default/engineer \
  yarn start --config ../../app-config.reviewer.yaml
```

Open the app from Inventory and accept or decline the nomination. The reviewer profile includes a synthetic engineering group. Set your own groups and identities in a deployment.

## Review evidence

An owner or reviewer can open **Edit review ticket** in a non-retired Tier 3 app’s details to link or remove an existing work item without editing the rest of the app. Owners, backup owners, and reviewers can open the linked ticket. Changing the link preserves the current approval. In **Reviews → Missing review ticket**, opening an app expands **Edit review ticket** automatically. Select **Download missing review tickets CSV** to export the filtered queue with owners, teams, review status, renewal dates, app links, configured sign-off statuses, and elapsed weekdays for apps awaiting their first decision. The queue flags apps that have reached the first-decision target when one is configured. Select **Copy review ticket context** to prepare a plain-text draft for the ticket, with the app record link, owner, team, review status, and scheduled renewal when available. With separate review tracks, the draft also includes the status of each required sign-off. Review notes and evidence stay in Frontstage. The ticket system manages ticket creation, access, and status. To offer **Open ticket creation page** in the same panel, set `app.reviewTicketCreateUrl` to a credential-free HTTPS URL. This browser-visible setting must contain only the destination. Frontstage opens it in a new tab and sends no app context to it.

Use **Edit app details** in the app details to save links to test evidence, a data-flow diagram, or an incident plan. The owner, backup owner, and reviewers can read the links. New or changed ticket and evidence URLs must be at most 2,048 characters and contain no URL credentials. Changing evidence reopens a critical app’s review.

Set `governance.requireHumanApprovalEvidence` to true to require reviewers approving critical apps that take actions to confirm the human approval safeguard and provide an HTTPS evidence URL. With separate review tracks, each approving reviewer supplies that confirmation. Frontstage records the evidence on the approval event in Audit history. The setting applies when a new decision is made. The app or the destination system implements and enforces the human approval step.

## Owner attestation

In Inventory, switch **Ownership** to **My apps** to see your apps, with upcoming and overdue governance work shown first. The accountable owner of a Tier 2 app can confirm its current purpose, ownership, and declared risk inputs in the app details. Frontstage records the attestation in the audit history and sets the next review date one year later. After an ownership transfer, the new Tier 2 owner’s first attestation is due immediately. Owners, backup owners, and reviewers can download an individual review or attestation date as a calendar file with a seven-day reminder. Use **Apps I back up** to find records where you’re listed as backup owner. Both ownership views let you download scheduled tier reviews, yearly attestations, and hosted workspace confirmations for the current filtered list in one calendar file. Filters select which apps to export, and the calendar includes all scheduled dates for each matching app. Use **Due in the next 30 days** under **Review status** to focus on upcoming renewals and attestations. Reviewers can open **View upcoming reviews** in Reports and download scheduled tier reviews and attestations for the filtered portfolio in one calendar file.

Set `governance.reviewReminderIntervalMinutes` from 15 to 10,080 to enable in-app reminders. Frontstage checks scheduled Tier 2 attestations, Tier 3 renewals, and hosted workspace confirmations that are due within seven days or overdue. The current accountable owner receives one reminder per app, due date, and reminder type in **Notifications**, with a link to the app. Owners of active apps in explicitly approved hosted workspaces also get a prompt when a confirmation is missing, once per owner and activation. Changing declared hosted settings or transferring ownership clears an existing confirmation. The current owner gets a new confirmation prompt when the app is active in an approved workspace, even if they owned the app before. Leave the setting unset to disable scheduled reminders.

With scheduled reminders enabled, set `governance.reviewManagerEscalationDays` to opt in to manager notifications. For example, use `14` to escalate a Tier 2 or Tier 3 renewal after 14 overdue calendar days. Set the `governance.backstage.io/manager` annotation on the owner's managed Backstage User entity to their manager's full User reference, such as `user:default/team-manager`. Frontstage sends the reminder to the owner first. It sends one escalation per owner and renewal date when the manager is active in the Catalog and the renewal is still overdue. In **Reports → Manager escalations**, reviewers can see the configured delay, which overdue renewals triggered a manager notification, and when Frontstage sent it. The report indicates when either the reminder schedule or escalation delay is unset. The report reloads after you save an app change. Use **Refresh manager escalations** to check for scheduler activity or changes made by someone else.

Set `governance.reviewGatewayPauseDays` to opt in to pausing Tier 2 gateway requests after the configured number of overdue calendar days. This requires scheduled reminders and manager escalation, and the pause delay must be at least the manager escalation delay. Frontstage pauses requests once the manager notification has succeeded for the current app owner and deadline. The app scorecard and **My scorecard issues** show when gateway access is paused. The playground disables prompts while it shows the pause and offers a usage refresh. Completing the attestation resumes access with the same credential. Tier 3 continues to use its approval and renewal exception rules.

## Backup owner handover

When Backstage marks an accountable owner inactive or no longer has their user record, the registered backup owner can open the app from **Inventory → Apps I back up** and confirm the handover. Tier 2 and Tier 3 apps need a different active backup owner. Frontstage checks the catalog and the current app revision before transferring ownership.

A handover revokes the old gateway key and appears in Audit history. Tier 2 apps need an attestation from the new owner. Tier 3 apps return to review before they can go live again.

## App scorecards

Owners, backup owners, and reviewers can open **App scorecard** in an app’s details. In Inventory, **My scorecard issues** lists active apps you own with failed checks and shows what needs attention. It checks catalog ownership, review status, and, for gateway apps, activation and model policy. The activity check uses live calls recorded in the last 90 days and identifies simulation-only activity separately. For provider-hosted apps, set `governance.approvedHostedWorkspaces` to a list of `provider` and `workspace` pairs. The scorecard checks the app’s declaration against that list. Add optional `allowedSharing` and `allowedDataAccess` lists to a workspace entry to restrict declarations for that workspace. Omit either list to leave that setting unrestricted. The Builder guide shows configured restrictions. Matching declarations are required for activation and workspace attestation. Owners still verify actual settings in the provider before confirming them.

## Portfolio reports

Inventory supports filtering by lifecycle and can download the current search and filter results as CSV. Inventory and Reviews show elapsed days for overdue reviews and attestations with scheduled dates. The overdue Inventory filter puts the oldest due dates first, and the CSV includes the same overdue age for dated items and direct links to the app records. The export includes ownership, classification, risk, delivery stage, runtime AI use, and review status.

**GitHub discovery coverage** shows what share of visible, non-dismissed repositories have a registered app. It flags partial or failed scans, links to unowned repositories, and offers a retry when coverage cannot be loaded.

Open **Reports** for the non-retired inventory count, critical apps needing review, and the percentage of non-retired Tier 2 and Tier 3 apps past their review or attestation date. The lifecycle, platform, risk tier, effective data classification, and registration source breakdowns link to matching Inventory rows. Git repository groups descriptor imports and Discovery claims together. Inventory CSV includes the recorded registration source and the current policy tier where the viewer can see the assessment. The existing risk tier column gives the saved tier. The delivery-stage table counts all registered apps by runtime AI use, including retired records. Select a stage or a runtime AI count to open the matching Inventory records. Reviewers can open apps with missing or inactive owners, backup owners, or teams from the **Ownership issues** panel. Apps whose accountable owner is unavailable and that have no active backup appear first. Select **No active owner or backup** to share the filtered report URL or download just those apps as CSV. Each exported issue includes a direct link to the app record. The reviewer profile also shows successful gateway calls and estimated cost over a selectable 24-hour, seven-day, or 30-day window, searchable by app, team, model, and execution mode. Only calls recorded as live count toward the live estimate. Under **Live estimated cost**, expand **Estimate gateway spend share** and enter model spend outside Frontstage in USD for the same window. The estimate divides live gateway cost by live gateway cost plus the amount you enter. Frontstage keeps that amount on the current page and clears it when the window changes. The optional CSV includes the UTC window start, window length, both USD amounts, and the estimated share as a fraction. The team table groups calls, blocks, and live estimates by each app’s current team. Select a team to filter the detailed usage and blocks below it. Switch the summary to Model to see successful calls and live estimated spend per model. The reporting window, selected team, and grouping are preserved in the shareable Reports URL. Reviewers can download the selected team or the full portfolio as separate CSV files. Earlier calls without a recorded mode remain visible separately. A separate table shows policy-blocked calls by app, reason, and execution mode. Calls blocked because the saved tier differs from current policy appear as **Risk reassessment required**. Reviewers can download the selected window as CSV with app and team labels, successful and blocked counts, and estimated cost. These events store no prompt, response, or key.

Set `governance.ownershipObservationIntervalMinutes` from 15 to 10,080 to observe unavailable accountable owners on a schedule. Reports and the ownership CSV show the first successful check that found the current owner unavailable. A successful check that finds the owner active clears the observation. The date reflects when Frontstage observed the gap. The Reports summary counts current accountable-owner gaps first observed more than 30 days ago. It indicates when tracking is off or current gaps lack a recorded observation. Select **View long-running owner gaps** or use the **Owner unavailable over 30 days** filter to review and export the matching apps, including apps with an active backup. Leave the setting unset to disable scheduled ownership observation.

**Retirement review** lists active gateway apps whose latest recorded successful live call was at least 90 days ago, regardless of the reporting window. If the current activation date is known, it must also be at least 90 days ago. Older records without an activation date qualify based on their observed live call history. An active app with no recorded live calls also qualifies after 90 days if its activation date is known and it has a production key. Sandbox-only apps need observed live history to qualify. A reviewer can open a review assigned to the app’s current owner. Opening a review leaves the app and its key active.

When a manual or scheduled retirement review opens, the assigned owner receives a private Backstage notification that links to their pending retirement decisions. The owner checks for use outside the gateway and records a reason for keeping or retiring the app. Keeping the app defers another inactivity review for 90 days. Confirming retirement rechecks gateway activity and revokes the key. Ownership handover cancels a pending request. Requests and decisions appear in Audit history.

Set `governance.retirementReviewIntervalMinutes` to an integer from 15 to 10,080 to schedule retirement review requests. For a daily check, use `1440`. The task applies the same eligibility criteria and 90-day cooldown after a keep decision, then assigns a review to the app owner. The app’s lifecycle and gateway key stay as they were when the task opens a review. Audit history records the Backstage governance service as the requester. Leave the setting unset for reviewer-initiated requests.

**Median time to first Tier 3 decision** measures from the first pending submission to the first recorded overall approval or request for changes. It uses the available audit history across all reporting windows. The calculation includes elapsed time on UTC weekdays and excludes weekends. A partial sign-off or an app still waiting for a decision does not contribute to the median. Set `governance.firstDecisionTargetWeekdays` to a positive integer to flag pending reviews that reach your team’s target in Reports and the **Awaiting first decision** queue.

### Review usage outside the gateway

In **Reports → Outside-gateway usage**, reviewers can preview an export of calls already identified by their provider or billing records as outside Frontstage. Map each row to a registered app’s source URL when known. The preview links matches to Inventory. The summary shows how many calls have no app match. Select **Unmatched** to review those rows in descending call order. Download the CSV to share the full reconciliation, including the reporting window, call totals, and matched app IDs. The preview does not contact the provider or save the export. Select **Save reconciliation** to record the reporting window, usage rows, and app matches at save time. Open a result under **Saved reconciliations** to review or download it later. Use **Direct link to saved reconciliation** to share it with another signed-in reviewer. Select **Recheck against current Inventory** to see today’s matches and act on unmatched rows. Rechecking leaves the saved result available as originally recorded. The list starts with the 20 most recent saves. Select **Load older reconciliations** to browse earlier results. Equivalent submissions reopen the original save.

```json
{
  "from": "2026-06-01T00:00:00Z",
  "to": "2026-06-08T00:00:00Z",
  "rows": [
    {
      "sourceUrl": "https://example.com/frontstage-demo/meeting-summary",
      "model": "gpt-4.1-mini",
      "calls": 12
    }
  ]
}
```

Submit up to 100 rows with one total per source URL and model in the stated UTC window. Include only source URLs, model IDs, and counts.

## Hosted workspace attestation

For provider-hosted apps where no admin API is available, the accountable owner can open the app details and confirm that the provider workspace, sharing, and data access match the declaration. Frontstage records who confirmed the settings and when in Audit history. The next confirmation is due in 90 days. Changing the owner or declared hosted settings clears the current confirmation. The scorecard highlights missing or overdue confirmations. Owners can open **My workspace confirmations** in Inventory to find their overdue and unconfirmed workspaces. Reviewers can open **Hosted workspace attestations** in Reports to find apps that need follow-up.

After a workspace is confirmed, owners, backup owners, and reviewers can select **Download workspace reminder** in the app details. The calendar event links to the app and includes a seven-day alert.

## Discover and claim a GitHub repository

The development profile scans public repositories in the Hugging Face organization tagged `llm`. HTTPS GitHub repository URLs match across case, trailing slashes, and the `.git` clone suffix. The topic is a discovery signal. Check that the repository represents an app your team actually operates before claiming it in a real workspace. On an unowned or registered repository, **Check AI SDK dependencies** looks for recognized declarations in root `package.json`, `requirements.txt`, and `pyproject.toml` files on the default branch. For `pyproject.toml`, it checks standard project dependencies and optional extras. Results describe the files that could be checked. A declared SDK is a lead for review, and runtime use still needs separate verification.

1. Start with the reviewer profile and open **Discovery**. Select **Scan GitHub** to read repository metadata.
2. Select **Claim repository** on an unowned entry. You can prefill the form from a valid root `catalog-info.yaml` with an `AIApp` descriptor whose `spec.sourceUrl` matches the repository. Review the prefilled values before submitting. Cancelling a claim returns you to the current Discovery search, status, and page. If the file is unavailable or invalid, complete the form manually.
3. Submit the form. The app appears in Inventory and the Discovery entry becomes **Registered**.

Reviewers can dismiss false positives with a reason and reopen them from the **Dismissed** filter. Use **Download repositories CSV** to export every repository matching the current search and status, including matches on other pages. The CSV includes repository and linked app URLs. Discovery links preserve the current search, status, and page for other signed-in users. Dismissals survive rescans. Frontstage records who made each decision and when.

Signed-in builders can browse and claim repositories verified as public by Discovery. Reviewers can also work with private repositories that the configured discovery token can read. Rescan older discovery records to verify their visibility.

Set `governance.discovery.github.organization` and `topic` to use a different GitHub organization. For private repositories, supply a read-only GitHub token through `APP_CONFIG_governance_discovery_github_token`. A scan reads up to three pages of 100 matches, starting with the newest repositories. A complete scan removes missing unclaimed candidates from the queue and preserves their decision history. A partial scan keeps unseen candidates, including when a later page fails or the search exceeds 300 matches. Reviewers see whether a scan returned partial results. Set `governance.discovery.github.scanIntervalMinutes` to enable automatic scans on a 15-minute to 7-day interval. The queue shows the last scan’s time, trigger, and outcome. Open a registered app directly from Discovery or Portfolio reports. The app details URL can be shared with signed-in teammates.

## Reconcile a hosted provider inventory

A reviewer can open **Discovery → Hosted inventory snapshot** and upload or paste a JSON export containing up to 100 entries. Uploaded files can be up to 1 MB. Each entry needs an app name, provider, enterprise workspace and a distinct HTTPS source URL without credentials.

```json
{
  "apps": [
    {
      "name": "Hosted notes",
      "provider": "Example AI",
      "workspace": "Enterprise",
      "sourceUrl": "https://example.com/apps/notes"
    }
  ]
}
```

Add optional `sharing`, `dataAccess`, or `dataClassification` values as reported by the provider. Use the same values as the registration form, such as `public link` for sharing or `none` for data access. Frontstage compares supplied settings with the saved declarations and checks workspace policy when both sharing and data access are supplied.

Preview matches the source URLs against Inventory. Select **Review registered settings** when there is a workspace or settings mismatch. The editor starts with the saved declaration. Correct it only if the declaration is wrong, then use **Recheck snapshot** to compare it again. Open the record for other matches or prefill registration for an unmatched entry. Confirm any prefilled sharing, data access, and hosted classification, then complete ownership, model and risk details before submitting. Submitted apps appear under **Hosted snapshot** in Inventory and Reports. Select **Download hosted snapshot CSV** to share the matches, observed settings, declaration differences, and policy results. Preview does not save the snapshot or create records. This prototype uses an offline snapshot supplied by the reviewer. To demonstrate the three outcomes, seed a fresh reviewer-profile database, select **Download sample JSON**, then upload it before changing the workspace on **Hosted workspace demo**. The preview shows one observed sharing mismatch, one workspace mismatch and one unregistered app.

## Preview outside-gateway usage

After running `yarn demo:seed` with the reviewer profile, open **Reports → Outside-gateway usage**. Select **Download sample usage JSON**, upload it, and select **Preview outside-gateway usage**. The synthetic file reports 15 calls. One row links to **Hosted workspace demo** in Inventory, and one has no matching record. Select **Download outside-gateway usage CSV** to export both outcomes. On the unmatched row, **Start registration** prefills the source URL. Complete the form and submit it to create the record. Cancel returns to the same preview. After a successful registration, Reports refreshes matches for the same usage rows. The app record shows **Outside-gateway usage** as its registration source. Use the same source to filter Inventory or group apps in Reports.

For your own data, upload a JSON or CSV file up to 1 MB, or paste JSON into the form. For CSV, use **Download sample usage CSV** as a template. The five columns are `window_start_utc`, `window_end_utc`, `source_url`, `model`, and `calls`. Use the same UTC reporting window on every row. Supply UTC `from` and `to` timestamps and up to 100 rows with an HTTPS `sourceUrl`, a `model`, and a positive integer `calls` value. The preview matches by source URL and does not store the file or monitor provider traffic. Saving requires source URLs without query strings or fragments. Saved rows do not contribute to gateway totals.

## App directory

The **Directory** lets signed-in teammates find apps that their owners or reviewers have published. Open an active app in Inventory, enter a summary suitable for the directory and its HTTPS launch URL, then publish it. The listing shows the app name, summary, and launch link. The destination app handles access.

Owners and reviewers can update or remove a listing. The directory hides apps that no longer meet current launch requirements or whose catalog owners or team are unavailable. Leaving active status or transferring the accountable owner clears the listing.

A teammate can request access to a listed app with a short message. The accountable owner receives a private Backstage notification linking to their pending requests. In the app details, the accountable owner or a reviewer can approve or decline the pending request. Owners can open **My pending access requests** in Inventory to find their apps awaiting a decision, including apps whose listing has since been removed. Requesters can use **Directory → My requests** to see their request status, including when a listing is unavailable. Frontstage records the decision in Audit history with the decision-maker and timestamp, and sends the requester a private Backstage notification linking to **My requests**. The decision stays available there if notification delivery fails. Provisioning and revoking access happen in the destination app.

## Approved connector registry

The **Builder guide** lists approved MCP servers and data connectors with their allowed access and highest data classification. Configure entries under `governance.approvedConnectors` with an ID, name, kind, description, access, classification, and optional HTTPS documentation URL. The reviewer profile uses two synthetic sandbox entries. When a builder declares connected system access, registration shows registry entries that match the requested access and allow the selected data classification. Select **Use** beside a matching connector to fill the first connected-system name. Review and edit the name before submitting. Owners and reviewers can compare saved **Declared connections** with registry limits in app details. Frontstage looks up entries by declared name and compares access and effective data classification. A mismatch shows the access and maximum classification recorded in the registry. Reviewers can open **Reports → Connector discrepancies** to find non-retired apps with mismatched or unlisted declarations. Opening a result focuses **Connected systems** in the app editor. Saving a correction updates the report as soon as the record is saved. Update the declarations in **Edit app details → Connected systems**. Saving recalculates risk and reopens a Tier 3 review when required. Audit history shows which connection declarations were added or removed, alongside any risk-tier change. The registry is guidance for registration and review. Runtime access and provider settings are managed separately.

## Building frontend screens

Use the [workspace screen recipes](docs/workspace/README.md) for shared components, desktop and phone references, and the browser regression check.

Backstage Analytics receives semantic events when a registration is saved or a starter download begins. Event attributes use fixed source and starter categories, delivery stage, and runtime AI use. App names, model names, owners, and form content are excluded. The `register-app` event includes the saved risk tier and elapsed seconds from opening the form to successful save, including retries. Use the median event value for Tier 1 to track the registration time target. The metric covers successful registrations through the interactive form. After successful registration, builders can optionally rate the experience. The `rate-registration` event records a rating of 1 (dissatisfied), 2 (neutral), or 3 (satisfied), plus source and saved tier. Compare the percentage of satisfied responses over time and report the response count alongside it. An analytics provider is needed to collect these events in a deployment.

## Deployment and roadmap

The dev server uses seed identities and SQLite. Before deployment, configure company SSO and the Backstage identity catalog provider, map reviewers to company identities, supply Postgres and the production URLs, and configure permissions for accessing the inventory. Production gateway operations, provider controls, additional discovery connectors, and deeper reporting remain later phases.

The prototype evidence guide covers demo scenarios, metric scope, and checks that need a pilot environment. [Prototype evidence](docs/prototype-evidence.md)

### PostgreSQL for a pilot

Create a dedicated PostgreSQL database and a Frontstage login role that can create schemas in that database. Backstage creates a separate schema for each plugin and runs its migrations at startup. The login can use an ordinary database role with no cluster-wide database creation privileges.

Set `FRONTSTAGE_POSTGRES_URL` in the backend environment and load the PostgreSQL overlay after the base configuration. Use a connection URL with `sslmode=verify-full` and a trusted server certificate for remote databases. A local development trial can use `yarn start --config ../../app-config.reviewer.yaml --config ../../app-config.postgres.yaml` and the existing demo seed command. [PostgreSQL overlay](app-config.postgres.yaml)

The profile starts with the records in the chosen PostgreSQL database. Use a dedicated pilot database and seed only synthetic data for the demo.

### GitHub sign-in for a pilot

The base app offers GitHub sign-in. The development and reviewer profiles use Guest, and the GitHub overlay disables Guest if those profiles are also loaded.

Register a GitHub OAuth app with the Frontstage frontend URL and the callback `<backend-base-url>/api/auth/github/handler/frame`. Set `FRONTSTAGE_GITHUB_CLIENT_ID` and `FRONTSTAGE_GITHUB_CLIENT_SECRET` in the backend environment. Load [the GitHub sign-in overlay](app-config.github-signin.yaml) after the base configuration. For a local trial, run `yarn start --config ../../app-config.github-signin.yaml` after setting the OAuth values and providing the mapped Catalog users.

Each allowed user needs a managed Backstage User entity with the `github.com/user-id` annotation set to their GitHub GraphQL node ID. For example, look up the ID with `gh api users/LOGIN --jq .node_id`. Use administrator-managed Catalog providers or locations for identity mappings. The overlay disables Catalog API writes, including location registration. Frontstage app registration remains available through its governance API. Start the pilot Catalog with trusted sources only. At sign-in and session refresh, Frontstage issues an identity only for a matching Catalog user whose `governance.backstage.io/active` annotation is absent or set to a value other than `false`. Reviewer permissions come from the mapped Backstage user references in `governance.reviewers`. Use your company’s approved identity provider if GitHub identities are outside the pilot’s scope.

### Build and run the pilot image

Build the Backstage frontend and backend on the same Node 24 version used by the image. Build the image from the repository root.

```sh
yarn install --immutable
yarn build:all
docker build -f packages/backend/Dockerfile -t frontstage:pilot .
```

Supply `FRONTSTAGE_POSTGRES_URL`, `FRONTSTAGE_GITHUB_CLIENT_ID`, and `FRONTSTAGE_GITHUB_CLIENT_SECRET` through the runtime environment. Mount an operator-managed Catalog configuration with the mapped User and Group sources and `governance.reviewers`. Use the public HTTPS URL of the reverse proxy for both frontend and backend so the container serves the UI and APIs from one origin.

```sh
docker run --rm -p 127.0.0.1:7007:7007 \
  -e FRONTSTAGE_POSTGRES_URL -e FRONTSTAGE_GITHUB_CLIENT_ID -e FRONTSTAGE_GITHUB_CLIENT_SECRET \
  -e APP_CONFIG_app_baseUrl=https://frontstage.example.com \
  -e APP_CONFIG_backend_baseUrl=https://frontstage.example.com \
  -e APP_CONFIG_backend_cors_origin=https://frontstage.example.com \
  -v "$PWD/app-config.identity.local.yaml:/app/app-config.identity.local.yaml:ro" \
  frontstage:pilot \
  --config app-config.yaml --config app-config.postgres.yaml \
  --config app-config.github-signin.yaml --config app-config.identity.local.yaml
```

The image uses the PostgreSQL and GitHub pilot profiles by default. Docker health checks use Backstage readiness at `/.backstage/health/v1/readiness` on the container’s backend port. The check uses `APP_CONFIG_backend_listen_port` when set, and 7007 otherwise.

Run `yarn test:pilot-image` after building `frontstage:pilot`. Pass an image tag as an argument to check another local build. The check uses a disposable PostgreSQL 17 container and placeholder OAuth credentials, and verifies readiness, the packaged UI, and the GitHub redirect without contacting GitHub.

## Verify changes in a worktree

Run `yarn install --immutable` once per worktree. Use focused tests while editing and run `yarn verify:code` for reviewer configuration, TypeScript, lint, unit tests, the starter projects’ offline tests, and the audit verifier tests. For a full checkpoint, install Chromium once with `yarn playwright install chromium` and run `yarn verify`. On Linux, use `yarn playwright install --with-deps chromium` if the browser system libraries are missing. If Playwright's Chromium build is unavailable on your development host, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to an installed Chromium executable.

Give concurrent worktrees different browser-test ports so they can run alongside the usual dev server. Playwright starts and stops each isolated worktree’s server. Servers started by `yarn test:e2e` use a temporary SQLite database directory unless you supply `APP_CONFIG_backend_database_connection_directory`. A reused dev server keeps its configured database.

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
