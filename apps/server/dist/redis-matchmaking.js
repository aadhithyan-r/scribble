import { DEFAULT_MATCHMAKING, validateMatchmakingConfig, } from "./matchmaking.js";
import { ValidationError } from "./validation.js";
/**
 * Queue is deliberately per instance: a room lives on the instance that owns
 * its sockets, so pairing across instances would break room affinity. Redis
 * provides durability, atomic duplicate prevention and TTL cleanup; the load
 * balancer must keep a player on the same instance while they queue.
 */
const queueKey = (instanceId) => `mm:queue:${instanceId}`;
const profileKey = (profileId) => `mm:profile:${profileId}`;
const socketKey = (socketId) => `mm:socket:${socketId}`;
const ENQUEUE_LUA = `
if redis.call('EXISTS', KEYS[2]) == 1 or redis.call('EXISTS', KEYS[3]) == 1 then
  return -1
end
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1])
redis.call('SET', KEYS[2], ARGV[1], 'PX', ARGV[3])
redis.call('SET', KEYS[3], ARGV[1], 'PX', ARGV[3])
return redis.call('ZCARD', KEYS[1])
`;
const TAKE_LUA = `
local count = redis.call('ZCARD', KEYS[1])
if count < tonumber(ARGV[1]) then
  return {}
end
local members = redis.call('ZRANGE', KEYS[1], 0, tonumber(ARGV[2]) - 1)
for _, member in ipairs(members) do
  redis.call('ZREM', KEYS[1], member)
  local ok, entry = pcall(cjson.decode, member)
  if ok and entry then
    redis.call('DEL', 'mm:profile:' .. entry.profileId, 'mm:socket:' .. entry.socketId)
  end
end
return members
`;
const CANCEL_LUA = `
local member = redis.call('GET', KEYS[2])
if not member then
  return 0
end
redis.call('ZREM', KEYS[1], member)
redis.call('DEL', KEYS[2])
local ok, entry = pcall(cjson.decode, member)
if ok and entry then
  local key = 'mm:profile:' .. entry.profileId
  if redis.call('GET', key) == member then
    redis.call('DEL', key)
  end
end
return 1
`;
const EXPIRE_LUA = `
local members = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
for _, member in ipairs(members) do
  redis.call('ZREM', KEYS[1], member)
  local ok, entry = pcall(cjson.decode, member)
  if ok and entry then
    redis.call('DEL', 'mm:profile:' .. entry.profileId, 'mm:socket:' .. entry.socketId)
  end
end
return members
`;
const parseEntries = (raw) => {
    if (!Array.isArray(raw))
        return [];
    const entries = [];
    for (const value of raw) {
        if (typeof value !== "string")
            continue;
        try {
            const parsed = JSON.parse(value);
            if (parsed.socketId && parsed.profileId && parsed.name && parsed.avatar)
                entries.push(parsed);
        }
        catch {
            // A corrupt member is removed by the Lua scripts; never crash the queue.
        }
    }
    return entries;
};
export class RedisMatchmaker {
    redis;
    config;
    constructor(redis, config = {}) {
        this.redis = redis;
        this.config = { ...DEFAULT_MATCHMAKING, ...config };
        validateMatchmakingConfig(this.config);
    }
    async enqueue(entry, instanceId) {
        const member = JSON.stringify({ ...entry, instanceId });
        const result = Number(await this.redis.eval(ENQUEUE_LUA, {
            keys: [queueKey(instanceId), profileKey(entry.profileId), socketKey(entry.socketId)],
            arguments: [member, String(entry.joinedAt), String(this.config.waitMs * 3)],
        }));
        if (result === -1)
            throw new ValidationError("ALREADY_QUEUED", "You are already in the queue");
        return { position: result, size: result };
    }
    async cancel(socketId, instanceId) {
        const result = Number(await this.redis.eval(CANCEL_LUA, {
            keys: [queueKey(instanceId), socketKey(socketId)],
            arguments: [],
        }));
        return result === 1;
    }
    async takeMatch(instanceId) {
        const raw = await this.redis.eval(TAKE_LUA, {
            keys: [queueKey(instanceId)],
            arguments: [String(this.config.minPlayers), String(this.config.maxPlayers)],
        });
        const entries = parseEntries(raw);
        return entries.length >= this.config.minPlayers ? entries : null;
    }
    async expire(instanceId, now = Date.now()) {
        const raw = await this.redis.eval(EXPIRE_LUA, {
            keys: [queueKey(instanceId)],
            arguments: [String(now - this.config.waitMs)],
        });
        return parseEntries(raw);
    }
    /** Cleans queues left behind by instances that died without draining them. */
    async sweepExpired(now = Date.now()) {
        let cursor = "0";
        let removed = 0;
        do {
            const page = await this.redis.scan(cursor, { MATCH: "mm:queue:*", COUNT: 100 });
            cursor = page.cursor;
            for (const key of page.keys) {
                const raw = await this.redis.eval(EXPIRE_LUA, {
                    keys: [key],
                    arguments: [String(now - this.config.waitMs)],
                });
                removed += parseEntries(raw).length;
            }
        } while (cursor !== "0");
        return removed;
    }
    async size(instanceId) {
        return this.redis.zCard(queueKey(instanceId));
    }
}
