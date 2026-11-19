# Data Validation CLI

A dependency-free Node.js 24 starter for checking synthetic inventory data in a local JSON file. The validator does not call AI models, use the gateway, or modify the file.

## Run locally

```sh
npm start -- sample.json
npm test
```

The input must be a nonempty UTF-8 JSON array of inventory rows in a regular file up to 1 MiB. Each row needs a nonempty `itemId` that is unique after trimming and a nonnegative safe integer `quantity`. The CLI reports counts and row numbers. It omits row values from its output.

Exit status 0 means the data passed. Status 1 means the data has validation issues. Status 2 means the CLI could not read or parse the input, or it needs a file path.

## Adapt and register

Complete `PROJECT_BRIEF.md` with the input source, expected fields, allowed data, validation rules, delivery stage, and exit criteria. Have your coding agent read the brief and `AGENTS.md` before editing. `CLAUDE.md` imports the shared instructions for Claude Code.

Use synthetic files while developing. Before handling real data, confirm who can read the source files and where any validation reports can be shared.

Update `catalog-info.yaml` with the actual source URL, owner, team, purpose, audience, and data classification before registering the app in Frontstage. Reassess the delivery stage and review requirements before expanding use.
