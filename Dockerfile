FROM node:22-alpine AS build
WORKDIR /app
# Install dependencies from the manifests first so source edits do not reinstall them.
COPY package.json package-lock.json ./
COPY apps/cli/package.json apps/cli/
COPY apps/mcp/package.json apps/mcp/
COPY packages/core/package.json packages/core/
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
# These link the published image to this repository, so GitHub shows it under the repo and its license applies.
LABEL org.opencontainers.image.source="https://github.com/poyrazavsever/Life-Kernel" \
      org.opencontainers.image.description="Self-hosted, Markdown-native context layer for planning with AI agents" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production
# /state is a named volume that must stay writable when the container runs as the host user (LIFEKERNEL_UID),
# whatever that uid is, so it is world-writable with the sticky bit, like /tmp.
# git is needed for "history": "git" and `lifekernel undo`. The vault is often a bind mount owned by the host
# user, which git would otherwise refuse as a "dubious ownership" repository.
RUN apk add --no-cache git \
 && git config --system --add safe.directory '*' \
 && mkdir -p /state /vaults \
 && chown node:node /vaults \
 && chmod 1777 /state
WORKDIR /app
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.LIFEKERNEL_PORT||8787)+'/health').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "apps/mcp/dist/http.js"]
