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
ENV NODE_ENV=production
# git is needed for "history": "git" and `lifekernel undo`. The vault is often a bind mount owned by the host
# user, which git would otherwise refuse as a "dubious ownership" repository.
RUN apk add --no-cache git \
 && git config --system --add safe.directory '*' \
 && mkdir -p /state /vaults \
 && chown node:node /state /vaults
WORKDIR /app
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.LIFEKERNEL_PORT||8787)+'/health').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "apps/mcp/dist/http.js"]
