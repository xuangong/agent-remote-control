# Build the repository artifacts with pnpm before building these runtime images.
FROM node:22-bookworm-slim AS node
WORKDIR /app
ENV NODE_ENV=production AGENT_REMOTE_BIND=0.0.0.0 AGENT_REMOTE_PORT=5910
ENV AGENT_REMOTE_STATE_DIR=/data AGENT_REMOTE_WEB_DIST=/app/web
COPY --chown=node:node dist/relay/gateway.mjs ./gateway.mjs
COPY --chown=node:node dist/relay/web ./web
RUN test -x /usr/bin/flock && mkdir -p /data && chown node:node /data
USER node
EXPOSE 5910
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:'+process.env.AGENT_REMOTE_PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "gateway.mjs"]

# Local Workers parity image. Production Workers deploy through Wrangler.
FROM node:22-bookworm-slim AS workers
ARG WRANGLER_VERSION=4.97.0
ARG NPM_REGISTRY=https://mirrors.cloud.tencent.com/npm/
RUN npm install --global --registry="${NPM_REGISTRY}" wrangler@${WRANGLER_VERSION}
WORKDIR /app
ENV NODE_ENV=development WRANGLER_SEND_METRICS=false CI=true
COPY --chown=node:node dist/cloudflare ./worker
COPY --chown=node:node dist/relay/web ./web
COPY --chown=node:node scripts/relay-workers-local.mjs ./start.mjs
RUN mkdir -p /data && chown node:node /data /app /app/worker
USER node
EXPOSE 5910
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s CMD node -e "fetch('http://127.0.0.1:'+process.env.AGENT_REMOTE_PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "start.mjs"]
