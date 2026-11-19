# Internal web app

A dependency-free Node.js 24 starter for checking shared equipment availability. The inventory is synthetic and read-only. Search by item, category, or location, and filter by availability. The app needs no runtime AI, gateway key, database, or external network connection.

## Run locally

Run `npm start` from this directory and open http://127.0.0.1:8080. The server listens on loopback. Set `PORT` to choose another local port.

Run `npm test` to check the inventory, filters, health endpoint, and HTTP behavior.

## Adapt and register

Complete `PROJECT_BRIEF.md` with the intended users, data, integrations, delivery stage, and exit criteria. Have your coding agent read the brief and `AGENTS.md` before editing. `CLAUDE.md` imports the shared instructions for Claude Code.

Update `catalog-info.yaml` with the actual source URL, owner, team, purpose, and data and audience classifications before registering the app in Frontstage. Reassess the delivery stage and review requirements before adding real data or widening access.

Before deployment, integrate your organization’s identity provider and enforce authentication and authorization on the server. Test the permissions with both allowed and denied users.
