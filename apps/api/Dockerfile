FROM node:22-slim AS builder
WORKDIR /app/apps/api
COPY apps/api/package.json apps/api/package-lock.json* ./
RUN npm ci
COPY apps/api/tsconfig.json apps/api/drizzle.config.ts ./
COPY apps/api/src/ src/
COPY apps/api/data/ data/
RUN npm run build

FROM node:22-slim AS runner
WORKDIR /app/apps/api
ENV NODE_ENV=production
COPY apps/api/package.json apps/api/package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=builder /app/apps/api/dist ./dist
COPY --from=builder /app/apps/api/data ./data
COPY apps/api/migrations/ migrations/
EXPOSE 3000
CMD ["node", "dist/server.js"]
