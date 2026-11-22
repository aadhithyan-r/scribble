import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Pool } from "pg";
import { io, type Socket } from "socket.io-client";
import { AuthService, hashToken } from "./auth.js";
import { closePool, migrate } from "./db.js";
import { silentLogger } from "./logger.js";
import type { MatchInput } from "./profiles.js";
import { PresenceStore } from "./presence.js";
import { DistributedRateLimiter } from "./rate-limit.js";
import { RedisMatchmaker } from "./redis-matchmaking.js";
import { closeRedis, connectRedis, pingRedis, type RedisClients } from "./redis.js";
import {
  BanRepository,
  MatchRepository,
  PlayerRepository,
  ReportRepository,
  SettingsRepository,
  WordListRepository,
} from "./repositories.js";
import { RoomStore } from "./room-store.js";
import { createGameServer, type ServerInfra } from "./server.js";
import type { QueueEntry } from "./matchmaking.js";

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://skrible:skrible_dev_password@localhost:55432/skrible_test";
const REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:56379";
const ADMIN_TOKEN = "phase5_integration_admin_token_123456";

type RunningServer = {
  server: ReturnType<typeof createGameServer>;
  infra: ServerInfra;
  url: string;
};

let pool: Pool | null = null;
let redis: RedisClients | null = null;
let unavailable: string | null = "not initialized";

async function initialise(): Promise<void> {
  const target = new URL(DATABASE_URL);
  const database = target.pathname.replace(/^\//, "");
  if (!/^[a-z0-9_]+$/i.test(database)) throw new Error("Unsafe test database name");

  const adminUrl = new URL(DATABASE_URL);
  adminUrl.pathname = "/postgres";
  const admin = new Pool({ connectionString: adminUrl.toString(), connectionTimeoutMillis: 2_000 });
  try {
    await admin.query("SELECT 1");
    const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [database]);
    if (exists.rowCount === 0) await admin.query(`CREATE DATABASE "${database}"`);
  } finally {
    await admin.end();
  }

  pool = new Pool({ connectionString: DATABASE_URL, max: 10 });
  await migrate(pool);
  await pool.query("TRUNCATE matches, players CASCADE");
  redis = await connectRedis(REDIS_URL);
  if (!(await pingRedis(redis.command))) throw new Error("Redis did not answer PING");
  unavailable = null;
}

try {
  await initialise();
} catch (error) {
  unavailable = error instanceof Error ? error.message : String(error);
  console.warn(`[phase5] integration tests skipped: ${unavailable}`);
}

const integrationTest = (
  name: string,
  fn: () => Promise<void>,
  options: { timeout?: number } = {},
) => {
  const skip = unavailable === null ? false : unavailable || "Postgres/Redis unavailable";
  return test(name, { skip, timeout: options.timeout ?? 30_000 }, async () => {
    assert.ok(pool && redis);
    await fn();
  });
};

const clients: Socket[] = [];
const servers: RunningServer[] = [];

async function startServer(instanceId: string, adminToken = ADMIN_TOKEN): Promise<RunningServer> {
  assert.ok(pool && redis);
  const matches = new MatchRepository(pool);
  const roomStore = new RoomStore(redis.command, instanceId);
  const infra: ServerInfra = {
    instanceId,
    pool,
    auth: new AuthService(pool, 60 * 60 * 1000),
    players: new PlayerRepository(pool, matches),
    matches,
    wordLists: new WordListRepository(pool),
    reportRepo: new ReportRepository(pool),
    bans: new BanRepository(pool),
    settings: new SettingsRepository(pool),
    redis,
    roomStore,
    presence: new PresenceStore(redis.command, instanceId),
    limiter: new DistributedRateLimiter(redis.command, silentLogger),
    matchmaker: new RedisMatchmaker(redis.command, { minPlayers: 2, maxPlayers: 4, waitMs: 10_000 }),
  };
  const server = createGameServer({
    infra,
    logger: silentLogger,
    corsOrigins: [],
    adminToken,
    allowAllOrigins: true,
  });
  await server.ready;
  await new Promise<void>((resolve, reject) => {
    server.httpServer.once("error", reject);
    server.httpServer.listen(0, "127.0.0.1", () => {
      server.httpServer.off("error", reject);
      resolve();
    });
  });
  const address = server.httpServer.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind a TCP port");
  const running: RunningServer = { server, infra, url: `http://127.0.0.1:${address.port}` };
  servers.push(running);
  return running;
}

