# Skrible Mobile

Cross-platform drawing-and-guessing multiplayer game inspired by skribbl.io, built as a
production-oriented Expo + Socket.IO application.

## Stack

- Mobile: Expo SDK 52, React Native, TypeScript, React Native Skia
- Realtime: Socket.IO with the Redis adapter
- Server: Node.js, TypeScript, Express, zod
- Persistence: PostgreSQL 16+ (players, hashed sessions, matches, stats, words, reports, bans)
- Coordination: Redis 7+ (room snapshots, matchmaking, presence, distributed rate limits)
- Security: opaque guest tokens hashed in Postgres; Expo SecureStore on device; Helmet/CORS

## Repository layout

- `apps/mobile/app`: Expo Router screens — home/Quick Play, lobby/game, deep-link join, profile
- `apps/mobile/src`: socket/auth/session, drawing board mirror, chat, components
- `apps/server/src`: authoritative game engine (`game.ts`), Socket.IO API (`server.ts`),
  auth (`auth.ts`), SQL repositories (`repositories.ts`), Redis layer, config/logger/db/migrations
- `apps/server/migrations`: versioned PostgreSQL schema
- `infra/docker-compose.yml`: local Postgres/Redis and optional full server profile
- `docs/DEPLOYMENT.md`, `docs/SECURITY.md`, `docs/PHASE5_REPORT.md`
- `.github/workflows/ci.yml`: real-service server tests, mobile tests and Android bundle export

## Requirements

- Node.js 20+ and npm 10+
- PostgreSQL 16+ and Redis 7+ (Docker Compose is the easiest local option)
- For the app: an Android/iOS development build. **React Native Skia is native, so Expo Go cannot
  run the drawing screen.** Use `npx expo run:android` / `npx expo run:ios` or EAS.

## Quick start

```bash
# 1. Start Postgres + Redis
cd infra
docker compose up -d postgres redis

# 2. Configure and migrate the server
cd ../apps/server
cp ../../.env.example .env        # optional; export the variables another way
npm ci
DATABASE_URL=postgres://skrible:skrible_dev_password@localhost:55432/skrible \
REDIS_URL=redis://localhost:56379 npm run migrate

# 3. Start the server
DATABASE_URL=postgres://skrible:skrible_dev_password@localhost:55432/skrible \
REDIS_URL=redis://localhost:56379 npm run dev
```

The server listens on `http://localhost:3001`. `GET /health` is liveness; `GET /ready` also checks
Postgres and Redis. See `.env.example` and `docs/DEPLOYMENT.md`.

Production container (server + dependencies):

```bash
cd infra
docker compose --profile full up -d --build
```

## Mobile app

```bash
cd apps/mobile
npm ci
# Physical phone: use your machine's LAN IP.
EXPO_PUBLIC_SERVER_URL=http://YOUR_LAN_IP:3001 npx expo run:android
```

Android emulator may need `http://10.0.2.2:3001`. The guest token and room seat are stored in the
device Keychain/Keystore via `expo-secure-store`; the app restores them on launch, refreshes before
expiry and offers “Resume room” when a seat is still held. Signing out or deleting the account clears
local secrets. Invite deep links use `skrible://join?code=ABCDE&invite=TOKEN`.

## Features

- **Persistent guest accounts** — secure token storage, restore/refresh/rotation, logout and
  account deletion. No password and no forced social login.
- **Quick Play** — atomic Redis-backed queue per instance, duplicate prevention, cancellation,
  timeout/disconnect release, immediate room start at the configured minimum.
- **Private rooms and invites** — 5-character codes and 24-byte invite links; invite-only mode.
- **Host settings and custom words** — rounds, draw time, max players, spectators, invite mode and
  validated custom categories persisted per player. Words never leak to guessers/spectators.
- **Drawing engine** — Skia canvas, live batched strokes, drawer-only drawing, undo/redo/clear,
  board recovery after reconnect or server restart.
