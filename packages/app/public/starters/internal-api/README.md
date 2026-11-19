# Internal API

A dependency-free Node.js 24 starter with two read-only endpoints. It returns synthetic data and requires no runtime AI or gateway key.

## Run locally

Run `npm start` in this directory. In another terminal, try the endpoints and run the tests.

```sh
curl http://127.0.0.1:8080/healthz
curl http://127.0.0.1:8080/api/status
npm test
```

The API binds to loopback. Set `PORT` to choose another local port.

## Adapt and register

Complete `PROJECT_BRIEF.md` with the intended users, data, integrations, delivery stage, and exit criteria. Have your coding agent read the brief and `AGENTS.md` before editing. `CLAUDE.md` imports the shared instructions for Claude Code.

Update `catalog-info.yaml` with the actual source URL, owner, team, purpose, and data and audience classifications before registering the app in Frontstage. Reassess the delivery stage and review requirements before adding real data or widening access.

Before deployment, integrate your organization’s identity provider and enforce authentication and authorization on the server. Test the permissions with both allowed and denied users.
