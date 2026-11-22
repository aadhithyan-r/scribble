# Security audit — Phase 5

Scope: authentication and sessions, room/seat authorisation, invite tokens, custom words, chat
moderation, drawing permissions, scoring/match finalisation, matchmaking abuse, replay/duplicate
events, input validation, admin API, sensitive-data exposure, logging and dependency posture.

Method: code review of `apps/server/src`, schema constraints in `migrations/`, adversarial socket
tests in `phase5.integration.test.ts`/`server.phase4.test.ts`, manual production-mode smoke tests,
and `npm audit --omit=dev`.

## Controls implemented

### Authentication and sessions

- Guest accounts only; there is no forced social login and no password to steal.
- Tokens are 32 random bytes (base64url, 43 chars). Only `sha256(token)` is stored in
  `auth_sessions`; plaintext tokens never reach Postgres or logs.
- Token rotation issues a new hash and keeps the old hash usable only for a 5-minute grace window,
  so a crash between receiving and persisting a rotated token does not lock the user out. Refresh
  is serialised with `FOR UPDATE`; concurrent use cannot mint parallel sessions.
- Logout revokes all hashes for that session (current and previous). Account deletion revokes every
  session, deletes stats/custom words/bans, anonymises match/report display names and soft-deletes
  the player row solely to keep foreign keys valid.
- A socket handshake carrying a token is authenticated before any event handler runs. Invalid
  handshake tokens are rejected with `AUTH_INVALID`; the client can reconnect anonymously to
  resume a room seat or create a new guest.
- Token expiry is enforced in SQL (`expires_at > now()`), not trusted from the client. Revocation
  is checked on every authenticate/restore.

### Authorisation and integrity

- Room state, turn order, timers, secret words, scoring, chat and stroke history are server-owned.
  Clients cannot submit scores or self-assign drawer/host roles.
- Every room mutation checks host/drawer/membership rules in `Game` (`kick`, `configure`,
  `setCategories`, `beginStroke`, `guess`, …) before touching state.
- Room resume requires the 122-bit seat session token and is rate-limited; seat tokens are
  independent of profile tokens.
- `match:get` is limited to participants or a viewer currently in that room; the leaderboard only
  exposes public profile names and aggregate stats.
- Match finalisation uses a unique `finalization_key` per room instance and a transaction. Duplicate
  timers/retries/reconnects return the existing record and cannot double-count stats (tested with
  concurrent finalisation and post-restart retries).
- Matchmaking enqueue/take/cancel/expiry are atomic Redis Lua operations. Duplicate socket/profile
  entries are rejected, `TAKE` is atomic across instances, and expiry releases waiters.
- Invite tokens are 24 random bytes revealed only to the host. Invite-only rooms reject bare codes.
- Custom word lists are validated for length, characters, duplicates, size and profanity. Words
  never appear in public room payloads, chat, guesses or spectator payloads; only the drawer sees
  `secretWord`/`wordChoices`.
- Report pairs are rate-limited in Redis (distributed) and in process; only the host can read the
  room's moderation state.

### Abuse and denial of service

- Socket.IO payloads are capped at 1 MB; HTTP JSON bodies at 16 KB; zod bounds names, codes, tokens,
  arrays, point batches, word lists and chat.
- Per-socket local token buckets protect chat (5 bursts) and drawing (120 tokens/s). Distributed
  fixed-window buckets (Redis Lua, local fallback on Redis outage) additionally cover auth, room
  create/join, chat, draw starts and report cooldowns. Identity is the persistent profile id when
  known, otherwise the transport address (proxy-aware only when `TRUST_PROXY` is enabled).
- Room capacity, spectator capacity, round/draw-time bounds, board stroke/point caps and chat
  history caps bound memory per room.
- Redis keys and room snapshots expire (6 h rooms, 90 s presence, 120 s seat discovery, queue TTLs);
  a desired room sweeper is not implemented, but TTLs prevent indefinite growth.
