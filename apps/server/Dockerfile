# syntax=docker/dockerfile:1

FROM node:22-alpine AS build
WORKDIR /app
COPY apps/server/package.json apps/server/package-lock.json ./
RUN npm ci
COPY apps/server/tsconfig.json apps/server/tsconfig.build.json ./
COPY apps/server/src ./src
COPY apps/server/migrations ./migrations
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY apps/server/package.json apps/server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/migrations ./migrations
USER node
EXPOSE 3001
# Liveness only; orchestration should poll /ready before sending traffic.
HEALTHCHECK --interval=15s --timeout=3s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
