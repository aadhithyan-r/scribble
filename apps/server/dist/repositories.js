import { randomUUID } from "node:crypto";
import { withTransaction } from "./db.js";
import { accuracyOf, } from "./profiles.js";
const clampLimit = (limit, max = 100) => Math.max(1, Math.min(Math.trunc(limit), max));
const toMatchRecord = (match, players) => ({
    id: match.id,
    roomCode: match.room_code,
    at: match.ended_at.getTime(),
    rounds: match.rounds,
    players: players.map((player) => ({
        ...(player.player_id ? { profileId: player.player_id } : {}),
        name: player.display_name,
        avatar: player.avatar,
        score: player.score,
        rank: player.rank,
        won: player.won,
        guesses: player.guesses,
        correctGuesses: player.correct_guesses,
    })),
    winners: players.filter((player) => player.won).map((player) => player.player_id ?? player.display_name),
});
async function loadMatch(db, matchId) {
    const match = await db.query(`SELECT id, room_code, rounds, ended_at FROM matches WHERE id = $1`, [matchId]);
    const row = match.rows[0];
    if (!row)
        return null;
    const players = await db.query(`SELECT player_id, display_name, avatar, score, rank, guesses, correct_guesses, won
       FROM match_players WHERE match_id = $1 ORDER BY rank ASC, display_name ASC`, [matchId]);
    return toMatchRecord(row, players.rows);
}
/**
 * Transaction-safe match finalization. `finalization_key` is unique per room
 * instance, so a retried finalize (client reconnect, server retry, duplicate
 * timer) returns the already-recorded match without double-counting stats.
 */
