import { AuthService } from "./auth.js";
import { loadConfig } from "./config.js";
import { closePool, createPool, migrate, pingDatabase } from "./db.js";
import { createLogger } from "./logger.js";
import { PresenceStore } from "./presence.js";
import { DistributedRateLimiter } from "./rate-limit.js";
import { RedisMatchmaker } from "./redis-matchmaking.js";
import { closeRedis, connectRedis, pingRedis } from "./redis.js";
import { BanRepository, MatchRepository, PlayerRepository, ReportRepository, SettingsRepository, WordListRepository, } from "./repositories.js";
import { RoomStore } from "./room-store.js";
import { createGameServer } from "./server.js";
/**
 * Production bootstrap: validate configuration, apply migrations, connect
 * Postgres/Redis, recover owned rooms, then start accepting traffic. Readiness
 * is only reported once the dependencies and recovered state are in place.
 */
async function main() {
    const config = loadConfig();
    const logger = createLogger(config.logLevel);
    const pool = createPool(config.databaseUrl);
    if (!(await pingDatabase(pool))) {
        await closePool(pool);
        throw new Error("PostgreSQL is not reachable");
    }
    const applied = await migrate(pool, logger);
    if (applied.length)
        logger.info({ migrations: applied }, "database migrations applied");
    const redis = await connectRedis(config.redisUrl, logger);
    if (!(await pingRedis(redis.command))) {
        await closeRedis(redis);
        await closePool(pool);
        throw new Error("Redis is not reachable");
    }
    const matches = new MatchRepository(pool);
    const infra = {
        instanceId: config.instanceId,
        pool,
        auth: new AuthService(pool, config.authTokenTtlMs),
        players: new PlayerRepository(pool, matches),
        matches,
        wordLists: new WordListRepository(pool),
        reportRepo: new ReportRepository(pool),
        bans: new BanRepository(pool),
        settings: new SettingsRepository(pool),
        redis,
        roomStore: new RoomStore(redis.command, config.instanceId),
        presence: new PresenceStore(redis.command, config.instanceId),
        limiter: new DistributedRateLimiter(redis.command, logger),
        matchmaker: new RedisMatchmaker(redis.command, config.matchmaking),
    };
    const server = createGameServer({
        infra,
        logger,
        matchmaking: config.matchmaking,
        corsOrigins: config.corsOrigins,
        ...(config.adminToken ? { adminToken: config.adminToken } : {}),
        trustProxy: config.trustProxy,
    });
    await server.ready;
    await new Promise((resolve, reject) => {
        const onError = (error) => reject(error);
        server.httpServer.once("error", onError);
        server.httpServer.listen(config.port, () => {
            server.httpServer.off("error", onError);
            resolve();
        });
    });
    logger.info({
        port: config.port,
        instanceId: config.instanceId,
        nodeEnv: config.nodeEnv,
        recoveredRooms: server.game.rooms.size,
    }, "Skrible server listening");
    let shuttingDown = false;
    const shutdown = async (signal) => {
        if (shuttingDown)
            return;
        shuttingDown = true;
        logger.info({ signal }, "shutdown requested");
        const force = setTimeout(() => {
            logger.fatal("shutdown timed out; exiting");
            process.exit(1);
        }, config.shutdownTimeoutMs);
        force.unref();
        try {
            await server.close();
            await closeRedis(redis);
            await closePool(pool);
            clearTimeout(force);
            logger.info("shutdown complete");
            process.exit(0);
        }
        catch (error) {
            logger.error({ err: error }, "shutdown failed");
            process.exit(1);
        }
    };
    for (const signal of ["SIGTERM", "SIGINT"]) {
        process.on(signal, () => {
            void shutdown(signal);
        });
    }
    process.on("unhandledRejection", (reason) => {
        logger.error({ err: reason }, "unhandled promise rejection");
    });
    process.on("uncaughtException", (error) => {
        logger.fatal({ err: error }, "uncaught exception; exiting");
        process.exit(1);
    });
}
main().catch((error) => {
    // The logger may not exist yet if configuration failed; keep the message
    // readable and avoid dumping environment values.
    console.error("[skrible] failed to start:", error instanceof Error ? error.message : error);
    process.exit(1);
});
