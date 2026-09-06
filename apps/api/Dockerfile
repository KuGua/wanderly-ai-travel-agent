FROM node:22-slim
WORKDIR /app/apps/api
ENV NODE_ENV=production

COPY apps/api/package.json apps/api/package-lock.json* ./
# Compile and prune in one stage to keep peak BuildKit disk usage within the
# small Docker volume provided by AWS CloudShell.
RUN npm ci --include=dev
COPY apps/api/tsconfig.json apps/api/drizzle.config.ts ./
COPY apps/api/src/ src/
COPY apps/api/data/ data/
COPY apps/api/migrations/ migrations/
RUN npm run build && npm prune --omit=dev

EXPOSE 3000
CMD ["node", "dist/server.js"]
