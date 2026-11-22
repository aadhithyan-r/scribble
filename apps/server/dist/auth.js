import { createHash, randomBytes, randomUUID } from "node:crypto";
import { resolveAvatar, validateName } from "./validation.js";
import { withTransaction } from "./db.js";
/** Opaque bearer tokens: 32 random bytes, base64url. Never stored in plaintext. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ROTATION_GRACE_MS = 5 * 60 * 1000;
export const hashToken = (token) => createHash("sha256").update(token).digest("hex");
const issueToken = () => randomBytes(32).toString("base64url");
const toPlayer = (row) => ({
    id: row.id,
    name: row.display_name,
    avatar: row.avatar,
    createdAt: row.created_at.getTime(),
});
/**
 * Persistent guest accounts. There are no passwords: a guest is created once,
 * then authenticated by an opaque bearer token whose SHA-256 hash is the only
 * thing Postgres stores. Refresh rotates the token with a short grace window so
 * a client that crashes between receiving and persisting the new token is not
 * locked out. Revocation, logout and account deletion all invalidate sessions.
 */
export class AuthService {
    pool;
    tokenTtlMs;
    constructor(pool, tokenTtlMs) {
        this.pool = pool;
        this.tokenTtlMs = tokenTtlMs;
    }
    async createGuest(rawName, rawAvatar) {
        const name = validateName(typeof rawName === "string" ? rawName : "");
        const avatar = resolveAvatar(rawAvatar);
        const playerId = randomUUID();
        const token = issueToken();
        const expiresAt = new Date(Date.now() + this.tokenTtlMs);
        const player = await withTransaction(this.pool, async (client) => {
            const inserted = await client.query(`INSERT INTO players (id, display_name, avatar) VALUES ($1, $2, $3)
         RETURNING id, display_name, avatar, created_at`, [playerId, name, avatar]);
            await client.query(`INSERT INTO player_stats (player_id) VALUES ($1)`, [playerId]);
            await client.query(`INSERT INTO auth_sessions (id, player_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)`, [randomUUID(), playerId, hashToken(token), expiresAt]);
            return toPlayer(inserted.rows[0]);
        });
        return { token, player, expiresAt: expiresAt.getTime() };
    }
    /** Validates a token without modifying it. Returns null for invalid/expired/revoked. */
    async authenticate(token) {
        if (!TOKEN_PATTERN.test(token))
            return null;
        const result = await this.pool.query(`SELECT p.id, p.display_name, p.avatar, p.created_at
         FROM auth_sessions s
         JOIN players p ON p.id = s.player_id
        WHERE s.revoked_at IS NULL
          AND s.expires_at > now()
          AND p.deleted_at IS NULL
          AND (s.token_hash = $1 OR (s.previous_token_hash = $1 AND s.previous_valid_until > now()))
        LIMIT 1`, [hashToken(token)]);
        const row = result.rows[0];
        if (!row)
            return null;
        // Best-effort activity signal; failures must not reject a valid session.
        void this.pool
            .query(`UPDATE auth_sessions SET last_used_at = now() WHERE token_hash = $1`, [hashToken(token)])
            .catch(() => undefined);
        return toPlayer(row);
    }
    /**
     * Issues a fresh token for the same account and moves the old hash into a
     * short-lived grace slot. Rotation invalidates the previous token after the
     * grace window or after another rotation, whichever comes first.
     */
    async refresh(token) {
        if (!TOKEN_PATTERN.test(token))
            return null;
        const newToken = issueToken();
        return withTransaction(this.pool, async (client) => {
            const found = await client.query(`SELECT s.id AS session_id, s.player_id
           FROM auth_sessions s
           JOIN players p ON p.id = s.player_id
          WHERE s.revoked_at IS NULL AND s.expires_at > now() AND p.deleted_at IS NULL
            AND (s.token_hash = $1 OR (s.previous_token_hash = $1 AND s.previous_valid_until > now()))
          FOR UPDATE OF s`, [hashToken(token)]);
            const row = found.rows[0];
            if (!row)
                return null;
            const expiresAt = new Date(Date.now() + this.tokenTtlMs);
            await client.query(`UPDATE auth_sessions
            SET previous_token_hash = token_hash,
                previous_valid_until = now() + ($2 || ' milliseconds')::interval,
                token_hash = $3,
                last_used_at = now(),
                expires_at = $4
          WHERE id = $1`, [row.session_id, String(ROTATION_GRACE_MS), hashToken(newToken), expiresAt]);
            const player = await client.query(`SELECT id, display_name, avatar, created_at FROM players WHERE id = $1`, [row.player_id]);
            if (!player.rows[0])
                return null;
            return { token: newToken, player: toPlayer(player.rows[0]), expiresAt: expiresAt.getTime() };
        });
    }
    async logout(token) {
        if (!TOKEN_PATTERN.test(token))
            return;
        await this.pool.query(`UPDATE auth_sessions SET revoked_at = now()
        WHERE revoked_at IS NULL AND (token_hash = $1 OR previous_token_hash = $1)`, [hashToken(token)]);
    }
    /**
     * Revokes every session, removes personal data and anonymises historical
     * match/report rows. The player row is kept (soft-deleted) only because match
     * participant foreign keys must remain valid.
     */
    async deleteAccount(playerId) {
        await withTransaction(this.pool, async (client) => {
            await client.query(`UPDATE auth_sessions SET revoked_at = now() WHERE player_id = $1`, [playerId]);
            await client.query(`DELETE FROM word_lists WHERE player_id = $1`, [playerId]);
            await client.query(`DELETE FROM player_stats WHERE player_id = $1`, [playerId]);
            await client.query(`DELETE FROM bans WHERE player_id = $1`, [playerId]);
            await client.query(`UPDATE match_players SET display_name = 'Deleted player', avatar = 'ghost' WHERE player_id = $1`, [playerId]);
            await client.query(`UPDATE reports SET reporter_name = 'Deleted player' WHERE reporter_id = $1`, [
                playerId,
            ]);
            await client.query(`UPDATE reports SET target_name = 'Deleted player' WHERE target_id = $1`, [
                playerId,
            ]);
            await client.query(`UPDATE players
            SET display_name = 'Deleted player', avatar = 'ghost', deleted_at = now(), updated_at = now()
          WHERE id = $1 AND deleted_at IS NULL`, [playerId]);
        });
    }
    async getPlayer(playerId) {
        const result = await this.pool.query(`SELECT id, display_name, avatar, created_at FROM players WHERE id = $1 AND deleted_at IS NULL`, [playerId]);
        return result.rows[0] ? toPlayer(result.rows[0]) : null;
    }
    async updatePlayer(playerId, patch) {
        const name = patch.name !== undefined ? validateName(String(patch.name)) : undefined;
        const avatar = patch.avatar !== undefined ? resolveAvatar(patch.avatar) : undefined;
        if (name === undefined && avatar === undefined)
            return this.getPlayer(playerId);
        const result = await this.pool.query(`UPDATE players
          SET display_name = COALESCE($2, display_name),
              avatar = COALESCE($3, avatar),
              updated_at = now()
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING id, display_name, avatar, created_at`, [playerId, name ?? null, avatar ?? null]);
        return result.rows[0] ? toPlayer(result.rows[0]) : null;
    }
}
