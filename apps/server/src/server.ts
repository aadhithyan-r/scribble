import express, { type NextFunction, type Request, type Response } from "express";
import cors, { type CorsOptions } from "cors";
import helmet from "helmet";
import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { Pool } from "pg";
import { Server, type Socket } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { z } from "zod";
import {
  Game,
  GameError,
  GAME_LIMITS,
  publicRoom,
  publicRoomSummary,
  type Point,
  type Room,
} from "./game.js";
import { accuracyOf, ProfileStore, type MatchInput, type Profile, type ProfileStats } from "./profiles.js";
import { Matchmaker, type MatchmakingConfig, type QueueEntry } from "./matchmaking.js";
import { ReportStore, type Report } from "./moderation.js";
import { maskProfanity, validateCategories, ValidationError } from "./validation.js";
import { AuthService, type AuthPlayer } from "./auth.js";
import { pingDatabase } from "./db.js";
import { silentLogger, type Logger } from "./logger.js";
import { PresenceStore } from "./presence.js";
import { DistributedRateLimiter } from "./rate-limit.js";
import { RedisMatchmaker } from "./redis-matchmaking.js";
import type { RedisClients } from "./redis.js";
import {
  BanRepository,
  MatchRepository,
  PlayerRepository,
  ReportRepository,
  SettingsRepository,
  WordListRepository,
} from "./repositories.js";
import { RoomStore } from "./room-store.js";
import { CURATED_CATEGORY_IDS } from "./words.js";

type Ack = ((response: Record<string, unknown>) => void) | undefined;

const strokeIdSchema = z
  .string()
  .min(6)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);
const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const pointSchema = z
  .object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
  .strict();
const nameSchema = z.string().trim().min(1).max(18);
const optionalNameSchema = nameSchema.optional();
const codeSchema = z.string().trim().length(5);
const avatarSchema = z.string().max(16).optional();
const profileTokenSchema = z.string().min(16).max(128).optional();
const inviteSchema = z.string().regex(/^[a-f0-9]{48}$/).optional();

const beginStrokeSchema = z
  .object({
    id: strokeIdSchema,
    color: colorSchema,
    width: z.number().min(1).max(40),
    tool: z.enum(["pen", "eraser"]),
  })
  .strict();
const strokePointsSchema = z
  .object({
    id: strokeIdSchema,
    points: z.array(pointSchema).min(1).max(GAME_LIMITS.maxPointChunk),
    /** Monotonic per-stroke chunk number; retransmits are ignored. */
    seq: z.number().int().min(1).max(1_000_000).optional(),
  })
  .strict();
const strokeIdPayloadSchema = z.object({ id: strokeIdSchema }).strict();
const shapeSchema = z
  .object({
    id: strokeIdSchema,
    kind: z.enum(["line", "rect", "ellipse"]),
    color: colorSchema,
    width: z.number().min(1).max(40),
    x1: z.number().min(0).max(1),
    y1: z.number().min(0).max(1),
    x2: z.number().min(0).max(1),
    y2: z.number().min(0).max(1),
  })
  .strict();
const fillSchema = z
  .object({
    id: strokeIdSchema,
    color: colorSchema,
    runs: z
      .array(
        z
          .object({
            x: z.number().min(0).max(1),
            y: z.number().min(0).max(1),
            w: z.number().min(0).max(1),
            h: z.number().min(0).max(1),
          })
          .strict(),
      )
      .min(1)
      .max(1200),
  })
  .strict();

const configureSchema = z
  .object({
    maxRounds: z.number().int().min(GAME_LIMITS.minRounds).max(GAME_LIMITS.maxRounds).optional(),
    drawSeconds: z
      .number()
      .int()
      .min(GAME_LIMITS.minDrawSeconds)
      .max(GAME_LIMITS.maxDrawSeconds)
      .optional(),
    maxPlayers: z.number().int().min(GAME_LIMITS.minPlayers).max(GAME_LIMITS.maxPlayers).optional(),
    customWordsEnabled: z.boolean().optional(),
    customWords: z
      .union([z.string().max(5000), z.array(z.string().max(64)).max(100)])
      .optional(),
    customWordsMode: z.enum(["off", "mix", "only"]).optional(),
    allowSpectators: z.boolean().optional(),
    requireInvite: z.boolean().optional(),
    visibility: z.enum(["private", "public"]).optional(),
    wordMode: z.enum(["random", "category"]).optional(),
    wordCategory: z.enum(CURATED_CATEGORY_IDS).nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: "No settings supplied" });

/** Default seat hold after a drop; overridable for tests and deployments. */
const DEFAULT_RECONNECT_GRACE_MS = 45_000;

/**
 * Production infrastructure. When absent the server runs fully in memory, which
 * keeps the game tests fast and focused; production always injects this.
 */
export type ServerInfra = {
  instanceId: string;
  pool: Pool;
  auth: AuthService;
  players: PlayerRepository;
  matches: MatchRepository;
  wordLists: WordListRepository;
  reportRepo: ReportRepository;
  bans: BanRepository;
  settings: SettingsRepository;
  redis: RedisClients;
  roomStore: RoomStore;
  presence: PresenceStore;
  limiter: DistributedRateLimiter;
  matchmaker: RedisMatchmaker;
};

export type GameServerOptions = {
  matchmaking?: Partial<MatchmakingConfig>;
  infra?: ServerInfra;
  logger?: Logger;
  corsOrigins?: string[];
  adminToken?: string;
  allowAllOrigins?: boolean;
  trustProxy?: boolean;
  /** Seat hold after a socket drop. Clamped by the caller/config. */
  reconnectGraceMs?: number;
};

type RateConfig = { windowMs: number; max: number };

const DEFAULT_LIMITS: Record<"auth" | "room" | "chat" | "draw", RateConfig> = {
  auth: { windowMs: 60_000, max: 20 },
  room: { windowMs: 60_000, max: 30 },
  chat: { windowMs: 200, max: 5 },
  draw: { windowMs: 1_000, max: 120 },
};

const emptyStats = (): ProfileStats => ({
  gamesPlayed: 0,
  gamesWon: 0,
  totalPoints: 0,
  guesses: 0,
  correctGuesses: 0,
});

const asProfile = (player: AuthPlayer): Profile => ({
  id: player.id,
  name: player.name,
  avatar: player.avatar,
  stats: emptyStats(),
  createdAt: player.createdAt,
});

const isRateConfig = (value: unknown): value is RateConfig => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { windowMs?: unknown; max?: unknown };
  return (
    typeof candidate.windowMs === "number" &&
    Number.isFinite(candidate.windowMs) &&
    candidate.windowMs >= 50 &&
    candidate.windowMs <= 600_000 &&
    typeof candidate.max === "number" &&
    Number.isInteger(candidate.max) &&
    candidate.max >= 1 &&
    candidate.max <= 10_000
  );
};

