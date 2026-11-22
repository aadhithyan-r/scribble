import type { Logger } from "./logger.js";
import type { RedisClient } from "./redis.js";

const FIXED_WINDOW_LUA = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return current
`;

type Bucket = { windowMs: number; max: number };

/** Local fallback keeps abuse protection working when Redis is unavailable. */
class LocalBucket {
  private hits = 0;
  private resetAt = 0;

  consume(limit: number, windowMs: number, now: number): boolean {
    if (now >= this.resetAt) {
      this.hits = 0;
      this.resetAt = now + windowMs;
    }
    this.hits += 1;
    return this.hits <= limit;
  }
}

/**
 * Fixed-window counters shared by every instance. Keys expire with their
 * window, so Redis storage stays bounded without a sweeper. On Redis failure we
 * fall back to a per-process bucket (and log) rather than dropping all
 * protection or rejecting every action.
 */
export class DistributedRateLimiter {
  private readonly local = new Map<string, LocalBucket>();

  constructor(
    private readonly redis: RedisClient,
    private readonly logger?: Logger,
  ) {}

  async allow(bucket: string, identity: string, bucketConfig: Bucket): Promise<boolean> {
    const key = `ratelimit:${bucket}:${identity}`;
    try {
      const count = Number(
        await this.redis.eval(FIXED_WINDOW_LUA, {
          keys: [key],
          arguments: [String(bucketConfig.windowMs)],
        }),
      );
      return count <= bucketConfig.max;
    } catch (error) {
      this.logger?.warn(
        { error: error instanceof Error ? error.message : String(error), bucket },
        "rate limiter fell back to local counter",
      );
      let local = this.local.get(key);
      if (!local) {
        local = new LocalBucket();
        this.local.set(key, local);
        if (this.local.size > 10_000) {
          const oldest = this.local.keys().next().value;
          if (oldest) this.local.delete(oldest);
        }
      }
      return local.consume(bucketConfig.max, bucketConfig.windowMs, Date.now());
    }
  }
}
