# Phase 5 delivery report — production backend, auth and releases

Date: 2026-11-12. This report separates what was **implemented and executed** from what could not
be built or verified in this environment.

## 1. Architecture

```
Expo app ── HTTPS/WSS ──> Node server (Socket.IO + Express)
                              │
              ┌───────────────┼────────────────┐
              ▼               ▼                ▼
        PostgreSQL        Redis            Admin API
     players/sessions   room snapshots    bearer token
     matches/stats      matchmaking       settings/bans
     words/reports      presence/limits
                        Socket.IO adapter
```

The Phase 2–4 synchronous game engine is preserved. Persistence, auth, Redis coordination and
recovery are layered around it; the in-memory `ProfileStore`/`Matchmaker` remain as the test/dev
fallback used by the existing 63 tests.

Key files: `apps/server/src/{index,server,game,auth,repositories,redis,redis-matchmaking,room-store,
presence,rate-limit,db,config,logger,migrate}.ts`, `apps/server/migrations/*.sql`.

## 2. Database

Two versioned migrations (`0001_init.sql`, `0002_room_identity.sql`) create:

- `players` — display name, avatar allow-list, soft-delete/anonymisation fields
- `auth_sessions` — SHA-256 token hashes, rotation grace hash, expiry, revocation, last use
- `matches` — unique `finalization_key`, room code, rounds, timestamps
- `match_players` — per-player score/rank/guesses/won, FK to players (nullable for deleted users)
- `player_stats` — games/wins/points/guesses aggregates
- `word_lists` — one validated JSONB category list per player
- `reports` — room-scoped reports with `room_id` (stable across room-code reuse)
- `bans` — global or room-scoped, unique `(player_id, room_id)` NULLS NOT DISTINCT, expiry/revoke
- `moderation_settings` — Redis rate-limit config, seeded (`auth`, `room`, `chat`, `draw`, `report`)
- `schema_migrations` — applied migration ledger

Foreign keys, checks and indexes cover active sessions, leaderboard stats, match history, room
report/bans and word-list uniqueness. Finalisation runs in one transaction; retries with the same
key return the stored match and never double-count stats. Account deletion removes personal data
and anonymises historical display names.

Connection pooling (`pg`, 10 connections), idle-error recovery, advisory-locked migrations and
`/ready` DB probes are wired. A logical backup/restore drill was executed against the test database
(see §7).

## 3. Redis architecture

| Key | Purpose | TTL / atomicity |
| --- | --- | --- |
| `room:{code}:snapshot` | Full room state, board, chat, phase and private words | 6 h; debounced writes + shutdown flush |
| `room:{code}:tick` | Per-room tick lock | 2 s, `SET NX PX` |
| `rooms:index` | Codes with snapshots | trimmed by recovery |
| `mm:queue:{instanceId}` | Per-instance sorted queue | Lua atomic enqueue/take/cancel/expire |
| `mm:socket:*`, `mm:profile:*` | Duplicate/queue membership | queue wait × 3 ms |
| `presence:{socketId}` | Player/instance/room presence | 90 s heartbeat |
| `presence:instance:{id}` | Instance socket set | 90 s members |
| `roomsession:{token}` | Seat discovery for reconnects | 120 s |
| `ratelimit:{bucket}:{identity}` | Distributed fixed windows | window length; Lua INCR+PEXPIRE |

Rooms and queues are deliberately instance-affine; sticky sessions are required (see
`docs/DEPLOYMENT.md`). The Socket.IO Redis adapter shares broadcasts between instances; a
two-instance broadcast test passes. On restart, only snapshots whose `instanceId` matches are
restored; seats are held for the reconnect grace period and can be resumed with the seat token.
The tick lock prevents duplicate timer advancement from a recovered duplicate.

## 4. Authentication

- Guest-first identity; no forced social login.
- 32-byte opaque token; only SHA-256 hash stored; 30-day default expiry.
- Restore on launch, rotation with 5-minute grace, revocation/logout, account deletion.
- Mobile tokens stored with `expo-secure-store` (Keychain/Keystore), never in plain AsyncStorage.
- Room seat tokens persisted separately so a room can be resumed across app launches.
- Socket handshake token authentication; anonymous connections are still allowed for room resume.
- Auth events and handshakes are rate-limited; invalid tokens are rejected instead of silently
  creating a new account.

## 5. Production backend and deployment

- Validated environment config (`config.ts`), structured pino logs with token redaction, Helmet,
  JSON body limit, CORS allowlist, admin bearer API with constant-time comparison, `/health`,
  `/ready`, trust-proxy support, graceful `SIGTERM`/`SIGINT` handling with snapshot flush.
- Multi-stage non-root `apps/server/Dockerfile`; `infra/docker-compose.yml` Postgres/Redis/full
  server profile; `.dockerignore`; `.env.example`.
- `.github/workflows/ci.yml` runs server typecheck/tests/build against real Postgres/Redis
  services and mobile typecheck/tests/Android export.