async function connect(url: string, auth: Record<string, unknown> = {}): Promise<Socket> {
  const socket = io(url, { transports: ["websocket"], auth, reconnection: false, forceNew: true });
  clients.push(socket);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("connect timed out")), 5_000);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("connect_error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return socket;
}

const call = <T = Record<string, unknown>>(socket: Socket, event: string, payload: unknown = {}) =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} ack timed out`)), 8_000);
    socket.emit(event, payload, (response: T) => {
      clearTimeout(timer);
      resolve(response);
    });
  });

const guest = async (server: RunningServer, name: string) => {
  const socket = await connect(server.url);
  const result = await call<{
    ok: boolean;
    token: string;
    profile: { id: string; name: string };
    expiresAt: number;
  }>(socket, "auth:guest", { name, avatar: "fox" });
  assert.equal(result.ok, true);
  return { socket, ...result };
};

after(async () => {
  for (const client of clients) client.close();
  for (const running of servers) {
    await running.server.close().catch(() => undefined);
  }
  if (pool) {
    await pool.query("TRUNCATE matches, players CASCADE").catch(() => undefined);
    await closePool(pool);
  }
  if (redis) await closeRedis(redis);
});

integrationTest("guest auth stores only hashes and rotates with a grace window", async () => {
  assert.ok(pool);
  const auth = new AuthService(pool, 60 * 60 * 1000);
  const created = await auth.createGuest("Auth Alice", "panda");
  assert.match(created.token, /^[A-Za-z0-9_-]{43}$/);

  const stored = await pool.query<{ token_hash: string; previous_token_hash: string | null }>(
    "SELECT token_hash, previous_token_hash FROM auth_sessions WHERE player_id = $1",
    [created.player.id],
  );
  assert.equal(stored.rows[0]?.token_hash, hashToken(created.token));
  assert.notEqual(stored.rows[0]?.token_hash, created.token);
  assert.equal(
    await pool.query("SELECT 1 FROM auth_sessions WHERE token_hash = $1", [created.token]).then((r) => r.rowCount),
    0,
  );

  assert.equal((await auth.authenticate(created.token))?.id, created.player.id);
  const rotated = await auth.refresh(created.token);
  assert.ok(rotated);
  assert.notEqual(rotated.token, created.token);
  // The previous token remains usable during the crash-recovery grace window,
  // and can itself be rotated forward.
  assert.equal((await auth.authenticate(created.token))?.id, created.player.id);
  const rotatedAgain = await auth.refresh(created.token);
  assert.ok(rotatedAgain);

  await auth.logout(rotatedAgain.token);
  assert.equal(await auth.authenticate(rotatedAgain.token), null);
  assert.equal(await auth.authenticate(rotated.token), null);
  assert.equal(await auth.authenticate(created.token), null);

  const other = await auth.createGuest("Auth Bob", "cat");
  await new MatchRepository(pool).record(
    {
      roomCode: "DEL1",
      rounds: 1,
      players: [
        {
          profileId: other.player.id,
          name: other.player.name,
          avatar: other.player.avatar,
          score: 10,
          guesses: 1,
          correctGuesses: 0,
        },
      ],
    },
    randomUUID(),
  );
  await auth.deleteAccount(other.player.id);
  assert.equal(await auth.getPlayer(other.player.id), null);
  assert.equal(await auth.authenticate(other.token), null);
  assert.equal((await auth.authenticate(created.token)), null);

  // Deletion removes personal aggregates and anonymises historical display rows.
  const anonymised = await pool.query(
    "SELECT display_name, avatar FROM match_players WHERE player_id = $1",
    [other.player.id],
  );
  assert.equal(anonymised.rows[0]?.display_name, "Deleted player");
  assert.equal(anonymised.rows[0]?.avatar, "ghost");
  const stats = await pool.query("SELECT 1 FROM player_stats WHERE player_id = $1", [other.player.id]);
  assert.equal(stats.rowCount, 0);
});

integrationTest("match finalization is idempotent and stats are counted once", async () => {
  assert.ok(pool);
  const matches = new MatchRepository(pool);
  const players = new PlayerRepository(pool, matches);
  const auth = new AuthService(pool, 60 * 60 * 1000);
  const winner = await auth.createGuest("Winner", "lion");
  const runnerUp = await auth.createGuest("Runner", "frog");
  const finalizationKey = randomUUID();
  const input: MatchInput = {
    roomCode: "TEST1",
    rounds: 1,
    players: [
      {
        profileId: winner.player.id,
        name: winner.player.name,
        avatar: winner.player.avatar,
        score: 210,
        guesses: 2,
        correctGuesses: 1,
      },
      {
        profileId: runnerUp.player.id,
        name: runnerUp.player.name,
        avatar: runnerUp.player.avatar,
        score: 80,
        guesses: 3,
        correctGuesses: 1,
      },
    ],
  };

  const first = await matches.record(input, finalizationKey);
  const second = await matches.record(input, finalizationKey);
  assert.equal(first.id, second.id);
  assert.deepEqual(first.players.map((player) => player.score), [210, 80]);

  const stats = await players.stats(winner.player.id);
  assert.equal(stats.gamesPlayed, 1);
  assert.equal(stats.totalPoints, 210);
  assert.equal(stats.correctGuesses, 1);
  const board = await players.leaderboard(10);
  assert.equal(board[0]?.profileId, winner.player.id);
  assert.equal((await players.profileView(winner.player.id))?.history.length, 1);
});

integrationTest("Redis matchmaking take is atomic and rejects duplicate identities", async () => {
  assert.ok(redis);
  const instanceId = `test-mm-${randomUUID()}`;
  const matchmaker = new RedisMatchmaker(redis.command, {
    minPlayers: 2,
    maxPlayers: 4,
    waitMs: 10_000,
  });
  const entries: QueueEntry[] = Array.from({ length: 8 }, (_, index) => ({
    socketId: `socket-${requestId()}-${index}`,
    profileId: `profile-${requestId()}-${index}`,
    name: `Player${index}`,
    avatar: "fox",
    joinedAt: Date.now(),
  }));

  for (const entry of entries) await matchmaker.enqueue(entry, instanceId);
  await assert.rejects(
    () => matchmaker.enqueue(entries[0]!, instanceId),
    (error: unknown) => (error as { code?: string }).code === "ALREADY_QUEUED",
  );

  const [first, second] = await Promise.all([
    matchmaker.takeMatch(instanceId),
    matchmaker.takeMatch(instanceId),
  ]);
  const taken = [...(first ?? []), ...(second ?? [])];
  assert.equal(taken.length, 8);
  assert.equal(new Set(taken.map((entry) => entry.socketId)).size, 8);
  assert.equal(new Set(taken.map((entry) => entry.profileId)).size, 8);
  assert.equal(await matchmaker.size(instanceId), 0);

  const expiring = { ...entries[0]!, socketId: `expire-${randomUUID()}`, joinedAt: Date.now() - 60_000 };
  await matchmaker.enqueue(expiring, instanceId);
  const expired = await matchmaker.expire(instanceId);
  assert.equal(expired.length, 1);
  assert.equal(expired[0]?.socketId, expiring.socketId);

  const cancellable = { ...entries[1]!, socketId: `cancel-${randomUUID()}` };
  await matchmaker.enqueue(cancellable, instanceId);
  assert.equal(await matchmaker.cancel(cancellable.socketId, instanceId), true);
  assert.equal(await matchmaker.cancel(cancellable.socketId, instanceId), false);
});

integrationTest("the distributed limiter shares a fixed window per identity", async () => {
  assert.ok(redis);
  const limiter = new DistributedRateLimiter(redis.command, silentLogger);
  const identity = `limit-${randomUUID()}`;
  const config = { windowMs: 60_000, max: 2 };
  assert.equal(await limiter.allow("auth", identity, config), true);
  assert.equal(await limiter.allow("auth", identity, config), true);
  assert.equal(await limiter.allow("auth", identity, config), false);
  assert.equal(await limiter.allow("auth", `other-${identity}`, config), true);
});

integrationTest("admin moderation API requires the bearer token", async () => {
  const running = await startServer(`test-admin-${randomUUID()}`);
  const unauthorized = await fetch(`${running.url}/api/admin/settings`);
  assert.equal(unauthorized.status, 401);
  const authorized = await fetch(`${running.url}/api/admin/settings`, {
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  assert.equal(authorized.status, 200);
  const body = (await authorized.json()) as { ok: boolean; settings: Record<string, unknown> };
  assert.equal(body.ok, true);
  assert.equal(typeof body.settings.auth, "object");
});

integrationTest("a restarted instance recovers the room, board and private word", async () => {
  const instanceId = `test-recovery-${randomUUID()}`;
  const first = await startServer(instanceId);
  const host = await guest(first, "Recovery Host");
  const other = await guest(first, "Recovery Guest");
  const created = await call<{
    ok: boolean;
    room: { code: string };
    sessionToken: string;
  }>(host.socket, "room:create", { name: "Recovery Host", token: host.token });
  const code = created.room.code;
  const joined = await call<{ ok: boolean; sessionToken: string }>(other.socket, "room:join", {
    code,
    name: "Recovery Guest",
    token: other.token,
  });
  assert.equal(joined.ok, true);
  await call(host.socket, "room:configure", { maxRounds: 2 });
  const options = new Promise<string[]>((resolve) => host.socket.once("word:options", resolve));
  await call(host.socket, "game:start", {});
  const choices = await options;
  await call(host.socket, "word:choose", { word: choices[0] });
  const before = await call<{ room: { secretWord: string; status: string } }>(host.socket, "room:sync");
  assert.equal(before.room.status, "drawing");
  assert.ok(before.room.secretWord);

  await call(host.socket, "draw:stroke:begin", {
    id: "recovery_stroke_1",
    color: "#ff0000",
    width: 4,
    tool: "pen",
  });
  await call(host.socket, "draw:stroke:points", {
    id: "recovery_stroke_1",
    points: [
      { x: 0.1, y: 0.1 },
      { x: 0.3, y: 0.3 },
    ],
  });
  await call(host.socket, "draw:stroke:end", { id: "recovery_stroke_1" });

  // Let the debounced snapshot writer persist the final board, then simulate a
  // process restart by closing the whole server and starting a new one.
  await new Promise((resolve) => setTimeout(resolve, 600));
  await first.server.close();

  const second = await startServer(instanceId);
  assert.equal(second.server.game.rooms.has(code), true);

  const resumedSocket = await connect(second.url);
  const resumed = await call<{
    ok: boolean;
    room: { code: string; status: string; secretWord?: string; strokes: unknown[] };
    sessionToken: string;
  }>(resumedSocket, "room:resume", { code, token: created.sessionToken });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.room.code, code);
  assert.equal(resumed.room.status, "drawing");
  assert.equal(resumed.room.strokes.length, 1);
  assert.equal(resumed.room.secretWord, before.room.secretWord);

  const guestSocket = await connect(second.url);
  const guestView = await call<{ ok: boolean; room: { secretWord?: string; strokes: unknown[] } }>(
    guestSocket,
    "room:resume",
    { code, token: joined.sessionToken },
  );
  assert.equal(guestView.ok, true);
  // Recovery must not leak the drawer-only word to another seat.
  assert.equal(guestView.room.secretWord, undefined);
  assert.equal(guestView.room.strokes.length, 1);

  const invalidSocket = await connect(second.url);
  assert.equal(
    (await call<{ ok: boolean }>(invalidSocket, "room:resume", {
      code,
      token: `invalid-${randomUUID()}`,
    })).ok,
    false,
  );
});

integrationTest("two instances share Socket.IO broadcasts through the Redis adapter", async () => {
  const first = await startServer(`test-adapter-a-${randomUUID()}`);
  const second = await startServer(`test-adapter-b-${randomUUID()}`);
  const socket = await connect(first.url);
  await new Promise<void>((resolve) => {
    first.server.io.sockets.sockets.get(socket.id!)?.join("adapter-room");
    setTimeout(resolve, 100);
  });
  const received = new Promise<{ text: string }>((resolve) => socket.once("adapter:ping", resolve));
  second.server.io.to("adapter-room").emit("adapter:ping", { text: "cross-instance" });
  assert.deepEqual(await received, { text: "cross-instance" });
});

function requestId(): string {
  return Math.random().toString(36).slice(2, 10);
}
