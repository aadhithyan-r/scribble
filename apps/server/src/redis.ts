import { createClient } from "redis";
import type { Logger } from "./logger.js";

export type RedisClient = ReturnType<typeof createClient>;

export type RedisClients = {
  command: RedisClient;
  publisher: RedisClient;
  subscriber: RedisClient;
};

const connectOptions = {
  socket: {
    connectTimeout: 5_000,
    reconnectStrategy: (retries: number) => Math.min(250 + retries * 250, 3_000),
  },
};

/**
 * Three clients are required: a command client plus dedicated publisher and
 * subscriber connections for the Socket.IO adapter. All reconnect forever with
 * capped backoff; callers check readiness instead of assuming connectivity.
 */
export async function connectRedis(url: string, logger?: Logger): Promise<RedisClients> {
  const command = createClient({ url, ...connectOptions }) as RedisClient;
  const publisher = command.duplicate() as RedisClient;
  const subscriber = command.duplicate() as RedisClient;

  for (const [role, client] of [
    ["command", command],
    ["publisher", publisher],
    ["subscriber", subscriber],
  ] as const) {
    client.on("error", (error: Error) => logger?.warn({ role, error: error.message }, "redis error"));
    client.on("reconnecting", () => logger?.warn({ role }, "redis reconnecting"));
    client.on("ready", () => logger?.info({ role }, "redis ready"));
  }

  await command.connect();
  await publisher.connect();
  await subscriber.connect();
  return { command, publisher, subscriber };
}

export async function pingRedis(client: RedisClient): Promise<boolean> {
  try {
    return (await client.ping()) === "PONG";
  } catch {
    return false;
  }
}

export async function closeRedis(clients: RedisClients): Promise<void> {
  await Promise.allSettled([
    clients.command.quit(),
    clients.publisher.quit(),
    clients.subscriber.quit(),
  ]);
}