- `docs/DEPLOYMENT.md` covers TLS/WSS, migrations, scaling/sticky sessions, backups/restore,
  staging/prod, secrets, monitoring and EAS release commands.

## 6. Security audit

Full findings and residual risks: `docs/SECURITY.md`. Critical/high items addressed include the
Zod advisory (upgraded to 4.6.7, server production audit clean), stale-token account orphaning,
rotation grace refresh, account-deletion anonymisation and proxy-aware rate-limit identity.
Residual risks include ban evasion with a new guest, room affinity/sticky-session requirements,
Redis trust for private words, static profanity list, no drawing-content moderation, build-tool
advisories in the Expo toolchain, and the shared admin token.

## 7. Verification actually run

Environment: Windows 11, Node v26.3.0, npm 11.16.0. Docker Desktop was initially available (used for
the schema migration), then its installation disappeared mid-session. Final integration runs used
PostgreSQL 18.6 and Redis 8.0.5 installed as local services inside WSL Ubuntu, reached from Windows
on `localhost:5432`/`6379`. CI uses Postgres 16/Redis 7 containers.

| Check | Result |
| --- | --- |
| `apps/server` typecheck | pass |
| Existing server suite (Phases 2–4) | **63/63 pass** |
| New Postgres/Redis acceptance suite | **7/7 pass** |
| Full server suite | **70/70 pass**, 0 skipped |
| `apps/mobile` typecheck | pass |
| Mobile unit tests | **14/14 pass** |
| Server production build (`tsc -p tsconfig.build.json`) | pass |
| Android Expo bundle export | pass (1,228 modules, 3.23 MB HBC) |
| Production server boot against real Postgres/Redis | pass |
| `/health`, `/ready` | `{ok:true}`, DB/Redis ready |
| Guest auth, hashed DB storage, restore, invalid-token rejection | pass |
| Two-player match finalisation, stats/history/leaderboard from Postgres | pass (2-player match, stats and history observed) |
| Snapshot recovery + seat resume + secret-word privacy | pass (integration test) |
| Cross-instance Socket.IO broadcast via Redis adapter | pass |
| Admin API without/with bearer token | 401 / 200 |
| PostgreSQL logical backup → restore drill | pass (1 player, 1 session, 1 match, 1 participant and 2 migrations restored) |
| `npm audit --omit=dev` server | **0 vulnerabilities** |
| `npm audit --omit=dev` mobile | 27 advisories in Expo CLI/build toolchain (1 critical `tar`, 7 high); no runtime server path |

The new suite asserts: only hashes stored, rotation grace, logout/revocation/deletion, idempotent
match writes and single-counted stats, atomic non-duplicating queue takes, queue expiry/cancel,
distributed windows, admin auth, restart recovery with board and private-word checks, and
two-instance broadcast.

## 8. Android and iOS release status

- Android application id `com.skrible.mobile`, versionCode 1; iOS bundle id `com.skrible.mobile`,
  build 1; icons, adaptive icon, splash, Android `INTERNET`/`ACCESS_NETWORK_STATE` and resize
  keyboard mode configured. `eas.json` defines preview APK and production AAB profiles.
- **Signed Android AAB was not built.** This machine has no Java/Android SDK, and EAS credentials
  were not available. The Android Expo bundle export is verified, but it is not a release binary.
- **iOS/TestFlight was not built or verified.** Building/signing iOS requires macOS/Xcode or EAS
  with an Apple account; neither is available on Windows here.
- **No physical-device or real-carrier-network test was performed.** Unit/integration tests,
  typechecks, bundle export and server smoke tests are the limits of this verification.

## 9. Known limitations and production risks

- Rooms/queues are instance-affine; sticky sessions and stable `INSTANCE_ID` are mandatory.
- Guest-only accounts allow ban evasion with a fresh identity; no device attestation.
- No drawing-image moderation; reports are the only signal.
- Static profanity list; no external moderation service.
- Redis holds secret words in snapshots; secure it with private networking/TLS/encryption.
- No automated room sweeper beyond Redis TTLs and disconnect grace timers.
- No external error-monitoring SDK; structured logs only until a transport is added.
- Mobile toolchain audit advisories remain; plan an Expo SDK upgrade.
- The Docker image itself was not built: Docker Desktop's installation disappeared mid-session. The multi-stage Dockerfile/Compose config are provided and the production TypeScript build plus startup path are verified; rebuild the image in CI or a Docker host before deploying.
- Load/performance was not measured in this environment; no speedup is claimed.
- Full-store release, signing and device acceptance remain **not done** and must be completed
  before a production store launch.

## 10. Phase status

Phase 5 backend, persistence, authentication, recovery, security fixes, mobile session handling
and documentation are **implemented and covered by the checks above**. Store releases (signed
Android AAB / iOS TestFlight) and physical-device acceptance are **not complete**; the delivery is
ready for those steps, not a shipped store release.
