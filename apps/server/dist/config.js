import { z } from "zod";
const envSchema = z.object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    REDIS_URL: z.string().min(1, "REDIS_URL is required"),
    /** Stable per-instance identifier. Room snapshots and queues are instance-affine. */
    INSTANCE_ID: z.string().min(1).max(64).default("server-1"),
    CORS_ORIGINS: z.string().default(""),
    ADMIN_TOKEN: z.preprocess((value) => (value === "" ? undefined : value), z.string().min(24, "ADMIN_TOKEN must be at least 24 characters").optional()),
    AUTH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
    MM_MIN: z.coerce.number().int().min(2).max(8).default(2),
    MM_MAX: z.coerce.number().int().min(2).max(8).default(8),
    MM_WAIT_MS: z.coerce.number().int().min(1000).max(600_000).default(45_000),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
    TRUST_PROXY: z.string().optional(),
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(15_000),
});
/** Validates and normalizes environment configuration. Throws with readable messages. */
export function loadConfig(env = process.env) {
    const parsed = envSchema.safeParse(env);
    if (!parsed.success) {
        const details = parsed.error.issues
            .map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`)
            .join("; ");
        throw new Error(`Invalid server configuration: ${details}`);
    }
    const value = parsed.data;
    if (value.MM_MIN > value.MM_MAX) {
        throw new Error("Invalid server configuration: MM_MIN must be <= MM_MAX");
    }
    const corsOrigins = value.CORS_ORIGINS.split(",")
        .map((origin) => origin.trim())
        .filter(Boolean);
    if (value.NODE_ENV === "production" && corsOrigins.length === 0) {
        // Native clients send no Origin header, so an empty allowlist is safe for them,
        // but browser clients would be denied. Warn rather than weakening CORS.
        console.warn("[config] CORS_ORIGINS is empty; browser clients will be rejected in production");
    }
    return {
        nodeEnv: value.NODE_ENV,
        isProduction: value.NODE_ENV === "production",
        port: value.PORT,
        databaseUrl: value.DATABASE_URL,
        redisUrl: value.REDIS_URL,
        instanceId: value.INSTANCE_ID,
        corsOrigins,
        ...(value.ADMIN_TOKEN ? { adminToken: value.ADMIN_TOKEN } : {}),
        authTokenTtlMs: value.AUTH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
        matchmaking: {
            minPlayers: value.MM_MIN,
            maxPlayers: value.MM_MAX,
            waitMs: value.MM_WAIT_MS,
        },
        logLevel: value.LOG_LEVEL,
        trustProxy: value.TRUST_PROXY === "1" || value.TRUST_PROXY === "true",
        shutdownTimeoutMs: value.SHUTDOWN_TIMEOUT_MS,
    };
}
