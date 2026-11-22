import type { RedisClient } from "./redis.js";

const PRESENCE_TTL_SECONDS = 90;
const ROOM_SESSION_TTL_SECONDS = 120;

export type PresenceRecord = {
  playerId: string;
  instanceId: string;
  roomCode?: string;
  connectedAt: number;
};

/**
 * Connection state shared across instances. Presence keys expire unless the
 * owning server heartbeats them, so a crashed instance's ghosts disappear
 * without an explicit cleanup job. Room resume tokens are also mirrored here so
 * a reconnect can be resolved without scanning rooms.
 */
export class PresenceStore {
  constructor(
    private readonly redis: RedisClient,
    private readonly instanceId: string,
  ) {}

  async connected(socketId: string, playerId: string, roomCode?: string): Promise<void> {
    const record: PresenceRecord = {
      playerId,
      instanceId: this.instanceId,
      ...(roomCode ? { roomCode } : {}),
      connectedAt: Date.now(),
    };
    await this.redis
      .multi()
      .set(`presence:${socketId}`, JSON.stringify(record), { EX: PRESENCE_TTL_SECONDS })
      .sAdd(`presence:instance:${this.instanceId}`, socketId)
      .exec();
  }

  async setRoom(socketId: string, playerId: string, roomCode: string): Promise<void> {
    await this.redis.set(
      `presence:${socketId}`,
      JSON.stringify({ playerId, instanceId: this.instanceId, roomCode, connectedAt: Date.now() }),
      { EX: PRESENCE_TTL_SECONDS },
    );
  }

  /** Refreshes TTLs for every socket owned by this instance. */
  async heartbeat(): Promise<void> {
    const members = await this.redis.sMembers(`presence:instance:${this.instanceId}`);
    if (!members.length) return;
    const pipeline = this.redis.multi();
    for (const socketId of members) {
      const exists = await this.redis.exists(`presence:${socketId}`);
      if (exists) {
        pipeline.expire(`presence:${socketId}`, PRESENCE_TTL_SECONDS);
      } else {
        pipeline.sRem(`presence:instance:${this.instanceId}`, socketId);
      }
    }
    await pipeline.exec();
  }

  async roomCodeFor(socketId: string): Promise<string | null> {
    const raw = await this.redis.get(`presence:${socketId}`);
    if (!raw) return null;
    try {
      const record = JSON.parse(raw) as PresenceRecord;
      return record.roomCode ?? null;
    } catch {
      return null;
    }
  }

  async disconnected(socketId: string): Promise<void> {
    // Room session tokens are intentionally kept: they are what lets a
    // reconnecting client resume its seat. They expire on their own.
    await this.redis
      .multi()
      .del(`presence:${socketId}`)
      .sRem(`presence:instance:${this.instanceId}`, socketId)
      .exec();
  }

  async countOnline(): Promise<number> {
    const sockets = await this.redis.sMembers(`presence:instance:${this.instanceId}`);
    return sockets.length;
  }

  async rememberRoomSession(sessionToken: string, code: string, playerId: string): Promise<void> {
    await this.redis.set(
      `roomsession:${sessionToken}`,
      JSON.stringify({ code, playerId, instanceId: this.instanceId }),
      { EX: ROOM_SESSION_TTL_SECONDS },
    );
  }

  async resolveRoomSession(sessionToken: string): Promise<{ code: string; playerId: string } | null> {
    const raw = await this.redis.get(`roomsession:${sessionToken}`);
    if (!raw) return null;
    try {
      const value = JSON.parse(raw) as { code: string; playerId: string };
      return { code: value.code, playerId: value.playerId };
    } catch {
      return null;
    }
  }

  async forgetRoomSession(sessionToken: string): Promise<void> {
    await this.redis.del(`roomsession:${sessionToken}`);
  }
}
