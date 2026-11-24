import type { RedisClient } from "./redis.js";
import type { DrawingGalleryItem, Reaction, Room, TurnSummary } from "./game.js";
import type { CustomWordsMode } from "./custom-words.js";
import { isCuratedCategoryId } from "./words.js";

/** Six hours is longer than any legitimate match and bounds Redis growth. */
const ROOM_TTL_SECONDS = 6 * 60 * 60;
const SNAPSHOT_VERSION = 1;

type StoredSnapshot = {
  version: number;
  instanceId: string;
  savedAt: number;
  room: Omit<
    Room,
    | "guessed"
    | "bannedProfileIds"
    | "bannedSocketIds"
    | "mutedProfileIds"
    | "usedWords"
    | "reactions"
  > & {
    guessed: string[];
    bannedProfileIds: string[];
    bannedSocketIds: string[];
    mutedProfileIds: string[];
    usedWords: string[];
    reactions: Record<string, Reaction>;
    customWords?: string[];
    customWordsMode?: CustomWordsMode;
    drawingGallery?: DrawingGalleryItem[];
    lastTurnSummary?: TurnSummary;
  };
};

const roomKey = (code: string) => `room:${code}:snapshot`;
const tickKey = (code: string) => `room:${code}:tick`;

export const serializeRoom = (room: Room, instanceId: string): string => {
  const {
    guessed,
    bannedProfileIds,
    bannedSocketIds,
    mutedProfileIds,
    usedWords,
    reactions,
    ...rest
  } = room;
  const snapshot: StoredSnapshot = {
    version: SNAPSHOT_VERSION,
    instanceId,
    savedAt: Date.now(),
    room: {
      ...rest,
      guessed: [...guessed],
      bannedProfileIds: [...bannedProfileIds],
      bannedSocketIds: [...bannedSocketIds],
      mutedProfileIds: [...mutedProfileIds],
      usedWords: [...usedWords],
      reactions: Object.fromEntries(reactions),
    },
  };
  return JSON.stringify(snapshot);
};

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/** Snapshots predate the free-form pack; missing entries simply start empty. */
const sanitizeSnapshotsWords = (value: unknown): string[] =>
  isStringArray(value) ? value.filter((word) => word.length >= 2 && word.length <= 28) : [];

/**
 * Deserializes with shape checks so one corrupt Redis value cannot crash a
 * restarted server. Secrets (word choices/secret word) stay in Redis only and
 * are never logged.
 */
export const deserializeRoom = (raw: string): { room: Room; instanceId: string; savedAt: number } | null => {
  let parsed: StoredSnapshot;
  try {
    parsed = JSON.parse(raw) as StoredSnapshot;
  } catch {
    return null;
  }
  if (
    !parsed ||
    parsed.version !== SNAPSHOT_VERSION ||
    typeof parsed.instanceId !== "string" ||
    !parsed.room ||
    typeof parsed.room.code !== "string" ||
    parsed.room.code.length !== 5 ||
    typeof parsed.room.roomId !== "string" ||
    !Array.isArray(parsed.room.players) ||
    !Array.isArray(parsed.room.spectators) ||
    !Array.isArray(parsed.room.chat) ||
    !Array.isArray(parsed.room.strokes) ||
    !isStringArray(parsed.room.guessed) ||
    !isStringArray(parsed.room.bannedProfileIds) ||
    !isStringArray(parsed.room.bannedSocketIds) ||
    !isStringArray(parsed.room.mutedProfileIds)
  ) {
    return null;
  }
  const wordMode = parsed.room.wordMode === "category" ? "category" : "random";
  const wordCategory =
    wordMode === "category"
      ? isCuratedCategoryId(parsed.room.wordCategory)
        ? parsed.room.wordCategory
        : "animals"
      : null;
  const reactions = new Map<string, Reaction>();
  if (parsed.room.reactions && typeof parsed.room.reactions === "object") {
    for (const [playerId, reaction] of Object.entries(parsed.room.reactions)) {
      if (reaction === "like" || reaction === "nope") reactions.set(playerId, reaction);
    }
  }
  const room: Room = {
    ...parsed.room,
    wordMode,
    wordCategory,
    customWords: sanitizeSnapshotsWords(parsed.room.customWords),
    customWordsMode:
      parsed.room.customWordsMode === "mix" || parsed.room.customWordsMode === "only"
        ? parsed.room.customWordsMode
        : "off",
    guessed: new Set(parsed.room.guessed),
    bannedProfileIds: new Set(parsed.room.bannedProfileIds),
    bannedSocketIds: new Set(parsed.room.bannedSocketIds),
    mutedProfileIds: new Set(parsed.room.mutedProfileIds),
    // Snapshots written before word modes existed deserialize to a fresh pass.
    usedWords: new Set(isStringArray(parsed.room.usedWords) ? parsed.room.usedWords : []),
    reactions,
    drawingGallery: Array.isArray(parsed.room.drawingGallery) ? parsed.room.drawingGallery : [],
    lastTurnSummary: parsed.room.lastTurnSummary,
  };
  return { room, instanceId: parsed.instanceId, savedAt: parsed.savedAt };
};

