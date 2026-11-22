import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
const MIGRATION_LOCK_ID = 7_263_521;
export function createPool(connectionString, overrides = {}) {
    const pool = new Pool({
        connectionString,
        max: 10,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 5_000,
        allowExitOnIdle: false,
        ...overrides,
    });
    // An idle client error must never crash the process; pg pools recover lazily.
    pool.on("error", (error) => {
        console.error("[db] idle client error", error.message);
    });
    return pool;
}
export const closePool = (pool) => pool.end();
export async function withTransaction(pool, work) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const result = await work(client);
        await client.query("COMMIT");
        return result;
    }
    catch (error) {
        try {
            await client.query("ROLLBACK");
        }
        catch {
            // Connection already gone; the server rolls back implicitly.
        }
        throw error;
    }
    finally {
        client.release();
    }
}
export async function pingDatabase(pool) {
    try {
        await pool.query("SELECT 1");
        return true;
    }
    catch {
        return false;
    }
}
async function migrationFiles() {
    const dir = fileURLToPath(new URL("../migrations/", import.meta.url));
    const names = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
    return Promise.all(names.map(async (name) => ({ name, sql: await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8") })));
}
/**
 * Applies pending SQL migrations in order under a Postgres advisory lock.
 * Safe to run from several instances at once and from CI before deployment.
 */
export async function migrate(pool, logger) {
    const files = await migrationFiles();
    const client = await pool.connect();
    const applied = [];
    try {
        await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
        await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
        const done = await client.query("SELECT name FROM schema_migrations");
        const already = new Set(done.rows.map((row) => row.name));
        for (const file of files) {
            if (already.has(file.name))
                continue;
            await client.query("BEGIN");
            try {
                await client.query(file.sql);
                await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file.name]);
                await client.query("COMMIT");
                applied.push(file.name);
                logger?.info({ migration: file.name }, "applied database migration");
            }
            catch (error) {
                await client.query("ROLLBACK");
                throw error;
            }
        }
    }
    finally {
        await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]).catch(() => undefined);
        client.release();
    }
    return applied;
}