export class MatchRepository {
    pool;
    constructor(pool) {
        this.pool = pool;
    }
    async record(input, finalizationKey) {
        const sorted = [...input.players].sort((a, b) => b.score - a.score);
        const results = sorted.map((player) => ({
            ...player,
            rank: 1 + sorted.filter((other) => other.score > player.score).length,
        }));
        return withTransaction(this.pool, async (client) => {
            const inserted = await client.query(`INSERT INTO matches (id, finalization_key, room_code, rounds)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (finalization_key) DO NOTHING
         RETURNING id`, [randomUUID(), finalizationKey, input.roomCode, input.rounds]);
            if (!inserted.rows[0]) {
                const existing = await client.query(`SELECT id FROM matches WHERE finalization_key = $1`, [finalizationKey]);
                const record = existing.rows[0] ? await loadMatch(client, existing.rows[0].id) : null;
                if (!record)
                    throw new Error("Match finalization conflict without a stored match");
                return record;
            }
            const matchId = inserted.rows[0].id;
            for (const player of results) {
                await client.query(`INSERT INTO match_players
             (match_id, player_id, display_name, avatar, score, rank, guesses, correct_guesses, won)
           VALUES ($1, (SELECT id FROM players WHERE id = $2), $3, $4, $5, $6, $7, $8, $9)`, [
                    matchId,
                    player.profileId ?? null,
                    player.name,
                    player.avatar,
                    player.score,
                    player.rank,
                    player.guesses,
                    player.correctGuesses,
                    player.rank === 1,
                ]);
                if (player.profileId) {
                    await client.query(`INSERT INTO player_stats
               (player_id, games_played, games_won, total_score, guesses, correct_guesses)
             SELECT $1, 1, $2, $3, $4, $5 WHERE EXISTS (SELECT 1 FROM players WHERE id = $1)
             ON CONFLICT (player_id) DO UPDATE SET
               games_played = player_stats.games_played + 1,
               games_won = player_stats.games_won + $2,
               total_score = player_stats.total_score + $3,
               guesses = player_stats.guesses + $4,
               correct_guesses = player_stats.correct_guesses + $5,
               updated_at = now()`, [
                        player.profileId,
                        player.rank === 1 ? 1 : 0,
                        player.score,
                        player.guesses,
                        player.correctGuesses,
                    ]);
                }
            }
            const record = await loadMatch(client, matchId);
            if (!record)
                throw new Error("Match vanished inside its finalization transaction");
            return record;
        });
    }
    async get(matchId) {
        return loadMatch(this.pool, matchId);
    }
    async history(playerId, limit = 25) {
        const matches = await this.pool.query(`SELECT m.id, m.room_code, m.rounds, m.ended_at
         FROM matches m
         JOIN match_players mp ON mp.match_id = m.id
        WHERE mp.player_id = $1
        ORDER BY m.ended_at DESC
        LIMIT $2`, [playerId, clampLimit(limit, 50)]);
        if (!matches.rows.length)
            return [];
        const ids = matches.rows.map((row) => row.id);
        const players = await this.pool.query(`SELECT match_id, player_id, display_name, avatar, score, rank, guesses, correct_guesses, won
         FROM match_players WHERE match_id = ANY($1::uuid[])
        ORDER BY rank ASC, display_name ASC`, [ids]);
        return matches.rows.map((match) => toMatchRecord(match, players.rows.filter((player) => player.match_id === match.id)));
    }
}
const emptyStats = () => ({
    gamesPlayed: 0,
    gamesWon: 0,
    totalPoints: 0,
    guesses: 0,
    correctGuesses: 0,
});
export class PlayerRepository {
    pool;
    matches;
    constructor(pool, matches) {
        this.pool = pool;
        this.matches = matches;
    }
    async profileView(playerId) {
        const result = await this.pool.query(`SELECT p.id, p.display_name, p.avatar, p.created_at,
              COALESCE(s.games_played, 0) AS games_played,
              COALESCE(s.games_won, 0) AS games_won,
              COALESCE(s.total_score, 0) AS total_score,
              COALESCE(s.guesses, 0) AS guesses,
              COALESCE(s.correct_guesses, 0) AS correct_guesses
         FROM players p
         LEFT JOIN player_stats s ON s.player_id = p.id
        WHERE p.id = $1 AND p.deleted_at IS NULL`, [playerId]);
        const row = result.rows[0];
        if (!row)
            return null;
        const stats = {
            gamesPlayed: row.games_played ?? 0,
            gamesWon: row.games_won ?? 0,
            totalPoints: Number(row.total_score ?? 0),
            guesses: row.guesses ?? 0,
            correctGuesses: row.correct_guesses ?? 0,
        };
        return {
            profile: {
                id: row.id,
                name: row.display_name,
                avatar: row.avatar,
                stats,
                createdAt: row.created_at.getTime(),
            },
            accuracy: accuracyOf(stats),
            history: await this.matches.history(playerId),
        };
    }
    async leaderboard(limit = 20) {
        const result = await this.pool.query(`SELECT p.id, p.display_name, p.avatar, p.created_at,
              s.games_played, s.games_won, s.total_score, s.guesses, s.correct_guesses
         FROM player_stats s
         JOIN players p ON p.id = s.player_id
        WHERE p.deleted_at IS NULL AND s.games_played > 0
        ORDER BY s.games_won DESC, s.total_score DESC,
                 (CASE WHEN s.guesses > 0 THEN s.correct_guesses::numeric / s.guesses ELSE 0 END) DESC,
                 p.display_name ASC
        LIMIT $1`, [clampLimit(limit)]);
        return result.rows.map((row, index) => {
            const stats = {
                gamesPlayed: row.games_played ?? 0,
                gamesWon: row.games_won ?? 0,
                totalPoints: Number(row.total_score ?? 0),
                guesses: row.guesses ?? 0,
                correctGuesses: row.correct_guesses ?? 0,
            };
            return {
                rank: index + 1,
                profileId: row.id,
                name: row.display_name,
                avatar: row.avatar,
                wins: stats.gamesWon,
                gamesPlayed: stats.gamesPlayed,
                points: stats.totalPoints,
                accuracy: accuracyOf(stats),
            };
        });
    }
    async stats(playerId) {
        const result = await this.pool.query(`SELECT p.id, p.display_name, p.avatar, p.created_at,
              s.games_played, s.games_won, s.total_score, s.guesses, s.correct_guesses
         FROM players p LEFT JOIN player_stats s ON s.player_id = p.id
        WHERE p.id = $1`, [playerId]);
        const row = result.rows[0];
        if (!row)
            return emptyStats();
        return {
            gamesPlayed: row.games_played ?? 0,
            gamesWon: row.games_won ?? 0,
            totalPoints: Number(row.total_score ?? 0),
            guesses: row.guesses ?? 0,
            correctGuesses: row.correct_guesses ?? 0,
        };
    }
    /** Hard-deletes are avoided so match history snapshots remain readable. */
    async softDelete(playerId) {
        await this.pool.query(`UPDATE players SET deleted_at = now() WHERE id = $1`, [playerId]);
    }
}
export class WordListRepository {
    pool;
    constructor(pool) {
        this.pool = pool;
    }
    async get(playerId) {
        const result = await this.pool.query(`SELECT categories FROM word_lists WHERE player_id = $1`, [playerId]);
        return result.rows[0]?.categories ?? null;
    }
    async save(playerId, categories) {
        await this.pool.query(`INSERT INTO word_lists (player_id, categories) VALUES ($1, $2::jsonb)
       ON CONFLICT (player_id) DO UPDATE SET categories = EXCLUDED.categories, updated_at = now()`, [playerId, JSON.stringify(categories)]);
    }
}
const toReport = (row) => ({
    id: row.id,
    roomCode: row.room_code,
    reporterId: row.reporter_id ?? "",
    reporterName: row.reporter_name,
    reporterProfileId: row.reporter_id ?? "",
    targetId: row.target_id ?? "",
    targetName: row.target_name,
    ...(row.target_id ? { targetProfileId: row.target_id } : {}),
    reason: row.reason,
    at: row.created_at.getTime(),
});
export class ReportRepository {
    pool;
    constructor(pool) {
        this.pool = pool;
    }
    async save(report, roomId) {
        const result = await this.pool.query(`INSERT INTO reports
         (id, room_code, room_id, reporter_id, target_id, reporter_name, target_name, reason)
       VALUES ($1, $2, $3, (SELECT id FROM players WHERE id = $4), (SELECT id FROM players WHERE id = $5), $6, $7, $8)
       RETURNING id, room_code, room_id, reporter_id, target_id, reporter_name, target_name, reason, created_at`, [
            randomUUID(),
            report.roomCode,
            roomId,
            report.reporterProfileId || null,
            report.targetProfileId ?? null,
            report.reporterName,
            report.targetName,
            report.reason,
        ]);
        return toReport(result.rows[0]);
    }
    async forRoom(roomId, limit = 50) {
        const result = await this.pool.query(`SELECT id, room_code, room_id, reporter_id, target_id, reporter_name, target_name, reason, created_at
         FROM reports WHERE room_id = $1 ORDER BY created_at DESC LIMIT $2`, [roomId, clampLimit(limit)]);
        return result.rows.map(toReport);
    }
}
export class BanRepository {
    pool;
    constructor(pool) {
        this.pool = pool;
    }
    async add(input) {
        await this.pool.query(`INSERT INTO bans (id, player_id, room_id, room_code, banned_by, reason, expires_at)
       VALUES ($1, $2, $3, $4, (SELECT id FROM players WHERE id = $5), $6, $7)
       ON CONFLICT (player_id, room_id) DO UPDATE SET
         revoked_at = NULL,
         banned_by = EXCLUDED.banned_by,
         reason = EXCLUDED.reason,
         expires_at = EXCLUDED.expires_at,
         created_at = now()`, [
            randomUUID(),
            input.playerId,
            input.roomId,
            input.roomCode ?? null,
            input.bannedBy,
            input.reason ?? null,
            input.expiresAt ?? null,
        ]);
    }
    async isBanned(playerId, roomId) {
        const result = await this.pool.query(`SELECT 1 FROM bans
        WHERE player_id = $1
          AND (room_id IS NULL OR room_id = $2)
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > now())
        LIMIT 1`, [playerId, roomId]);
        return result.rowCount != null && result.rowCount > 0;
    }
    async revoke(playerId, roomId) {
        await this.pool.query(`UPDATE bans SET revoked_at = now()
        WHERE player_id = $1 AND room_id IS NOT DISTINCT FROM $2 AND revoked_at IS NULL`, [playerId, roomId]);
    }
}
export class SettingsRepository {
    pool;
    constructor(pool) {
        this.pool = pool;
    }
    async all() {
        const result = await this.pool.query(`SELECT key, value FROM moderation_settings`);
        return Object.fromEntries(result.rows.map((row) => [row.key, row.value]));
    }
    async set(key, value) {
        await this.pool.query(`INSERT INTO moderation_settings (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [key, JSON.stringify(value)]);
    }
}
