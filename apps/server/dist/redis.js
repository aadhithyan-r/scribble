import { createClient } from "redis";
const connectOptions = {
    socket: {
        connectTimeout: 5_000,
        reconnectStrategy: (retries) => Math.min(250 + retries * 250, 3_000),
    },
};
/**
 * Three clients are required: a command client plus dedicated publisher and
 * subscriber connections for the Socket.IO adapter. All reconnect forever with
 * capped backoff; callers check readiness instead of assuming connectivity.
 */
export async function connectRedis(url, logger) {
    const command = createClient({ url, ...connectOptions });
    const publisher = command.duplicate();
    const subscriber = command.duplicate();
    for (const [role, client] of [
        ["command", command],
        ["publisher", publisher],
        ["subscriber", subscriber],
    ]) {
        client.on("error", (error) => logger?.warn({ role, error: error.message }, "redis error"));
        client.on("reconnecting", () => logger?.warn({ role }, "redis reconnecting"));
        client.on("ready", () => logger?.info({ role }, "redis ready"));
    }
    await command.connect();
    await publisher.connect();
    await subscriber.connect();
    return { command, publisher, subscriber };
}
export async function pingRedis(client) {
    try {
        return (await client.ping()) === "PONG";
    }
    catch {
        return false;
    }
}
export async function closeRedis(clients) {
    await Promise.allSettled([
        clients.command.quit(),
        clients.publisher.quit(),
        clients.subscriber.quit(),
    ]);
}