- **Scoring and match history** — server-authoritative scores, idempotent transactional
  finalisation, persistent stats, recent matches and leaderboard from PostgreSQL.
- **Moderation** — kick/ban/mute, persistent reports, host review panel, distributed report
  cooldowns, profanity masking, secret-word redaction and rate limits.
- **Spectators** — join games in progress without entering turns, scoring or private payloads.
- **Mobile resilience** — background/foreground reconnect, offline banners, network listener,
  launch-time room resume, keyboard-safe layout, safe-area screens and accessible controls.

## Controls

- The host configures the lobby and starts with 2+ players.
- The drawer gets three private words; choose one (or the 15-second timer picks one) and draw.
- Toolbar: colours, pen/eraser, sizes, undo, redo, clear.
- Only the drawer may draw; only guessers score. Correct guesses are announced without the word.
- The server rejects attempts to reveal the word, draw out of turn, change settings without host
  rights, or read another player's private word.

## Automated checks

```bash
cd apps/server
npm run typecheck
npm test                 # includes the real Postgres/Redis suite
npm run build

cd ../mobile
npm run typecheck
npm test
npx expo export --platform android --output-dir .export-check --clear
```

Latest verified results (2026-11-12): **70/70 server tests** (63 existing + 7 real Postgres/Redis
acceptance tests), **14/14 mobile tests**, both typechecks clean, server production build pass and
Android bundle export pass. Server `npm audit --omit=dev` reports **0 vulnerabilities**.

The integration suite defaults to `TEST_DATABASE_URL=postgres://skrible:skrible_dev_password@localhost:55432/skrible_test`
and `TEST_REDIS_URL=redis://localhost:56379` (the Compose ports). Override them for another
environment. It creates the test database if needed and skips with a warning only when the services
are unreachable — CI always runs it against real services.

Coverage includes auth hashing/rotation/revocation/deletion, idempotent match writes, atomic
matchmaking races, distributed limits, admin auth, room/board/secret-word recovery after a server
restart, and cross-instance Socket.IO broadcast.

## Data and security model

- PostgreSQL is the system of record for accounts, matches, stats, word lists, reports and bans.
- Redis owns live room snapshots, per-instance queues, presence, rate-limit windows and adapter
  pub/sub. Snapshots expire after six hours; completed matches are already in Postgres.
- Rooms are instance-affine and require sticky sessions; use a distinct, stable `INSTANCE_ID` per
  instance and reuse it on restart so that instance can recover its rooms.
- Tokens are bearer secrets; Postgres stores only SHA-256 hashes. Logs redact token fields. Admin
  endpoints are disabled without `ADMIN_TOKEN` and require a constant-time bearer comparison.
- See `docs/SECURITY.md` for the full audit and residual risks.

## Limitations

- Store releases were **not built** here: no JDK/Android SDK, no macOS/Xcode, no EAS credentials.
  Config for Android (`com.skrible.mobile`, AAB) and iOS (bundle id, TestFlight steps) is present.
- No physical-device or real-network acceptance test was performed in this environment.
- Guests can evade a ban by creating a new account; verified identities/device attestation are out
  of scope for the no-forced-login requirement.
- No automated drawing-content moderation; reports are the only signal.
- The profanity list is a starter set.
- Redis snapshots contain private words; protect Redis with private networking/TLS/encryption.
- Mobile `npm audit --omit=dev` still reports advisories in Expo CLI/build tooling; the server
  production tree is clean.
- No room sweeper beyond Redis TTLs/disconnect grace; no public room browser.

Full details and release status: `docs/PHASE5_REPORT.md`. Deployment, backup/restore and scaling:
`docs/DEPLOYMENT.md`.

## Phase status

- Phase 2 — drawing engine — complete.
- Phase 3 — multiplayer engine — complete.
- Phase 4 — complete game experience — complete.
- Phase 5 — production backend, PostgreSQL/Redis, authentication, security, mobile persistence and
  deployment config — **implemented and verified as described above**; signed store artifacts and
  physical-device acceptance remain outstanding.
