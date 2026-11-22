/** Six hours is longer than any legitimate match and bounds Redis growth. */
const ROOM_TTL_SECONDS = 6 * 60 * 60;
const SNAPSHOT_VERSION = 1;
const roomKey = (code) => `room:${code}:snapshot`;
const tickKey = (code) => `room:${code}:tick`;
export const serializeRoom = (room, instanceId) => {
    const { guessed, bannedProfileIds, bannedSocketIds, mutedProfileIds, ...rest } = room;
    const snapshot = {
        version: SNAPSHOT_VERSION,
        instanceId,
        savedAt: Date.now(),
        room: {
            ...rest,
            guessed: [...guessed],
            bannedProfileIds: [...bannedProfileIds],
            bannedSocketIds: [...bannedSocketIds],
            mutedProfileIds: [...mutedProfileIds],
        },
    };
    return JSON.stringify(snapshot);
};
const isStringArray = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");
/**
 * Deserializes with shape checks so one corrupt Redis value cannot crash a
 * restarted server. Secrets (word choices/secret word) stay in Redis only and
 * are never logged.
 */
export const deserializeRoom = (raw) => {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return null;
    }
    if (!parsed ||
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
        !isStringArray(parsed.room.mutedProfileIds)) {
        return null;
    }
    const room = {
        ...parsed.room,
        guessed: new Set(parsed.room.guessed),
        bannedProfileIds: new Set(parsed.room.bannedProfileIds),
        bannedSocketIds: new Set(parsed.room.bannedSocketIds),
        mutedProfileIds: new Set(parsed.room.mutedProfileIds),
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
    redis;
    instanceId;
    constructor(redis, instanceId) {
        this.redis = redis;
        this.instanceId = instanceId;
    }
    async save(room) {
        await this.redis
            .multi()
            .set(roomKey(room.code), serializeRoom(room, this.instanceId), { EX: ROOM_TTL_SECONDS })
            .sAdd("rooms:index", room.code)
            .exec();
    }
    async saveMany(rooms) {
        const list = [...rooms];
        if (!list.length)
            return;
        const pipeline = this.redis.multi();
        for (const room of list) {
            pipeline.set(roomKey(room.code), serializeRoom(room, this.instanceId), { EX: ROOM_TTL_SECONDS });
            pipeline.sAdd("rooms:index", room.code);
        }
        await pipeline.exec();
    }
    async load(code) {
        const raw = await this.redis.get(roomKey(code));
        return raw ? deserializeRoom(raw) : null;
    }
    /** Rooms whose snapshots belong to this instance id (restart recovery). */
    async listOwned() {
        const codes = await this.redis.sMembers("rooms:index");
        if (!codes.length)
            return [];
        const pipeline = this.redis.multi();
        for (const code of codes)
            pipeline.get(roomKey(code));
        const results = await pipeline.exec();
        const rooms = [];
        for (let index = 0; index < codes.length; index += 1) {
            const raw = results[index];
            if (typeof raw !== "string") {
                await this.redis.sRem("rooms:index", codes[index]);
                continue;
            }
            const parsed = deserializeRoom(raw);
            if (!parsed)
                continue;
            if (parsed.instanceId === this.instanceId)
                rooms.push(parsed.room);
        }
        return rooms;
    }
    async remove(code) {
        await this.redis.multi().del(roomKey(code)).sRem("rooms:index", code).del(tickKey(code)).exec();
    }
    /** Prevents two recovered instances from advancing the same room's timers. */
    async acquireTickLock(code, ttlMs = 2_000) {
        const result = await this.redis.set(tickKey(code), this.instanceId, { NX: true, PX: ttlMs });
        return result === "OK";
    }
    async healthy() {
        try {
            return (await this.redis.ping()) === "PONG";
        }
        catch {
            return false;
        }
    }
}
