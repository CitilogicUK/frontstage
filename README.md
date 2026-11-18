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
- **Bulk import.** A reviewer or authorized Backstage service can submit a spreadsheet exported as UTF-8 CSV using the [sample columns](examples/ai-apps.csv), or JSON in the form `{"apps":[...]}`. Each entry uses the descriptor's `spec` fields. In CSV, separate model names with `|`, use Yes or No for booleans, and put multiple connections in a JSON array inside the connections cell. Include `hosted.provider`, `hosted.workspace`, `hosted.sharing`, `hosted.dataAccess`, and, when applicable, `hosted.dataClassification` for provider-hosted apps. Batches of up to 100 records are atomic.

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
| GET    | `/apps/:id/history`          | Export reviewer-only change history for one app                    |

Set optional risk floors in `governance.tierPolicy`. The keys are `audience`, `classification`, `hostedSharing`, and `connection`. Values 1 through 3 can raise the built-in requirements. For example, set `governance.tierPolicy.classification.confidential: 3` to require critical review for confidential data. The live questionnaire uses `POST /api/governance/tier-preview`.

Critical apps start pending review and require a current approval before they can become active. Owners and backup owners cannot approve their own apps. Reviews expire after six months. The audit endpoint returns SHA-256-linked events recorded in the same transaction as each change. Independent retention and external verification remain deployment work.

## Building frontend screens

Use the [workspace screen recipes](docs/workspace/README.md) for shared components, desktop and phone references, and the browser regression check.

## Deployment and roadmap

The dev server uses seed identities and SQLite. Before deployment, configure company SSO and the Backstage identity catalog provider, map reviewers to company identities, supply Postgres and the production URLs, and configure permissions for accessing the inventory. The gateway, provider controls, discovery connectors, escalation, and broader reporting are later phases.

```sh
yarn tsc --noEmit
yarn test --watch=false --runInBand
```
