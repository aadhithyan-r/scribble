# Skrible deployment guide

## Components

| Component | Role |
| --- | --- |
| `apps/server` | Authoritative game engine, Socket.IO API, HTTP admin API |
| PostgreSQL 16+ | Players, hashed sessions, matches, stats, word lists, reports, bans, settings |
| Redis 7+ | Room snapshots, per-instance matchmaking queues, presence, distributed rate limits, Socket.IO adapter |
| Expo app | Android/iOS client; talks HTTPS/WSS to the server |

Postgres and Redis are **required** in production. The server refuses to start if either is
unreachable, so a half-configured deploy cannot silently fall back to memory.

## Configuration

Copy `.env.example` to a secret-managed environment file and set at minimum:

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | Use `sslmode=require` (or stricter) for managed Postgres |
| `REDIS_URL` | yes | Use `rediss://` when Redis is not on a private network |
| `INSTANCE_ID` | yes | Unique and **stable** per instance; keep it across restarts to recover rooms |
| `CORS_ORIGINS` | production | Comma-separated browser origins; native apps send no Origin. Empty rejects browsers |
| `ADMIN_TOKEN` | optional | ≥24 characters; moderation API is disabled when unset |
| `AUTH_TOKEN_TTL_DAYS` | no | Guest token lifetime, default 30 |
| `MM_MIN` / `MM_MAX` / `MM_WAIT_MS` | no | Matchmaking bounds |
| `LOG_LEVEL` | no | `info` in production; logs are JSON |
| `TRUST_PROXY` | behind a proxy | `1` trusts the first `X-Forwarded-For` hop for rate limiting |
| `SHUTDOWN_TIMEOUT_MS` | no | Graceful-shutdown budget, default 15000 |

Never put database/Redis/admin secrets in the mobile bundle. The mobile app only knows
`EXPO_PUBLIC_SERVER_URL`.

## Local development

```bash
cd infra
docker compose up -d postgres redis

cd ../apps/server
npm ci
DATABASE_URL=postgres://skrible:skrible_dev_password@localhost:55432/skrible \
  REDIS_URL=redis://localhost:56379 npm run migrate
DATABASE_URL=postgres://skrible:skrible_dev_password@localhost:55432/skrible \
  REDIS_URL=redis://localhost:56379 npm run dev
```

`GET /health` is liveness. `GET /ready` additionally checks Postgres and Redis and returns 503
until both are usable.

## Container deployment

```bash
cd infra
docker compose --profile full up -d --build
```

The `server` profile builds `apps/server/Dockerfile` (multi-stage, non-root runtime) and waits for
healthy Postgres/Redis. Put TLS and public routing in front of the container.

### Migrations

- `src/migrate.ts` applies every `apps/server/migrations/*.sql` in filename order inside a
  transaction, guarded by a Postgres advisory lock. It is safe to run from several instances.
- The server also runs migrations at boot. For controlled releases, run `npm run migrate` as a
  pre-deploy job and then start new instances.
- Never edit an applied migration; add the next numbered file. Back up before destructive
  migrations and test the migration on a staging copy.

## TLS, proxy and Socket.IO

Terminate TLS at a load balancer or reverse proxy and forward both HTTP and WebSocket upgrades to
the server. Use `https://`/`wss://` in `EXPO_PUBLIC_SERVER_URL`; set `TRUST_PROXY=1` only when the
proxy strips untrusted forwarding headers.

Example nginx fragment:

```nginx
location / {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 75s;
}
```

## Scaling and room affinity

Socket.IO's Redis adapter (already configured) shares broadcasts between instances. Rooms and
matchmaking queues are intentionally **instance-affine**: a room lives on the server that owns its
sockets, and queue keys are `mm:queue:{INSTANCE_ID}`. This keeps turn timers and scores
single-writer.

Therefore:

- Configure sticky sessions at the load balancer (Socket.IO's `io` cookie or IP hash) so a client
  stays on one instance for the life of its connection.
- Give every instance a distinct `INSTANCE_ID`.
- On restart/rolling deploy, reuse the same `INSTANCE_ID` to recover that instance's room
  snapshots. Snapshots owned by a different ID are deliberately ignored.
- Cross-instance room actions are not implemented. A reconnecting player must land on the
  instance that owns the room; the room session token resume flow handles restarts on that
  instance.
- Drain with `SIGTERM`: the server stops accepting work, waits for in-flight match writes, flushes
  room snapshots and closes Redis/Postgres within `SHUTDOWN_TIMEOUT_MS`.

For larger deployments, move sticky routing to a consistent-hash proxy keyed by a stable client
identifier, or implement explicit room hand-off before scaling beyond a single writer per room.

## Backups and recovery

### PostgreSQL

```bash
# Logical backup (run from a host with pg_dump 16+)
pg_dump "$DATABASE_URL" --format=custom --file=skrible-$(date +%F).dump

# Restore into an empty database
pg_restore --clean --if-exists --no-owner --dbname="$RESTORE_DATABASE_URL" skrible-YYYY-MM-DD.dump
```

For production use managed automated backups and point-in-time recovery (WAL archiving). Keep at
least one restore drill per release: restore into a scratch database, run `npm run migrate`, start
the server against it and check `/ready` plus a match history query.

### Redis

Room snapshots, queues, presence and rate-limit keys are already expiring and can be rebuilt from
live traffic after a Redis loss. Use AOF (`appendonly yes`) plus a replica for short outages. Redis
is not the system of record for players, stats or completed matches; those live in Postgres.

If Redis is lost during a match, clients reconnect and the room may be unavailable; the client
returns to home and the match is finalized in Postgres if it had already ended. Document your
acceptable RPO/RTO and test it.

## Monitoring and logging

- `pino` emits JSON to stdout. Tokens, cookies, `profileToken`, `sessionToken` and authorization
  headers are redacted; never log raw handshake payloads.
- Scrape liveness/readiness with your orchestrator. Alert on `/ready` failures, process restarts,
  `match finalization failed`, Redis reconnect warnings and shutdown timeouts.
- No external error-monitoring SDK is bundled. Add an OpenTelemetry/Sentry-compatible transport in
  `logger.ts` before production if required by your operations policy.
- HTTP admin actions are logged with the setting key/player id; admin tokens are not logged.

## Staging and production

Use separate Postgres databases, Redis logical databases/instances and `ADMIN_TOKEN`s. Staging
should run the same image and migration job. Build the server image once, deploy by digest, and
promote the same digest. Mobile builds should point at the production URL through
`EXPO_PUBLIC_SERVER_URL` at build time.

## Mobile releases

Android package: `com.skrible.mobile`, iOS bundle identifier: `com.skrible.mobile`. Version/build
numbers live in `app.json`; `eas.json` defines preview (APK) and production (AAB) profiles.

```bash
cd apps/mobile
npx eas login                       # account credentials handled by EAS
npx eas build --platform android --profile production
npx eas build --platform ios --profile production
npx eas submit --platform android --profile production   # internal/closed track first
npx eas submit --platform ios --profile production       # TestFlight
```

EAS manages the Android upload keystore and iOS distribution certificate/provisioning profile; do
not commit keystores or `.p8` keys. Verify the first production AAB on an internal track, then
promote. This repository's environment has no JDK/Android SDK and cannot build an APK/AAB or run
TestFlight; the required config is present but the signed artifacts are **not** produced here.
