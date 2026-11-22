import type { AvatarId } from "./validation.js";
import { ValidationError } from "./validation.js";

export type QueueEntry = {
  socketId: string;
  profileId: string;
  name: string;
  avatar: AvatarId;
  joinedAt: number;
};

export type MatchmakingConfig = {
  minPlayers: number;
  maxPlayers: number;
  /** How long a lone player may wait before the queue is cancelled. */
  waitMs: number;
};

export const DEFAULT_MATCHMAKING: MatchmakingConfig = {
  minPlayers: 2,
  maxPlayers: 8,
  waitMs: 25_000,
};

export const validateMatchmakingConfig = (config: MatchmakingConfig) => {
  if (!Number.isInteger(config.minPlayers) || config.minPlayers < 2 || config.minPlayers > 8) {
    throw new ValidationError("INVALID_CONFIG", "Matchmaking minimum must be between 2 and 8");
  }
  if (!Number.isInteger(config.maxPlayers) || config.maxPlayers < config.minPlayers || config.maxPlayers > 8) {
    throw new ValidationError("INVALID_CONFIG", "Matchmaking maximum must be between the minimum and 8");
  }
  if (!Number.isInteger(config.waitMs) || config.waitMs < 1_000 || config.waitMs > 120_000) {
    throw new ValidationError("INVALID_CONFIG", "Matchmaking wait must be 1–120 seconds");
  }
};

/**
 * Pure queue mechanics. The socket layer owns room creation, so this class is
 * easy to unit test: enqueue, cancel, pair, expire. One socket and one profile
 * can only sit in the queue once.
 */
export class Matchmaker {
  readonly config: MatchmakingConfig;
  private queue: QueueEntry[] = [];

  constructor(config: Partial<MatchmakingConfig> = {}) {
    this.config = { ...DEFAULT_MATCHMAKING, ...config };
    validateMatchmakingConfig(this.config);
  }

  get size() {
    return this.queue.length;
  }

  snapshot(): QueueEntry[] {
    return this.queue.map((entry) => ({ ...entry }));
  }

  has(socketId: string) {
    return this.queue.some((entry) => entry.socketId === socketId);
  }

  enqueue(entry: QueueEntry): { position: number; size: number } {
    if (this.queue.some((item) => item.socketId === entry.socketId)) {
      throw new ValidationError("ALREADY_QUEUED", "You are already in the queue");
    }
    if (this.queue.some((item) => item.profileId === entry.profileId)) {
      throw new ValidationError("ALREADY_QUEUED", "This player is already queued");
    }
    this.queue.push({ ...entry });
    return { position: this.queue.length, size: this.queue.length };
  }

  cancel(socketId: string) {
    const before = this.queue.length;
    this.queue = this.queue.filter((entry) => entry.socketId !== socketId);
    return this.queue.length !== before;
  }

  /** Forms a room only once the minimum number of players is waiting. */
  takeMatch(): QueueEntry[] | null {
    if (this.queue.length < this.config.minPlayers) return null;
    return this.queue.splice(0, this.config.maxPlayers);
  }

  /** Removes players who waited too long so nobody is stuck forever. */
  expire(now = Date.now()): QueueEntry[] {
    const expired = this.queue.filter((entry) => now - entry.joinedAt >= this.config.waitMs);
    if (!expired.length) return [];
    const ids = new Set(expired.map((entry) => entry.socketId));
    this.queue = this.queue.filter((entry) => !ids.has(entry.socketId));
    return expired;
  }
}
