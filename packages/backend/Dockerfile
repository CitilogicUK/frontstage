# Build from the repository root after running `yarn build:all` with Node 24.
FROM node:24.15.0-trixie-slim AS base

FROM base AS dependencies
# Production dependencies include native modules such as better-sqlite3.
# Keep their build tools out of the runtime image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends g++ make python3 \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && mkdir /app \
    && chown node:node /app

USER node
WORKDIR /app
ENV NODE_ENV=production
ENV npm_config_nodedir=/usr/local

COPY --chown=node:node .yarn/patches/ ./.yarn/patches/
COPY --chown=node:node .yarnrc.yml backstage.json package.json yarn.lock ./
COPY --chown=node:node packages/backend/dist/skeleton.tar.gz ./
RUN tar -xzf skeleton.tar.gz && rm skeleton.tar.gz
RUN yarn workspaces focus --all --production

FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV APP_CONFIG_backend_listen_host=0.0.0.0

COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=dependencies --chown=node:node /app/packages ./packages
COPY --chown=node:node backstage.json package.json ./
COPY --chown=node:node packages/backend/dist/bundle.tar.gz ./
COPY --chown=node:node app-config.yaml app-config.postgres.yaml app-config.github-signin.yaml ./
# The host bundle can contain an owner-only entry for the archive root.
RUN tar --no-overwrite-dir --no-same-owner -xzf bundle.tar.gz && rm bundle.tar.gz

USER node
EXPOSE 7007
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=3 \
  CMD ["node", "-e", "const port = process.env.APP_CONFIG_backend_listen_port ?? '7007'; fetch('http://127.0.0.1:' + port + '/.backstage/health/v1/readiness', { redirect: 'error', signal: AbortSignal.timeout(2000) }).then(response => process.exit(response.ok ? 0 : 1), () => process.exit(1));"]
ENTRYPOINT ["node", "packages/backend"]
CMD ["--config", "app-config.yaml", "--config", "app-config.postgres.yaml", "--config", "app-config.github-signin.yaml"]
