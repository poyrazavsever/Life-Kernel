FROM node:22-alpine AS build
WORKDIR /app
COPY . .
RUN npm ci && npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app /app
EXPOSE 8787
CMD ["node", "apps/mcp/dist/http.js"]

