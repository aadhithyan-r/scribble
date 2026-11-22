-- Room codes are recycled; room_id is the stable instance identity. Persisted
-- moderation records must follow the room instance, not a reused code.

ALTER TABLE reports ADD COLUMN room_id uuid;
ALTER TABLE bans ADD COLUMN room_id uuid;

ALTER TABLE bans DROP CONSTRAINT bans_player_id_room_code_key;
DROP INDEX IF EXISTS bans_player_id_room_code_key;

CREATE UNIQUE INDEX bans_player_scope_unique ON bans (player_id, room_id) NULLS NOT DISTINCT;
CREATE INDEX reports_room_id_idx ON reports (room_id, created_at DESC);
CREATE INDEX bans_room_id_idx ON bans (room_id) WHERE revoked_at IS NULL;
