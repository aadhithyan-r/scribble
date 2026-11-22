import { loadConfig } from "./config.js";
import { closePool, createPool, migrate } from "./db.js";

/**
 * Applies pending migrations and exits. Run this before starting new server
 * instances in a deployment; it is safe to run concurrently thanks to the
 * Postgres advisory lock in the migration runner.
 */
const config = loadConfig();
const pool = createPool(config.databaseUrl);
try {
  const applied = await migrate(pool);
  console.log(applied.length ? `Applied ${applied.length} migration(s): ${applied.join(", ")}` : "Database is up to date");
} finally {
  await closePool(pool);
}