- CORS is an explicit origin allowlist in production; native clients (no Origin header) still work.
  Admin endpoints are disabled unless `ADMIN_TOKEN` is configured and use constant-time comparison.

### Data exposure and logging

- Pino redacts authorization/cookie headers, `token`, `profileToken`, `sessionToken`, access tokens
  and passwords. Handlers never log raw tokens or secret words.
- `publicRoom` strips secrets for non-drawers; recovered snapshots apply the same serialiser.
- Redis snapshots contain room secrets and must be protected with private networking/ACL and
  encryption at rest by the hosting provider. They are never exposed over HTTP.
- The admin API is separate from the game socket API and returns no tokens.

## Findings and fixes during this phase

| Severity | Finding | Resolution |
| --- | --- | --- |
| High | Zod 3.24.1 advisory for memory exhaustion on oversized constrained collections | Upgraded to Zod 4.6.7; full 70-test suite passes; `npm audit --omit=dev` reports 0 server vulnerabilities |
| High | Previous identity flow silently created a new account when a token was invalid, orphaning stats | Production identify/restore now rejects invalid tokens; clients clear the stale token and explicitly create a guest |
| Medium | Rotation grace permitted authentication but not another refresh with the previous token | Refresh query now accepts the grace hash under `FOR UPDATE` |
| Medium | Account deletion left display names and stats intact | Delete now removes stats/words/bans and anonymises match/report names |
| Medium | Rate limiting keyed every unauthenticated client to the proxy address | Uses first `X-Forwarded-For` hop only when `TRUST_PROXY` is enabled |
| Low | Presence cleanup deleted a non-existent `roomsession:<socketId>` key | Removed; seat discovery tokens expire naturally |
| Low | CORS reflected every origin | Explicit allowlist in production, native clients unaffected |

## Residual risks (documented, not hidden)

1. **Ban evasion via new guest accounts.** Moderation bans target profile rooms/ids; a determined
   user can create a new guest. Raising this requires verified accounts/device attestation, which
   conflicts with the no-forced-login requirement.
2. **Room affinity.** Rooms are owned by one instance. Sticky sessions and stable `INSTANCE_ID`s are
   required; cross-instance room operations/hand-off are not implemented. A misconfigured load
   balancer can make a room unreachable or split timers (the Redis tick lock prevents duplicate
   advancement, but not routing mistakes).
3. **Redis is trusted.** Room snapshots include secret words. Anyone with Redis read access can see
   them. Protect Redis with private networking, auth/TLS and disk encryption. AOF loss can lose
   in-progress rooms; completed matches are safe in Postgres.
4. **No drawing content moderation.** Reports are the only signal for inappropriate drawings;
   automated image moderation is out of scope.
5. **Static profanity list.** Starter word list only; a maintained moderation service is recommended
   for large audiences.
6. **Dependency/toolchain advisories.** Mobile `npm audit --omit=dev` still reports advisories in
   Expo CLI/build tooling (`tar`, `postcss`, `@expo/cli`, `xdom`, `image-size`, `uuid`). They are
   build-time packages, not reachable from the game protocol; upgrade the Expo SDK as a scheduled
   maintenance task and rebuild. The server production tree is clean.
7. **Single shared admin token.** Rotate it via secret manager and restrict admin routes to an
   internal network; there is no per-admin identity or audit trail beyond structured logs.
8. **No connection-cap per IP.** Rate limits bound actions, not raw TCP/WebSocket connection count;
   rely on the edge proxy/WAF for volumetric protection.

## Verification

The real Postgres/Redis acceptance suite includes: hashed-token assertions, rotation grace,
logout/revocation/deletion, idempotent stats, duplicate/atomic matchmaking, distributed rate
limiting, admin bearer enforcement, restart recovery with secret-word privacy, and cross-instance
adapter broadcast. See `docs/PHASE5_REPORT.md` for exact results.