/**
 * Durable room snapshots. Socket connections cannot survive a restart, but
 * room state (scores, board, chat, phase, timers, private words) can: clients
 * reconnect with their room session token and resume where they left off.
 * Snapshots are also the hand-off point for explicitly moving a room.
 */
export class RoomStore {
  constructor(
    private readonly redis: RedisClient,
    private readonly instanceId: string,
  ) {}

  async save(room: Room): Promise<void> {
    await this.redis
      .multi()
      .set(roomKey(room.code), serializeRoom(room, this.instanceId), { EX: ROOM_TTL_SECONDS })
      .sAdd("rooms:index", room.code)
      .exec();
  }

  async saveMany(rooms: Iterable<Room>): Promise<void> {
    const list = [...rooms];
    if (!list.length) return;
    const pipeline = this.redis.multi();
    for (const room of list) {
      pipeline.set(roomKey(room.code), serializeRoom(room, this.instanceId), { EX: ROOM_TTL_SECONDS });
      pipeline.sAdd("rooms:index", room.code);
    }
    await pipeline.exec();
  }

  async load(code: string): Promise<{ room: Room; instanceId: string; savedAt: number } | null> {
    const raw = await this.redis.get(roomKey(code));
    return raw ? deserializeRoom(raw) : null;
  }

  /** Rooms whose snapshots belong to this instance id (restart recovery). */
  async listOwned(): Promise<Room[]> {
    const codes = await this.redis.sMembers("rooms:index");
    if (!codes.length) return [];
    const pipeline = this.redis.multi();
    for (const code of codes) pipeline.get(roomKey(code));
    const results = await pipeline.exec();
    const rooms: Room[] = [];
    for (let index = 0; index < codes.length; index += 1) {
      const raw = results[index];
      if (typeof raw !== "string") {
        await this.redis.sRem("rooms:index", codes[index]!);
        continue;
      }
      const parsed = deserializeRoom(raw);
      if (!parsed) continue;
      if (parsed.instanceId === this.instanceId) rooms.push(parsed.room);
    }
    return rooms;
  }

  async remove(code: string): Promise<void> {
    await this.redis.multi().del(roomKey(code)).sRem("rooms:index", code).del(tickKey(code)).exec();
  }

  /** Prevents two recovered instances from advancing the same room's timers. */
  async acquireTickLock(code: string, ttlMs = 2_000): Promise<boolean> {
    const result = await this.redis.set(tickKey(code), this.instanceId, { NX: true, PX: ttlMs });
    return result === "OK";
  }

  async healthy(): Promise<boolean> {
    try {
      return (await this.redis.ping()) === "PONG";
    } catch {
      return false;
    }
  }
}