export function createGameServer(options: GameServerOptions = {}) {
  const infra = options.infra;
  const logger = options.logger ?? silentLogger;
  const instanceId = infra?.instanceId ?? "in-memory";
  const reconnectGraceMs = Math.max(1_000, options.reconnectGraceMs ?? DEFAULT_RECONNECT_GRACE_MS);
  const app = express();
  app.disable("x-powered-by");
  app.use(helmet({ crossOriginResourcePolicy: false }));
  if (options.trustProxy) app.set("trust proxy", 1);

  const allowedOrigins = options.corsOrigins ?? [];
  const allowAllOrigins = options.allowAllOrigins ?? !infra;
  // Requests without an Origin header come from native clients (and server
  // health checks), which CORS does not protect. Browsers are only allowed
  // when their origin appears in the configured allowlist.
  const originCheck: CorsOptions["origin"] = allowAllOrigins
    ? true
    : (origin, callback) => callback(null, !origin || allowedOrigins.includes(origin));
  app.use(cors({ origin: originCheck }));
  app.use(express.json({ limit: "16kb" }));
  app.get("/health", (_req, res) => res.json({ ok: true }));

  app.get("/ready", async (_req, res) => {
    if (!infra) {
      res.json({ ok: true, database: "in-memory", redis: "in-memory" });
      return;
    }
    const [database, redis] = await Promise.all([
      pingDatabase(infra.pool),
      infra.roomStore.healthy(),
    ]);
    res.status(database && redis ? 200 : 503).json({ ok: database && redis, database, redis });
  });

  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: { origin: originCheck },
    transports: ["websocket", "polling"],
    maxHttpBufferSize: 1e6,
    // Socket.IO restores rooms and missed packets for short drops. The seat and
    // game state still go through room:resync, because socket ids change.
    connectionStateRecovery: {
      maxDisconnectionDuration: reconnectGraceMs,
      skipMiddlewares: false,
    },
  });
  if (infra) io.adapter(createAdapter(infra.redis.publisher, infra.redis.subscriber));

  const game = new Game();
  const profiles = new ProfileStore();
  const reports = new ReportStore();
  const matchmaker = new Matchmaker(options.matchmaking);
  const disconnectTimers = new Map<string, NodeJS.Timeout>();
  const saveTimers = new Map<string, NodeJS.Timeout>();
  /** Session token -> the one socket currently allowed to act as that seat. */
  const seatSockets = new Map<string, string>();
  /** Profile binding per socket. Tokens stay on the client; never logged. */
  const identities = new Map<string, { profileId: string; token: string }>();
  const rateLimits: Record<"auth" | "room" | "chat" | "draw", RateConfig> = { ...DEFAULT_LIMITS };
  let reportCooldownMs = 60_000;
  const pendingWrites = new Set<Promise<unknown>>();
  /** Deduplicates turn:end broadcasts when a room snapshot is re-emitted. */
  const emittedTurnSummaries = new Map<string, string>();

  const track = <T>(task: Promise<T>, context: string): Promise<T> => {
    pendingWrites.add(task);
    void task.finally(() => pendingWrites.delete(task));
    task.catch((error: unknown) =>
      logger.error({ err: error, context }, "background persistence failed"),
    );
    return task;
  };

  const publicProfile = (profile: Profile) => ({
    id: profile.id,
    name: profile.name,
    avatar: profile.avatar,
    stats: { ...profile.stats },
    accuracy: accuracyOf(profile.stats),
  });

  /**
   * Snapshots are debounced per room because strokes arrive in bursts. The
   * writer re-checks room identity so a late timer cannot resurrect a room that
   * has since been removed.
   */
  const scheduleSave = (room: Room) => {
    if (!infra) return;
    const pending = saveTimers.get(room.code);
    if (pending) clearTimeout(pending);
    const timer = setTimeout(() => {
      saveTimers.delete(room.code);
      if (game.rooms.get(room.code) !== room) {
        void infra.roomStore.remove(room.code).catch((error: unknown) =>
          logger.warn({ err: error, roomCode: room.code }, "failed to remove room snapshot"),
        );
        return;
      }
      void infra.roomStore.save(room).catch((error: unknown) =>
        logger.warn({ err: error, roomCode: room.code }, "failed to save room snapshot"),
      );
    });
    timer.unref?.();
    saveTimers.set(room.code, timer);
  };

  const finalStandings = (room: Room) =>
    [...room.players]
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .map((player, index) => ({
        profileId: player.profileId,
        name: player.name,
        avatar: player.avatar,
        score: player.score,
        rank: index + 1,
        won: index === 0,
        guesses: player.guesses,
        correctGuesses: player.correctGuesses,
      }));

  const emitGameOver = (room: Room, match: unknown) => {
    io.to(room.code).emit("game:over", {
      match,
      players: finalStandings(room),
      drawingGallery: room.drawingGallery,
    });
  };

  const finalizeMatch = (room: Room) => {
    if (room.status !== "ended" || room.matchRecorded) return;
    room.matchRecorded = true;
    if (!room.players.length) return;
    const input: MatchInput = {
      roomCode: room.code,
      rounds: room.maxRounds,
      players: room.players.map((player) => ({
        profileId: player.profileId,
        name: player.name,
        avatar: player.avatar,
        score: player.score,
        guesses: player.guesses,
        correctGuesses: player.correctGuesses,
      })),
    };
    if (!input.players.length) return;

    if (infra) {
      const task = infra.matches
        .record(input, room.roomId)
        .then((match) => {
          room.matchId = match.id;
          io.to(room.code).emit("match:ended", match);
          emitGameOver(room, match);
          scheduleSave(room);
        })
        .catch((error: unknown) => {
          // Allow a later emit (or shutdown flush) to retry; the unique
          // finalization key makes retries idempotent.
          room.matchRecorded = false;
          logger.error({ err: error, roomCode: room.code }, "match finalization failed");
        });
      track(task, "match finalization");
      return;
    }

    const match = profiles.recordMatch(input);
    room.matchId = match.id;
    io.to(room.code).emit("match:ended", match);
    emitGameOver(room, match);
  };

  const emitRoom = (room: Room) => {
    finalizeMatch(room);
    for (const player of room.players) io.to(player.id).emit("room:update", publicRoom(room, player.id));
    for (const spectator of room.spectators) {
      io.to(spectator.id).emit("room:update", publicRoom(room, spectator.id));
    }
    const summary = room.lastTurnSummary;
    if (summary && emittedTurnSummaries.get(room.code) !== summary.id) {
      emittedTurnSummaries.set(room.code, summary.id);
      io.to(room.code).emit("turn:end", summary);
    }
    scheduleSave(room);
  };

  const roomRemoved = (code: string, updated: Room | undefined) => {
    emittedTurnSummaries.delete(code);
    if (updated) {
      emitRoom(updated);
      return;
    }
    if (infra) {
      const pending = saveTimers.get(code);
      if (pending) clearTimeout(pending);
      saveTimers.delete(code);
      void infra.roomStore
        .remove(code)
        .catch((error: unknown) => logger.warn({ err: error, code }, "failed to drop room snapshot"));
    }
  };

  /**
   * One seat, one live socket. A fast app restart can reconnect with the same
   * session token before the old socket has timed out; replace that binding
   * instead of creating two seats or letting both draw.
   */
  const bindSeatSocket = (socket: Socket, token: string, code: string) => {
    const previous = seatSockets.get(token);
    if (previous && previous !== socket.id) {
      const stale = io.sockets.sockets.get(previous);
      if (stale) {
        stale.emit("session:replaced", {
          error: "This seat was resumed from another connection.",
        });
        stale.leave(code);
        stale.data.replaced = true;
        stale.disconnect(true);
      }
      identities.delete(previous);
    }
    seatSockets.set(token, socket.id);
    socket.data.seatToken = token;
  };

  /** Holds a disconnected seat for the reconnect grace period, then releases it. */
  const scheduleSeatRemoval = (code: string, token: string) => {
    const pending = disconnectTimers.get(token);
    if (pending) clearTimeout(pending);
    const timer = setTimeout(() => {
      disconnectTimers.delete(token);
      const current = game.rooms.get(code);
      const seat =
        current?.players.find((player) => player.sessionToken === token) ??
        current?.spectators.find((spectator) => spectator.sessionToken === token);
      if (!current || !seat || seat.connected) return;
      if (seatSockets.get(token) === seat.id) seatSockets.delete(token);
      roomRemoved(code, game.removePlayer(seat.id));
    }, reconnectGraceMs);
    timer.unref?.();
    disconnectTimers.set(token, timer);
  };

  /** Word choices are only ever sent to the current drawer's socket. */
  const emitWordOptions = (room: Room) => {
    if (room.drawerId && room.status === "choosing") {
      io.to(room.drawerId).emit("word:options", [...room.wordChoices]);
    }
  };

  const fail = (ack: Ack, error: unknown) => {
    if (error instanceof GameError) {
      ack?.({ ok: false, error: error.message, code: error.code });
      return;
    }
    if (error instanceof ValidationError) {
      ack?.({ ok: false, error: error.message, code: error.code });
      return;
    }
    if (error instanceof z.ZodError) {
      ack?.({ ok: false, error: "Invalid request", code: "VALIDATION" });
      return;
    }
    logger.error({ err: error }, "unexpected socket handler error");
    ack?.({ ok: false, error: "Something went wrong", code: "INTERNAL" });
  };

  const loadModerationSettings = async () => {
    if (!infra) return;
    try {
      const all = await infra.settings.all();
      for (const key of ["auth", "room", "chat", "draw"] as const) {
        if (isRateConfig(all[key])) rateLimits[key] = all[key];
      }
      const report = all.report as { cooldownMs?: unknown } | undefined;
      if (
        report &&
        typeof report.cooldownMs === "number" &&
        Number.isFinite(report.cooldownMs) &&
        report.cooldownMs >= 1_000 &&
        report.cooldownMs <= 600_000
      ) {
        reportCooldownMs = report.cooldownMs;
      }
    } catch (error) {
      logger.warn({ err: error }, "failed to load moderation settings; using defaults");
    }
  };

  /**
   * Distributed abuse control. The identity is the persistent player id when
   * known, otherwise the transport address, so reconnecting sockets cannot
   * reset a bucket.
   */
  const clientAddress = (socket: Socket): string => {
    if (options.trustProxy) {
      const header = socket.handshake.headers["x-forwarded-for"];
      const first = Array.isArray(header) ? header[0] : header?.split(",")[0];
      if (first?.trim()) return first.trim();
    }
    return socket.handshake.address || socket.id;
  };

  const rateLimited = async (
    socket: Socket,
    bucket: "auth" | "room" | "chat" | "draw" | "report",
    ack: Ack,
    overrideKey?: string,
  ): Promise<boolean> => {
    if (!infra) return false;
    const config = bucket === "report" ? { windowMs: reportCooldownMs, max: 1 } : rateLimits[bucket];
    const identity =
      overrideKey ?? identities.get(socket.id)?.profileId ?? clientAddress(socket);
    let allowed = false;
    try {
      allowed = await infra.limiter.allow(bucket, identity, config);
    } catch (error) {
      // The limiter itself already falls back locally; this is belt-and-braces.
      logger.warn({ err: error, bucket }, "rate limiter unavailable");
      return false;
    }
    if (!allowed) {
      ack?.({
        ok: false,
        code: "RATE_LIMITED",
        error: "Too many requests. Please slow down and try again shortly.",
      });
    }
    return !allowed;
  };

  /* --------------------------- Admin HTTP API ---------------------------- */

  const adminEnabled = Boolean(infra && options.adminToken);
  const authorized = (req: Request): boolean => {
    if (!infra || !options.adminToken) return false;
    const header = req.headers.authorization ?? "";
    const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
    const a = Buffer.from(provided);
    const b = Buffer.from(options.adminToken);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
    if (!adminEnabled) {
      res.status(404).json({ ok: false, error: "Admin API is disabled" });
      return;
    }
    if (!authorized(req)) {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }
    next();
  };

  app.get("/api/admin/settings", requireAdmin, async (_req, res) => {
    try {
      res.json({ ok: true, settings: await infra!.settings.all() });
    } catch (error) {
      logger.error({ err: error }, "failed to read moderation settings");
      res.status(503).json({ ok: false, error: "Settings unavailable" });
    }
  });

  app.put("/api/admin/settings/:key", requireAdmin, async (req, res) => {
    const key = Array.isArray(req.params.key) ? req.params.key[0]! : req.params.key;
    const value = (req.body as { value?: unknown } | undefined)?.value;
    const validRate =
      key !== "report" && Object.hasOwn(DEFAULT_LIMITS, key) && isRateConfig(value);
    const validReport =
      key === "report" &&
      isRateConfig(value) &&
      value.windowMs >= 1_000 &&
      value.max === 1;
    if (!validRate && !validReport) {
      res.status(400).json({
        ok: false,
        error: "Expected a rate limit value for auth, room, chat, draw or report",
      });
      return;
    }
    try {
      const stored = key === "report" ? { cooldownMs: (value as RateConfig).windowMs } : value;
      await infra!.settings.set(key, stored);
      await loadModerationSettings();
      logger.info({ key }, "moderation setting updated");
      res.json({ ok: true, key, value: stored });
    } catch (error) {
      logger.error({ err: error, key }, "failed to update moderation setting");
      res.status(503).json({ ok: false, error: "Settings unavailable" });
    }
  });

  app.post("/api/admin/bans", requireAdmin, async (req, res) => {
    const body = (req.body ?? {}) as {
      playerId?: unknown;
      roomId?: unknown;
      reason?: unknown;
      expiresAt?: unknown;
    };
    const playerId = typeof body.playerId === "string" ? body.playerId : "";
    const roomId = typeof body.roomId === "string" ? body.roomId : null;
    if (!z.string().uuid().safeParse(playerId).success || (roomId && !z.string().uuid().safeParse(roomId).success)) {
      res.status(400).json({ ok: false, error: "playerId and roomId must be UUIDs" });
      return;
    }
    const reason = typeof body.reason === "string" ? body.reason.slice(0, 200) : "Administrative ban";
    const expiresAt =
      typeof body.expiresAt === "string" && !Number.isNaN(Date.parse(body.expiresAt))
        ? new Date(body.expiresAt)
        : null;
    try {
      await infra!.bans.add({ playerId, roomId, bannedBy: null, reason, expiresAt });
      logger.info({ playerId, roomId }, "administrative ban recorded");
      res.json({ ok: true });
    } catch (error) {
      logger.error({ err: error }, "failed to record administrative ban");
      res.status(503).json({ ok: false, error: "Ban store unavailable" });
    }
  });

  app.delete("/api/admin/bans/:playerId", requireAdmin, async (req, res) => {
    const playerId = Array.isArray(req.params.playerId) ? req.params.playerId[0]! : req.params.playerId;
    if (!z.string().uuid().safeParse(playerId).success) {
      res.status(400).json({ ok: false, error: "playerId must be a UUID" });
      return;
    }
    try {
      await infra!.bans.revoke(playerId, null);
      res.json({ ok: true });
    } catch (error) {
      logger.error({ err: error }, "failed to revoke ban");
      res.status(503).json({ ok: false, error: "Ban store unavailable" });
    }
  });

  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (error instanceof SyntaxError) {
      res.status(400).json({ ok: false, error: "Invalid JSON body" });
      return;
    }
    next(error);
  });

  /* ---------------------------- Matchmaking ------------------------------ */

  const requeue = async (entries: QueueEntry[]) => {
    for (const entry of entries) {
      try {
        if (infra) await infra.matchmaker.enqueue({ ...entry, joinedAt: Date.now() }, instanceId);
        else matchmaker.enqueue({ ...entry, joinedAt: Date.now() });
      } catch {
        // A concurrent enqueue already restored this player; ignore.
      }
    }
  };

  const createMatchedRoom = (live: QueueEntry[], config: MatchmakingConfig): boolean => {
    const host = live[0]!;
    let room: Room;
    try {
      room = game.createRoom(host.socketId, host.name, host.profileId, host.avatar);
      room.visibility = "public";
      room.maxPlayers = config.maxPlayers;
      for (const entry of live.slice(1)) {
        game.joinRoom(room.code, entry.socketId, entry.name, {
          profileId: entry.profileId,
          avatar: entry.avatar,
        });
      }
      game.start(room, room.hostId);
    } catch (error) {
      logger.error({ err: error }, "matchmaking failed to create a room");
      for (const entry of live) {
        io.to(entry.socketId).emit("mm:error", { error: "Could not start a match. Please retry." });
      }
      return false;
    }

    for (const entry of live) {
      const socket = io.sockets.sockets.get(entry.socketId);
      const seat = room.players.find((player) => player.id === entry.socketId);
      if (!socket || !seat) continue;
      socket.join(room.code);
      seatSockets.set(seat.sessionToken, entry.socketId);
      if (infra) {
        void infra.presence
          .setRoom(entry.socketId, entry.profileId, room.code)
          .catch(() => undefined);
      }
      const profile = infra ? undefined : profiles.profiles.get(entry.profileId);
      socket.emit("mm:matched", {
        roomCode: room.code,
        sessionToken: seat.sessionToken,
        room: publicRoom(room, entry.socketId),
        profile: profile ? publicProfile(profile) : undefined,
      });
    }
    emitRoom(room);
    emitWordOptions(room);
    return true;
  };

  /**
   * Pairs every waiting group that meets the minimum. Rooms are created from
   * live sockets only, so a disconnect between enqueue and pairing cannot leave
   * a phantom seat. In production the queue is a Redis sorted set taken
   * atomically, so two instances cannot pair the same entries.
   */
  const tryMatch = async (): Promise<void> => {
    const config = infra?.matchmaker.config ?? matchmaker.config;
    if (infra) {
      for (;;) {
        let entries: QueueEntry[] | null = null;
        try {
          entries = await infra.matchmaker.takeMatch(instanceId);
        } catch (error) {
          logger.error({ err: error }, "matchmaking queue take failed");
          return;
        }
        if (!entries) return;
        const live = entries.filter((entry) => io.sockets.sockets.get(entry.socketId)?.connected);
        if (live.length < config.minPlayers) {
          await requeue(live);
          return;
        }
        createMatchedRoom(live, config);
      }
    }

    for (;;) {
      const entries = matchmaker.takeMatch();
      if (!entries) return;
      const live = entries.filter((entry) => io.sockets.sockets.get(entry.socketId)?.connected);
      if (live.length < config.minPlayers) {
        await requeue(live);
        return;
      }
      if (!createMatchedRoom(live, config)) continue;
    }
  };

  /** Validates a handshake bearer token once, before any event is accepted. */
  io.use(async (socket: Socket, next) => {
    if (!infra) {
      next();
      return;
    }
    const raw = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
    if (raw === undefined || raw === null || raw === "") {
      next();
      return;
    }
    if (typeof raw !== "string") {
      next(new Error("AUTH_INVALID"));
      return;
    }
    try {
      const player = await infra.auth.authenticate(raw);
      if (!player) {
        next(new Error("AUTH_INVALID"));
        return;
      }
      socket.data.authPlayer = player;
      socket.data.authToken = raw;
      next();
    } catch (error) {
      logger.error({ err: error }, "socket authentication failed");
      next(new Error("AUTH_UNAVAILABLE"));
    }
  });

  io.on("connection", (socket: Socket) => {
    const roomOf = () => game.roomOf(socket.id);
    const requireRoom = () => {
      const room = roomOf();
      if (!room) throw new GameError("NOT_IN_ROOM", "Join a room first");
      return room;
    };
    const requireIdentity = () => {
      const identity = identities.get(socket.id);
      if (!identity) throw new ValidationError("PROFILE_REQUIRED", "Pick a name first");
      return identity;
    };
    const bindAuthPlayer = (player: AuthPlayer, token: string) => {
      identities.set(socket.id, { profileId: player.id, token });
      if (infra) {
        void infra.presence.connected(socket.id, player.id).catch((error: unknown) =>
          logger.warn({ err: error }, "failed to record presence"),
        );
      }
    };

    const handshakePlayer = socket.data.authPlayer as AuthPlayer | undefined;
    const handshakeToken = socket.data.authToken as string | undefined;
    if (handshakePlayer && handshakeToken) bindAuthPlayer(handshakePlayer, handshakeToken);
    else if (infra) {
      void infra.presence
        .connected(socket.id, "anonymous")
        .catch((error: unknown) => logger.warn({ err: error }, "failed to record presence"));
    }

    /**
     * Legacy identify path, now backed by persistent accounts in production. An
     * explicit invalid token is rejected instead of silently creating a new
     * account, so a client can clear it and start a fresh guest session.
     */
    const identify = async (
      name: string | undefined,
      avatar: unknown,
      token: string | undefined,
    ): Promise<{ profile: Profile; token: string }> => {
      if (infra) {
        if (token) {
          const player = await infra.auth.authenticate(token);
          if (!player) {
            throw new ValidationError("AUTH_INVALID", "Your session has expired. Please reconnect.");
          }
          bindAuthPlayer(player, token);
          return { profile: asProfile(player), token };
        }
        const bound = identities.get(socket.id);
        if (bound) {
          const player = await infra.auth.getPlayer(bound.profileId);
          if (player) {
            bindAuthPlayer(player, bound.token);
            return { profile: asProfile(player), token: bound.token };
          }
          identities.delete(socket.id);
        }
        const created = await infra.auth.createGuest(name ?? "Player", avatar);
        bindAuthPlayer(created.player, created.token);
        return { profile: asProfile(created.player), token: created.token };
      }

      const result = profiles.identify(token, name ?? "Player", avatar);
      identities.set(socket.id, { profileId: result.profile.id, token: result.token });
      return result;
    };

    /** A socket may only occupy one seat, so drop any previous room first. */
    const detachFromPreviousRoom = () => {
      const previous = roomOf();
      const previousToken = socket.data.seatToken as string | undefined;
      if (previousToken && seatSockets.get(previousToken) === socket.id) {
        seatSockets.delete(previousToken);
      }
      socket.data.seatToken = undefined;
      if (infra) {
        void infra.matchmaker
          .cancel(socket.id, instanceId)
          .catch((error: unknown) => logger.warn({ err: error }, "failed to cancel matchmaking"));
      } else {
        matchmaker.cancel(socket.id);
      }
      if (!previous) return;
      socket.leave(previous.code);
      roomRemoved(previous.code, game.removePlayer(socket.id));
    };

    /* ------------------------------- Accounts ------------------------------ */

    socket.on("auth:guest", async (payload, ack: Ack) => {
      try {
        if (!infra) {
          throw new ValidationError("AUTH_UNAVAILABLE", "Accounts are not enabled on this server");
        }
        if (await rateLimited(socket, "auth", ack)) return;
        const data = z
          .object({ name: optionalNameSchema, avatar: avatarSchema })
          .strict()
          .parse(payload ?? {});
        const result = await infra.auth.createGuest(data.name ?? "Player", data.avatar);
        bindAuthPlayer(result.player, result.token);
        ack?.({
          ok: true,
          profile: publicProfile(asProfile(result.player)),
          token: result.token,
          expiresAt: result.expiresAt,
        });
      } catch (error) {
        fail(ack, error);
      }
    });

    socket.on("auth:restore", async (payload, ack: Ack) => {
      try {
        if (!infra) {
          throw new ValidationError("AUTH_UNAVAILABLE", "Accounts are not enabled on this server");
        }
        if (await rateLimited(socket, "auth", ack)) return;
        const data = z
          .object({ token: z.string().min(16).max(128).optional() })
          .strict()
          .parse(payload ?? {});
        const token = data.token ?? identities.get(socket.id)?.token;
        if (!token) throw new ValidationError("AUTH_REQUIRED", "No saved session to restore");
        const player = await infra.auth.authenticate(token);
        if (!player) throw new ValidationError("AUTH_INVALID", "That session is no longer valid");
        bindAuthPlayer(player, token);
        ack?.({ ok: true, profile: publicProfile(asProfile(player)), token });
      } catch (error) {
        fail(ack, error);
      }
    });

    socket.on("auth:refresh", async (payload, ack: Ack) => {
      try {
        if (!infra) {
          throw new ValidationError("AUTH_UNAVAILABLE", "Accounts are not enabled on this server");
        }
        if (await rateLimited(socket, "auth", ack)) return;
        const data = z
          .object({ token: z.string().min(16).max(128).optional() })
          .strict()
          .parse(payload ?? {});
        const token = data.token ?? identities.get(socket.id)?.token;
        if (!token) throw new ValidationError("AUTH_REQUIRED", "No session to refresh");
        const result = await infra.auth.refresh(token);
        if (!result) throw new ValidationError("AUTH_INVALID", "That session is no longer valid");
        bindAuthPlayer(result.player, result.token);
        ack?.({ ok: true, profile: publicProfile(asProfile(result.player)), token: result.token, expiresAt: result.expiresAt });
      } catch (error) {
        fail(ack, error);
      }
    });

    socket.on("auth:logout", async (payload, ack: Ack) => {
      try {
        const data = z
          .object({ token: z.string().min(16).max(128).optional() })
          .strict()
          .parse(payload ?? {});
        if (infra) {
          const token = data.token ?? identities.get(socket.id)?.token;
          if (token) await infra.auth.logout(token);
        }
        detachFromPreviousRoom();
        identities.delete(socket.id);
        socket.data.authPlayer = undefined;
        socket.data.authToken = undefined;
        if (infra) void infra.presence.disconnected(socket.id).catch(() => undefined);
        ack?.({ ok: true });
      } catch (error) {
        fail(ack, error);
      }
    });

    socket.on("auth:delete", async (_payload, ack: Ack) => {
      try {
        if (!infra) {
          throw new ValidationError("AUTH_UNAVAILABLE", "Accounts are not enabled on this server");
        }
        const identity = requireIdentity();
        await infra.auth.deleteAccount(identity.profileId);
        detachFromPreviousRoom();
        identities.delete(socket.id);
        socket.data.authPlayer = undefined;
        socket.data.authToken = undefined;
        void infra.presence.disconnected(socket.id).catch(() => undefined);
        ack?.({ ok: true });
      } catch (error) {
        fail(ack, error);
      }
    });

    socket.on("profile:identify", async (payload, ack: Ack) => {
      try {
        const data = z
          .object({ name: optionalNameSchema, avatar: avatarSchema, token: profileTokenSchema })
          .strict()
          .parse(payload);
        if (await rateLimited(socket, "auth", ack)) return;
        const { profile, token } = await identify(data.name, data.avatar, data.token);
        ack?.({ ok: true, profile: publicProfile(profile), profileToken: token });
      } catch (error) {
        fail(ack, error);
      }
    });

    socket.on("profile:update", async (payload, ack: Ack) => {
      try {
        const data = z
          .object({ name: optionalNameSchema, avatar: avatarSchema })
          .strict()
          .parse(payload);
        const identity = requireIdentity();
        let profile: Profile;
        if (infra) {
          const player = await infra.auth.updatePlayer(identity.profileId, {
            name: data.name,
            avatar: data.avatar,
          });
          if (!player) throw new ValidationError("PROFILE_REQUIRED", "Profile not found");
          profile = { ...asProfile(player), stats: await infra.players.stats(player.id) };
        } else {
          profile = profiles.update(identity.profileId, { name: data.name, avatar: data.avatar });
        }
        const room = roomOf();
        if (room) {
          game.updateIdentity(room, socket.id, profile.name, profile.avatar);
          emitRoom(room);
        }
        ack?.({ ok: true, profile: publicProfile(profile) });
      } catch (error) {
        fail(ack, error);
      }
    });

    socket.on("profile:me", async (payload, ack: Ack) => {
      try {
        z.object({}).strict().parse(payload ?? {});
        const identity = requireIdentity();
        const view = infra
          ? await infra.players.profileView(identity.profileId)
          : profiles.view(identity.profileId);
        if (!view) throw new ValidationError("PROFILE_REQUIRED", "Profile not found");
        ack?.({ ok: true, ...view, accuracy: accuracyOf(view.profile.stats) });
      } catch (error) {
        fail(ack, error);
      }
    });

    socket.on("leaderboard:global", async (payload, ack: Ack) => {
      try {
        const data = z
          .object({ limit: z.number().int().min(1).max(100).optional() })
          .strict()
          .parse(payload ?? {});
        const limit = data.limit ?? 20;
        if (infra) {
          ack?.({ ok: true, rows: await infra.players.leaderboard(limit), ephemeral: false });
          return;
        }
        ack?.({ ok: true, rows: profiles.leaderboard(limit), ephemeral: true });
      } catch (error) {
        fail(ack, error);
      }
    });

    socket.on("match:get", async (payload, ack: Ack) => {
      try {
        const data = z.object({ matchId: z.string().uuid() }).strict().parse(payload);
        const match = infra
          ? await infra.matches.get(data.matchId)
          : profiles.matches.get(data.matchId);
        if (!match) throw new ValidationError("MATCH_NOT_FOUND", "Match not found");
        const identity = identities.get(socket.id);
        const inRoom = roomOf()?.code === match.roomCode;
        const played = match.players.some((player) => player.profileId === identity?.profileId);
        if (!inRoom && !played) {
          throw new ValidationError("FORBIDDEN", "That match is not available");
        }
        ack?.({ ok: true, match });
      } catch (error) {
        fail(ack, error);
      }
    });

    socket.on("room:create", async (payload, ack: Ack) => {
      try {
        const data = z
          .object({
            name: optionalNameSchema,
            avatar: avatarSchema,
            token: profileTokenSchema,
            wordMode: z.enum(["random", "category"]).optional(),
            wordCategory: z.enum(CURATED_CATEGORY_IDS).nullable().optional(),
          })
          .strict()
          .parse(payload ?? {});
        if (await rateLimited(socket, "room", ack)) return;
        const { profile, token } = await identify(data.name, data.avatar, data.token);
        detachFromPreviousRoom();
        const room = game.createRoom(socket.id, profile.name, profile.id, profile.avatar, {
          wordMode: data.wordMode,
          wordCategory: data.wordCategory,
        });
        socket.join(room.code);
        bindSeatSocket(socket, room.players[0]!.sessionToken, room.code);
        if (infra) {
          const hostSeat = room.players[0];
          if (hostSeat) {
            void infra.presence
              .setRoom(socket.id, profile.id, room.code)
              .catch((error: unknown) => logger.warn({ err: error }, "failed to record room presence"));
            void infra.presence
              .rememberRoomSession(hostSeat.sessionToken, room.code, profile.id)
              .catch((error: unknown) => logger.warn({ err: error }, "failed to remember room session"));
          }
          const saved = await infra.wordLists.get(profile.id).catch((error: unknown) => {
            logger.warn({ err: error }, "failed to load saved word list");
            return null;
          });
          if (saved && saved.length) {
            try {
              game.setCategories(room, socket.id, validateCategories(saved));
            } catch (error) {
              logger.warn({ err: error }, "ignored an invalid saved word list");
            }
          }
        }
        ack?.({
          ok: true,
          room: publicRoom(room, socket.id),
          sessionToken: room.players[0]!.sessionToken,
          profile: publicProfile(profile),
          profileToken: token,
        });
        emitRoom(room);
      } catch (error) {
        fail(ack, error);
      }
    });

    socket.on("room:join", async (payload, ack: Ack) => {
      try {
        const data = z
          .object({
            code: codeSchema,
            name: optionalNameSchema,
            avatar: avatarSchema,
            token: profileTokenSchema,
            invite: inviteSchema,
          })
          .strict()
          .parse(payload);
        if (await rateLimited(socket, "room", ack)) return;
        const { profile, token } = await identify(data.name, data.avatar, data.token);
        const code = data.code.trim().toUpperCase();
        const target = infra ? game.rooms.get(code) : undefined;
        if (infra && target && (await infra.bans.isBanned(profile.id, target.roomId))) {
          throw new GameError("BANNED", "You were banned from this room");
        }
        detachFromPreviousRoom();
        const joined = game.joinRoom(data.code, socket.id, profile.name, {
          profileId: profile.id,
          avatar: profile.avatar,
          invite: data.invite,
        });
        socket.join(joined.room.code);
        const seat = joined.room.players.find((player) => player.id === socket.id) ??
          joined.room.spectators.find((spectator) => spectator.id === socket.id);
        if (seat) bindSeatSocket(socket, seat.sessionToken, joined.room.code);
        if (infra && seat) {
          void infra.presence
            .setRoom(socket.id, profile.id, joined.room.code)
            .catch((error: unknown) => logger.warn({ err: error }, "failed to record room presence"));
          void infra.presence
            .rememberRoomSession(seat.sessionToken, joined.room.code, profile.id)
            .catch((error: unknown) => logger.warn({ err: error }, "failed to remember room session"));
        }
        ack?.({
          ok: true,
          room: publicRoom(joined.room, socket.id),
          sessionToken: joined.sessionToken,
          spectator: joined.spectator,
          profile: publicProfile(profile),
          profileToken: token,
        });
        emitRoom(joined.room);
      } catch (error) {
        fail(ack, error);
      }
    });

    /** Restores an existing seat (same score, drawer role, guesses) after a reconnect. */
    socket.on("room:resume", async (payload, ack: Ack) => {
      try {
        const data = z
          .object({ code: codeSchema, token: z.string().min(8).max(128) })
          .strict()
          .parse(payload);
        if (await rateLimited(socket, "room", ack)) return;
        const existing = roomOf();
        if (existing && existing.code !== data.code.toUpperCase()) detachFromPreviousRoom();

        const candidate = game.rooms.get(data.code.toUpperCase());
        const candidateSeat =
          candidate?.players.find((player) => player.sessionToken === data.token) ??
          candidate?.spectators.find((spectator) => spectator.sessionToken === data.token);
        if (infra && candidate && candidateSeat) {
          if (await infra.bans.isBanned(candidateSeat.profileId, candidate.roomId)) {
            throw new GameError("BANNED", "You were banned from this room");
          }
        }

        const { room, player, spectator } = game.resumeSession(data.code, data.token, socket.id);
        const seat = player ?? spectator!;
        const timer = disconnectTimers.get(seat.sessionToken);
        if (timer) {
          clearTimeout(timer);
          disconnectTimers.delete(seat.sessionToken);
        }
        const identity = identities.get(socket.id);
        identities.set(socket.id, {
          profileId: seat.profileId,
          token: identity?.token ?? "",
        });
        socket.join(room.code);
        bindSeatSocket(socket, seat.sessionToken, room.code);
        if (infra) {
          void infra.presence
            .setRoom(socket.id, seat.profileId, room.code)
            .catch((error: unknown) => logger.warn({ err: error }, "failed to record room presence"));
          void infra.presence
            .rememberRoomSession(seat.sessionToken, room.code, seat.profileId)
            .catch((error: unknown) => logger.warn({ err: error }, "failed to remember room session"));
        }
        const profile = infra ? undefined : profiles.profiles.get(seat.profileId);
        ack?.({
          ok: true,
          room: publicRoom(room, socket.id),
          sessionToken: seat.sessionToken,
          spectator: spectator != null,
          profile: profile ? publicProfile(profile) : undefined,
          recovered: socket.recovered,
        });
        emitRoom(room);
      } catch (error) {
        fail(ack, error);
      }
    });

    let resyncTokens = 3;
    let resyncRefillAt = Date.now();
    const takeResyncToken = () => {
      const now = Date.now();
      resyncTokens = Math.min(3, resyncTokens + (now - resyncRefillAt) / 1000);
      resyncRefillAt = now;
      if (resyncTokens < 1) return false;
      resyncTokens -= 1;
      return true;
    };

    /**
     * Explicit recovery handshake. Works after a transport drop, after the OS
     * killed the socket, or after a server restart (seat token + Redis room
     * snapshot), and returns one complete authoritative snapshot.
     */
    socket.on("room:resync", async (payload, ack: Ack) => {
      try {
        const data = z
          .object({ code: codeSchema.optional(), token: z.string().min(8).max(128).optional() })
          .strict()
          .parse(payload ?? {});
        if (!takeResyncToken()) {
          ack?.({ ok: false, code: "RATE_LIMITED", error: "Resyncing too often. Wait a moment." });
          return;
        }
        if ((data.code && !data.token) || (!data.code && data.token)) {
          throw new ValidationError("INVALID_SESSION", "Send both the room code and seat token");
        }

        let room = roomOf();
        if (!room && data.code && data.token) {
          const code = data.code.toUpperCase();
          const candidate = game.rooms.get(code);
          const candidateSeat =
            candidate?.players.find((player) => player.sessionToken === data.token) ??
            candidate?.spectators.find((spectator) => spectator.sessionToken === data.token);
          if (infra && candidate && candidateSeat) {
            if (await infra.bans.isBanned(candidateSeat.profileId, candidate.roomId)) {
              throw new GameError("BANNED", "You were banned from this room");
            }
          }
          const resumed = game.resumeSession(code, data.token, socket.id);
          room = resumed.room;
          const timer = disconnectTimers.get(data.token);
          if (timer) {
            clearTimeout(timer);
            disconnectTimers.delete(data.token);
          }
        }

        if (!room) throw new GameError("NOT_IN_ROOM", "No room to resync. Rejoin from home.");
        socket.join(room.code);
        const seat =
          room.players.find((player) => player.id === socket.id) ??
          room.spectators.find((spectator) => spectator.id === socket.id);
        if (!seat) throw new GameError("NOT_IN_ROOM", "No seat in this room");
        bindSeatSocket(socket, seat.sessionToken, room.code);
        if (infra) {
          void infra.presence
            .setRoom(socket.id, seat.profileId, room.code)
            .catch((error: unknown) => logger.warn({ err: error }, "failed to record room presence"));
        }
        ack?.({
          ok: true,
          room: publicRoom(room, socket.id),
          sessionToken: seat.sessionToken,
          spectator: room.spectators.some((spectator) => spectator.id === socket.id),
          recovered: socket.recovered,
        });
        emitRoom(room);
      } catch (error) {
        fail(ack, error);
      }
    });

    /** Public lobbies anyone may browse from the home screen. */
    socket.on("rooms:list", (_payload, ack: Ack) => {
      ack?.({ ok: true, rooms: game.listPublicRooms().map(publicRoomSummary) });
    });

    socket.on("room:sync", (_payload, ack: Ack) => {
      try {
        const room = requireRoom();
        ack?.({ ok: true, room: publicRoom(room, socket.id) });
      } catch (error) {
        fail(ack, error);
      }
    });

    socket.on("room:invite", (_payload, ack: Ack) => {
      try {
        const room = requireRoom();
        ack?.({ ok: true, ...game.inviteFor(room, socket.id) });
      } catch (error) {
        fail(ack, error);
      }
    });

    socket.on("room:configure", (payload, ack: Ack) => {
      try {
        const room = requireRoom();
        const data = configureSchema.parse(payload);
        game.configure(room, socket.id, data);
        ack?.({ ok: true, room: publicRoom(room, socket.id) });
        emitRoom(room);
      } catch (error) {
        fail(ack, error);
      }
    });

    socket.on("words:get", (_payload, ack: Ack) => {
      try {
        const room = requireRoom();
        if (room.hostId !== socket.id) throw new GameError("NOT_HOST", "Only the host can view word lists");
        ack?.({ ok: true, categories: room.categories });
      } catch (error) {
        fail(ack, error);
      }
    });

    socket.on("words:set", async (payload, ack: Ack) => {
      try {
        const room = requireRoom();
        const data = z.object({ categories: z.array(z.unknown()).max(8) }).strict().parse(payload);
        const categories = game.setCategories(room, socket.id, data.categories);
        const identity = identities.get(socket.id);
        if (infra && identity) {
          try {
            await infra.wordLists.save(identity.profileId, categories);
          } catch (error) {
            logger.warn({ err: error }, "failed to persist custom word list");
          }
        }
        ack?.({ ok: true, categories });
        emitRoom(room);
      } catch (error) {
        fail(ack, error);
      }
    });

    /** Explicit leave: remove the seat immediately instead of holding it open. */
    socket.on("room:leave", (_payload, ack: Ack) => {
      try {
        const room = roomOf();
        const code = room?.code;
        if (room) socket.leave(room.code);
        roomRemoved(code ?? "", room ? game.removePlayer(socket.id) : undefined);
        if (infra) {
          const identity = identities.get(socket.id);
          void infra.presence
            .connected(socket.id, identity?.profileId ?? "anonymous")
            .catch(() => undefined);
          void infra.matchmaker
            .cancel(socket.id, instanceId)
            .catch((error: unknown) => logger.warn({ err: error }, "failed to cancel matchmaking"));
        } else {
          matchmaker.cancel(socket.id);
        }
        ack?.({ ok: true });
      } catch (error) {
        fail(ack, error);
      }
    });

    socket.on("game:start", (_payload, ack: Ack) => {
      try {
        const room = requireRoom();
        game.start(room, socket.id);
        ack?.({ ok: true });
        emitRoom(room);
        emitWordOptions(room);
      } catch (error) {
        fail(ack, error);
      }
    });

    socket.on("word:choose", (payload, ack: Ack) => {
      try {
        const room = requireRoom();
        const data = z.object({ word: z.string().min(1).max(40) }).strict().parse(payload);
        const expired = game.advanceIfExpired(room);
        if (expired.changed) {
          emitRoom(room);
          if (expired.wordOptions) emitWordOptions(room);
          throw new GameError("WRONG_PHASE", "The word choice timed out");
        }
        game.chooseWord(room, socket.id, data.word);
        ack?.({ ok: true });
        emitRoom(room);
      } catch (error) {
        fail(ack, error);
      }
    });

    /* ------------------------------ Quick Play ----------------------------- */

    socket.on("mm:enqueue", async (payload, ack: Ack) => {
      try {
        const data = z
          .object({ name: optionalNameSchema, avatar: avatarSchema, token: profileTokenSchema })
          .strict()
          .parse(payload ?? {});
        if (roomOf()) {
          throw new ValidationError("IN_ROOM", "Leave your room before joining Quick Play");
        }
        if (await rateLimited(socket, "room", ack)) return;
        const { profile, token } = await identify(data.name, data.avatar, data.token);
        const config = infra?.matchmaker.config ?? matchmaker.config;
        const entry: QueueEntry = {
          socketId: socket.id,
          profileId: profile.id,
          name: profile.name,
          avatar: profile.avatar,
          joinedAt: Date.now(),
        };
        const queued = infra
          ? await infra.matchmaker.enqueue(entry, instanceId)
          : matchmaker.enqueue(entry);
        ack?.({
          ok: true,
          ...queued,
          profile: publicProfile(profile),
          profileToken: token,
          minPlayers: config.minPlayers,
        });
        socket.emit("mm:queued", {
          position: queued.position,
          size: queued.size,
          minPlayers: config.minPlayers,
        });
        void tryMatch();
      } catch (error) {
        fail(ack, error);
      }
    });

    socket.on("mm:cancel", async (_payload, ack: Ack) => {
      try {
        const removed = infra
          ? await infra.matchmaker.cancel(socket.id, instanceId)
          : matchmaker.cancel(socket.id);
        ack?.({ ok: true, removed });
        socket.emit("mm:cancelled", { removed });
      } catch (error) {
        fail(ack, error);
      }
    });

    /* ----------------------------- Moderation ------------------------------ */

    socket.on("moderation:kick", async (payload, ack: Ack) => {
      try {
        const room = requireRoom();
        const data = z
          .object({ targetId: z.string().min(1).max(128), ban: z.boolean().optional() })
          .strict()
          .parse(payload);
        const target =
          room.players.find((player) => player.id === data.targetId) ??
          room.spectators.find((spectator) => spectator.id === data.targetId);
        const host = identities.get(socket.id);
        const result = game.kick(room, socket.id, data.targetId, data.ban ?? false);
        if (infra && data.ban && target?.profileId) {
          try {
            await infra.bans.add({
              playerId: target.profileId,
              roomId: room.roomId,
              roomCode: room.code,
              bannedBy: host?.profileId ?? null,
              reason: "Removed by the room host",
            });
          } catch (error) {
            logger.warn({ err: error, roomCode: room.code }, "failed to persist room ban");
          }
        }
        io.to(data.targetId).emit("room:kicked", {
          code: room.code,
          banned: data.ban ?? false,
          error: data.ban ? "You were banned by the host" : "You were removed by the host",
        });
        io.sockets.sockets.get(data.targetId)?.leave(room.code);
        ack?.({ ok: true });
        roomRemoved(room.code, result.room);
      } catch (error) {
        fail(ack, error);
      }
    });

    socket.on("moderation:mute", (payload, ack: Ack) => {
      try {
        const room = requireRoom();
        const data = z
          .object({ targetId: z.string().min(1).max(128), muted: z.boolean() })
          .strict()
          .parse(payload);
        const target = game.mute(room, socket.id, data.targetId, data.muted);
        io.to(target.id).emit("moderation:muted", { muted: data.muted });
        ack?.({ ok: true, muted: data.muted });
        emitRoom(room);
      } catch (error) {
        fail(ack, error);
      }
    });

    socket.on("moderation:report", async (payload, ack: Ack) => {
      try {
        const room = requireRoom();
        const data = z
          .object({ targetId: z.string().min(1).max(128), reason: z.string().min(5).max(200) })
          .strict()
          .parse(payload);
        if (data.targetId === socket.id) throw new GameError("CANT_MODERATE", "You cannot report yourself");
        const target =
          room.players.find((player) => player.id === data.targetId) ??
          room.spectators.find((spectator) => spectator.id === data.targetId);
        if (!target) throw new GameError("NOT_IN_ROOM", "That player is not here");
        const identity = requireIdentity();
        if (
          await rateLimited(
            socket,
            "report",
            ack,
            `${identity.profileId}:${target.profileId ?? target.id}`,
          )
        ) {
          return;
        }
        const reporter =
          room.players.find((player) => player.id === socket.id) ??
          room.spectators.find((spectator) => spectator.id === socket.id);
        if (!reporter) throw new GameError("NOT_IN_ROOM", "Join a room first");
        let report: Report = reports.add({
          roomCode: room.code,
          reporterId: socket.id,
          reporterName: reporter.name,
          reporterProfileId: identity.profileId,
          targetId: target.id,
          targetName: target.name,
          targetProfileId: target.profileId,
          reason: data.reason,
        });
        if (infra) {
          try {
            report = await infra.reportRepo.save(
              {
                roomCode: room.code,
                reporterId: socket.id,
                reporterName: reporter.name,
                reporterProfileId: identity.profileId,
                targetId: target.id,
                targetName: target.name,
                targetProfileId: target.profileId,
                reason: data.reason,
              },
              room.roomId,
            );
          } catch (error) {
            logger.warn({ err: error, roomCode: room.code }, "failed to persist report");
          }
        }
        io.to(room.hostId).emit("moderation:report", report);
        ack?.({ ok: true, reportId: report.id });
      } catch (error) {
        fail(ack, error);
      }
    });

    socket.on("moderation:state", async (_payload, ack: Ack) => {
      try {
        const room = requireRoom();
        if (room.hostId !== socket.id) throw new GameError("NOT_HOST", "Only the host can review reports");
        let roomReports: Report[] | null = null;
        if (infra) {
          roomReports = await infra.reportRepo.forRoom(room.roomId).catch((error: unknown) => {
            logger.warn({ err: error, roomCode: room.code }, "failed to load persisted reports");
            return null;
          });
        }
        ack?.({
          ok: true,
          mutedProfileIds: Array.from(room.mutedProfileIds),
          bannedProfileIds: Array.from(room.bannedProfileIds),
          reports: roomReports ?? reports.forRoom(room.code),
        });
      } catch (error) {
        fail(ack, error);
      }
    });

    /* ------------------------------ Drawing -------------------------------- */

    // Stroke traffic is already batched; this bucket stops a malicious client
    // from flooding the server with tiny events.
    let drawTokens = 120;
    let drawRefillAt = Date.now();
    const takeDrawToken = () => {
      const now = Date.now();
      drawTokens = Math.min(120, drawTokens + ((now - drawRefillAt) / 1000) * 120);
      drawRefillAt = now;
      if (drawTokens < 1) return false;
      drawTokens -= 1;
      return true;
    };

    socket.on("draw:stroke:begin", async (payload, ack: Ack) => {
      try {
        if (!takeDrawToken()) throw new GameError("RATE_LIMITED", "Slow down");
        if (await rateLimited(socket, "draw", ack)) return;
        const room = requireRoom();
        const data = beginStrokeSchema.parse(payload);
        // Retransmitted begin events (ack lost on a mobile network) are no-ops.
        const existing = room.strokes.find((candidate) => candidate.id === data.id);
        if (existing && room.drawerId === socket.id && room.status === "drawing") {
          ack?.({
            ok: true,
            seq: existing.seq,
            boardVersion: room.boardVersion,
            duplicate: true,
          });
          return;
        }
        const stroke = game.beginStroke(room, socket.id, data);
        scheduleSave(room);
        socket.to(room.code).emit("draw:stroke:begin", {
          id: stroke.id,
          seq: stroke.seq,
          color: stroke.color,
          width: stroke.width,
          tool: stroke.tool,
          boardVersion: room.boardVersion,
        });
        ack?.({ ok: true, seq: stroke.seq, boardVersion: room.boardVersion });
      } catch (error) {
        fail(ack, error);
      }
    });

    socket.on("draw:stroke:points", (payload, ack: Ack) => {
      try {
        if (!takeDrawToken()) throw new GameError("RATE_LIMITED", "Slow down");
        const room = requireRoom();
        const data = strokePointsSchema.parse(payload);
        const { stroke, appended } = game.appendStrokePoints(
          room,
          socket.id,
          data.id,
          data.points as Point[],
          data.seq,
        );
        scheduleSave(room);
        if (appended > 0) {
          socket.to(room.code).emit("draw:stroke:points", {
            id: stroke.id,
            points: data.points,
          });
        }
        ack?.({ ok: true, appended });
      } catch (error) {
        fail(ack, error);
      }
    });

    socket.on("draw:stroke:end", (payload, ack: Ack) => {
      try {
        if (!takeDrawToken()) throw new GameError("RATE_LIMITED", "Slow down");
        const room = requireRoom();
        const data = strokeIdPayloadSchema.parse(payload);
        const stroke = game.endStroke(room, socket.id, data.id);
        scheduleSave(room);
        socket.to(room.code).emit("draw:stroke:end", { id: stroke.id });
        ack?.({ ok: true });
      } catch (error) {
        fail(ack, error);
      }
    });

    socket.on("draw:shape", (payload, ack: Ack) => {
      try {
        const room = requireRoom();
        const data = shapeSchema.parse(payload);
        const stroke = game.addShape(room, socket.id, data);
        scheduleSave(room);
        socket.to(room.code).emit("draw:shape", { action: stroke, boardVersion: room.boardVersion });
        ack?.({ ok: true, boardVersion: room.boardVersion });
      } catch (error) {
        fail(ack, error);
      }
    });

    socket.on("draw:fill", (payload, ack: Ack) => {
      try {
        const room = requireRoom();
        const data = fillSchema.parse(payload);
        const stroke = game.addFill(room, socket.id, data);
        scheduleSave(room);
        socket.to(room.code).emit("draw:fill", { action: stroke, boardVersion: room.boardVersion });
        ack?.({ ok: true, boardVersion: room.boardVersion });
      } catch (error) {
        fail(ack, error);
      }
    });

    socket.on("draw:undo", (_payload, ack: Ack) => {
      try {
        const room = requireRoom();
        const stroke = game.undo(room, socket.id);
        scheduleSave(room);
        const payloadOut = {
          strokeId: stroke.id,
          undoDepth: room.strokes.length,
          redoDepth: room.redoStack.length,
          boardVersion: room.boardVersion,
        };
        io.to(room.code).emit("draw:undo", payloadOut);
        ack?.({ ok: true, ...payloadOut });
      } catch (error) {
        fail(ack, error);
      }
    });

    socket.on("draw:redo", (_payload, ack: Ack) => {
      try {
        const room = requireRoom();
        const stroke = game.redo(room, socket.id);
        scheduleSave(room);
        const payloadOut = {
          stroke,
          undoDepth: room.strokes.length,
          redoDepth: room.redoStack.length,
          boardVersion: room.boardVersion,
        };
        io.to(room.code).emit("draw:redo", payloadOut);
        ack?.({ ok: true, ...payloadOut });
      } catch (error) {
        fail(ack, error);
      }
    });

    socket.on("draw:clear", (_payload, ack: Ack) => {
      try {
        const room = requireRoom();
        const action = game.clearBoard(room, socket.id);
        scheduleSave(room);
        const payloadOut = {
          action,
          undoDepth: room.strokes.length,
          redoDepth: room.redoStack.length,
          boardVersion: room.boardVersion,
        };
        io.to(room.code).emit("draw:clear", payloadOut);
        ack?.({ ok: true, ...payloadOut });
      } catch (error) {
        fail(ack, error);
      }
    });

    socket.on("drawing:react", (payload, ack: Ack) => {
      try {
        const room = requireRoom();
        const data = z
          .object({ reaction: z.enum(["like", "nope"]) })
          .strict()
          .parse(payload);
        const result = game.react(room, socket.id, data.reaction);
        if (!result.duplicate) {
          io.to(room.code).emit("drawing:reactionUpdate", {
            likes: result.likes,
            nopes: result.nopes,
            voterName: result.voterName,
            reaction: result.reaction,
          });
          emitRoom(room);
        }
        ack?.({ ok: true, duplicate: result.duplicate, likes: result.likes, nopes: result.nopes });
      } catch (error) {
        fail(ack, error);
      }
    });

    /* -------------------------------- Chat --------------------------------- */

    // Small token bucket: allows quick guessing bursts, blocks floods.
    let chatTokens = 5;
    let chatRefillAt = Date.now();
    const takeChatToken = () => {
      const now = Date.now();
      chatTokens = Math.min(5, chatTokens + (now - chatRefillAt) / 200);
      chatRefillAt = now;
      if (chatTokens < 1) return false;
      chatTokens -= 1;
      return true;
    };

    socket.on("chat:guess", async (payload, ack: Ack) => {
      try {
        const room = requireRoom();
        const data = z.object({ text: z.string().trim().min(1).max(100) }).strict().parse(payload);

        if (!takeChatToken()) {
          ack?.({ ok: false, correct: false, error: "Slow down a little", code: "RATE_LIMITED" });
          return;
        }
        if (await rateLimited(socket, "chat", undefined)) {
          ack?.({ ok: false, correct: false, error: "Slow down a little", code: "RATE_LIMITED" });
          return;
        }
        if (game.isMuted(room, socket.id)) {
          ack?.({ ok: false, correct: false, error: "You are muted by the host", code: "MUTED" });
          return;
        }

        // The round may have expired between ticks; never score after the buzzer.
        const expired = game.advanceIfExpired(room);
        if (expired.changed) {
          emitRoom(room);
          if (expired.wordOptions) emitWordOptions(room);
        }

        const player = room.players.find((p) => p.id === socket.id);
        const spectator = room.spectators.find((s) => s.id === socket.id);
        if (!player && !spectator) throw new GameError("NOT_IN_ROOM", "Join a room first");
        const text = maskProfanity(data.text);

        // Only the drawing phase turns text into a scored guess, and spectators
        // are never evaluated as guessers even if they type the secret word.
        if (player && room.status === "drawing") {
          const result = game.guess(room, socket.id, text);
          if (result.correct) {
            // Never echo the winning guess text: announce the player instead.
            const message = game.pushChat(room, {
              kind: "correct",
              playerId: player.id,
              name: player.name,
              text: `${player.name} guessed the word! +${result.score}`,
            });
            io.to(room.code).emit("chat:message", message);
            emitRoom(room);

            const guessers = room.players.filter((p) => p.id !== room.drawerId).length;
            if (room.status === "drawing" && room.guessed.size >= guessers) {
              game.nextTurn(room);
              emitRoom(room);
              emitWordOptions(room);
            }
            ack?.({ ok: true, correct: true, score: result.score });
            return;
          }
          if (result.close) {
            // Spoiler protection: a near miss is only shown to its author, never
            // appended to the public chat or counted as a scored guess.
            socket.emit("guess:close", { guess: text });
            ack?.({ ok: true, correct: false });
            return;
          }
        }

        // The drawer and already-correct players can still chat, but a line that
        // contains the secret word must never reach the room.
        if (game.containsSecret(room, text)) {
          ack?.({ ok: false, correct: false, error: "That would reveal the word!", code: "INVALID_GUESS" });
          return;
        }

        const message = game.pushChat(room, {
          kind: "chat",
          playerId: socket.id,
          name: (player ?? spectator)!.name,
          text,
        });
        io.to(room.code).emit("chat:message", message);
        ack?.({ ok: true, correct: false });
      } catch (error) {
        fail(ack, error);
      }
    });

    socket.on("disconnect", () => {
      identities.delete(socket.id);
      const boundToken = socket.data.seatToken as string | undefined;
      if (boundToken && seatSockets.get(boundToken) === socket.id) {
        seatSockets.delete(boundToken);
      }
      if (infra) {
        void infra.matchmaker
          .cancel(socket.id, instanceId)
          .catch((error: unknown) => logger.warn({ err: error }, "failed to cancel matchmaking"));
        void infra.presence
          .disconnected(socket.id)
          .catch((error: unknown) => logger.warn({ err: error }, "failed to clear presence"));
      } else {
        matchmaker.cancel(socket.id);
      }

      const room = roomOf();
      if (!room) return;
      const player = room.players.find((p) => p.id === socket.id);
      const spectator = room.spectators.find((s) => s.id === socket.id);
      const seat = player ?? spectator;
      if (!seat) return;

      if (seatSockets.get(seat.sessionToken) === socket.id) {
        seatSockets.delete(seat.sessionToken);
      }

      // Every seat (lobby included) is held for the grace window. A Wi-Fi blip
      // or a backgrounded app must not remove a player or end their turn.
      game.markDisconnected(socket.id);
      emitRoom(room);
      scheduleSeatRemoval(room.code, seat.sessionToken);
    });
  });

  let ticking = false;
  const timer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    void (async () => {
      try {
        const now = Date.now();
        for (const room of [...game.rooms.values()]) {
          // A per-room lock prevents a recovered duplicate from advancing a
          // room's timers twice. Never block the loop on Redis failures.
          if (infra) {
            let locked = false;
            try {
              locked = await infra.roomStore.acquireTickLock(room.code);
            } catch (error) {
              logger.warn({ err: error, roomCode: room.code }, "tick lock unavailable");
              locked = true;
            }
            if (!locked) continue;
          }
          const tick = game.advanceIfExpired(room, now);
          if (tick.changed) {
            emitRoom(room);
            if (tick.wordOptions) emitWordOptions(room);
            continue;
          }
          // Hint letters derive from the turn clock, so reveal them here and
          // broadcast only when the visible mask actually changes.
          if (game.refreshHints(room, now)) emitRoom(room);
        }

        // Rooms only exist while a seat or a watcher exists. Grace timers delete
        // the seats; this sweep releases the room and its maps immediately after.
        for (const room of [...game.rooms.values()]) {
          if (room.players.length > 0 || room.spectators.length > 0) continue;
          game.forgetRoom(room);
          if (infra) {
            void infra.roomStore
              .remove(room.code)
              .catch((error: unknown) =>
                logger.warn({ err: error, roomCode: room.code }, "failed to drop empty room"),
              );
          }
        }

        if (infra) {
          const expired = await infra.matchmaker.expire(instanceId, now);
          for (const entry of expired) {
            io.to(entry.socketId).emit("mm:timeout", {
              error: "No match was found. Try Quick Play again or create a private room.",
            });
          }
          if ((await infra.matchmaker.size(instanceId)) >= infra.matchmaker.config.minPlayers) {
            void tryMatch();
          }
          return;
        }

        for (const entry of matchmaker.expire(now)) {
          io.to(entry.socketId).emit("mm:timeout", {
            error: "No match was found. Try Quick Play again or create a private room.",
          });
        }
        if (matchmaker.size >= matchmaker.config.minPlayers) void tryMatch();
      } catch (error) {
        logger.warn({ err: error }, "game timer tick failed");
      } finally {
        ticking = false;
      }
    })();
  }, 500);
  timer.unref?.();

  const heartbeat = setInterval(() => {
    if (!infra) return;
    void infra.presence
      .heartbeat()
      .catch((error: unknown) => logger.warn({ err: error }, "presence heartbeat failed"));
  }, 30_000);
  heartbeat.unref?.();

  /** Restores rooms whose snapshots belong to this instance id after a restart. */
  const recoverRooms = async () => {
    if (!infra) return;
    const rooms = await infra.roomStore.listOwned();
    if (rooms.length) logger.info({ count: rooms.length }, "recovering rooms from Redis");
    for (const room of rooms) {
      if (game.rooms.has(room.code)) continue;
      // Lobbies and rooms with no players have no round worth preserving.
      if (room.status === "lobby" || room.players.length === 0) {
        await infra.roomStore.remove(room.code);
        continue;
      }
      for (const player of room.players) player.connected = false;
      for (const spectator of room.spectators) spectator.connected = false;
      game.restoreRoom(room);
      for (const seat of [...room.players, ...room.spectators]) {
        scheduleSeatRemoval(room.code, seat.sessionToken);
      }
      // A crash between gameplay ending and the match write must not lose the
      // result: retry finalization now (the unique key makes it idempotent).
      if (room.status === "ended") finalizeMatch(room);
      logger.info({ roomCode: room.code, status: room.status }, "room recovered");
    }
  };

  const ready = (async () => {
    if (!infra) return;
    await loadModerationSettings();
    try {
      await recoverRooms();
    } catch (error) {
      logger.error({ err: error }, "room recovery failed");
    }
  })();

  const close = async () => {
    clearInterval(timer);
    clearInterval(heartbeat);
    for (const pending of disconnectTimers.values()) clearTimeout(pending);
    disconnectTimers.clear();
    seatSockets.clear();
    for (const pending of saveTimers.values()) clearTimeout(pending);
    saveTimers.clear();
    await io.close();
    if (httpServer.listening) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
    if (infra) {
      // Let idempotent match writes finish, then take a final consistent
      // snapshot so a graceful deploy loses no completed state.
      await Promise.allSettled([...pendingWrites]);
      try {
        await infra.roomStore.saveMany(game.rooms.values());
      } catch (error) {
        logger.error({ err: error }, "failed to flush room snapshots on shutdown");
      }
    }
  };

  return { app, httpServer, io, game, profiles, matchmaker, reports, ready, close };
}
