import { randomBytes, randomUUID } from "node:crypto";
import { customWordCount, resolveAvatar, validateCategories, validateName, } from "./validation.js";
export class GameError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "GameError";
        this.code = code;
    }
}
export const GAME_LIMITS = {
    minPlayers: 2,
    maxPlayers: 8,
    maxSpectators: 12,
    minDrawSeconds: 30,
    maxDrawSeconds: 180,
    /** Minimum custom words before a host may enable custom words. */
    minCustomWords: 3,
    /** Upper bound on stored strokes per round, to bound room memory. */
    maxStrokes: 2000,
    maxPointsPerStroke: 4000,
    maxRoomPoints: 120_000,
    /** Largest point batch accepted in one socket event. */
    maxPointChunk: 64,
    maxRedo: 500,
    wordChoiceCount: 3,
    minRounds: 1,
    maxRounds: 10,
    drawerPointsPerGuess: 35,
    maxChatHistory: 80,
    chooseSeconds: 15,
    drawSeconds: 80,
};
const WORDS = [
    "telescope",
    "watermelon",
    "volcano",
    "skateboard",
    "butterfly",
    "lighthouse",
    "pineapple",
    "spaceship",
    "toothbrush",
    "octopus",
];
const isNormalizedPoint = (p) => Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1;
const samePoint = (a, b) => a.x === b.x && a.y === b.y;
/** Indices of characters that participate in guessing hints. */
const hintIndexes = (word) => {
    const indexes = [];
    for (let index = 0; index < word.length; index += 1) {
        if (/[A-Za-z0-9]/.test(word[index]))
            indexes.push(index);
    }
    return indexes;
};
/** Stable pseudo-random reveal order so every client sees the same hint. */
const hintOrder = (word, indexes) => {
    let seed = 2166136261;
    for (const char of word.toLowerCase()) {
        seed ^= char.charCodeAt(0);
        seed = Math.imul(seed, 16777619) >>> 0;
    }
    const order = [...indexes];
    for (let index = order.length - 1; index > 0; index -= 1) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const swap = seed % (index + 1);
        [order[index], order[swap]] = [order[swap], order[index]];
    }
    return order;
};
/**
 * Derived hint mask: letters are revealed as the turn timer runs, in a stable
 * order shared by every client. At least one letter always stays hidden so the
 * word is never fully spoiled before the buzzer.
 */
export function maskedWordFor(word, endsAt, drawSeconds, now = Date.now()) {
    const indexes = hintIndexes(word);
    const chars = [...word].map((char, index) => (indexes.includes(index) ? "_" : char));
    if (!endsAt || drawSeconds <= 0 || indexes.length < 2)
        return chars.join("");
    const elapsed = Math.min(1, Math.max(0, 1 - (endsAt - now) / (drawSeconds * 1000)));
    const maxReveals = indexes.length - 1;
    const reveal = Math.min(maxReveals, Math.floor(elapsed * maxReveals));
    const order = hintOrder(word, indexes);
    for (let step = 0; step < reveal; step += 1) {
        const index = order[step];
        chars[index] = word[index];
    }
    return chars.join("");
}
export class Game {
    rooms = new Map();
    playerRoom = new Map();
    createRoom(playerId, name, profileId = playerId, avatar = resolveAvatar(undefined)) {
        const code = this.uniqueCode();
        const room = {
            roomId: randomUUID(),
            code,
            players: [
                {
                    id: playerId,
                    profileId,
                    name: this.cleanName(name),
                    avatar: resolveAvatar(avatar),
                    score: 0,
                    connected: true,
                    reconnecting: false,
                    guesses: 0,
                    correctGuesses: 0,
                    sessionToken: randomUUID(),
                },
            ],
            hostId: playerId,
            status: "lobby",
            round: 0,
            maxRounds: 3,
            turnIndex: -1,
            strokes: [],
            redoStack: [],
            nextStrokeSeq: 0,
            totalPoints: 0,
            boardVersion: 0,
            wordChoices: [],
            guessed: new Set(),
            chat: [],
            maxPlayers: GAME_LIMITS.maxPlayers,
            drawSeconds: GAME_LIMITS.drawSeconds,
            visibility: "private",
            inviteToken: randomBytes(24).toString("hex"),
            requireInvite: false,
            allowSpectators: true,
            categories: [],
            customWordsEnabled: false,
            bannedProfileIds: new Set(),
            bannedSocketIds: new Set(),
            mutedProfileIds: new Set(),
            spectators: [],
            matchRecorded: false,
        };
        this.rooms.set(code, room);
        this.playerRoom.set(playerId, code);
        return room;
    }
    /**
     * Joins the lobby as a player, or the running game as a spectator when the
     * room allows it. Invite tokens, bans and capacity are enforced here so every
     * caller (code join, deep link, matchmaking) shares the same rules.
     */
    joinRoom(code, playerId, name, options = {}) {
        const room = this.rooms.get(code.trim().toUpperCase());
        if (!room)
            throw new GameError("ROOM_NOT_FOUND", "Room not found");
        const profileId = options.profileId ?? playerId;
        const avatar = resolveAvatar(options.avatar);
        if (room.bannedProfileIds.has(profileId) || room.bannedSocketIds.has(playerId)) {
            throw new GameError("BANNED", "You were banned from this room");
        }
        if (room.requireInvite && options.invite !== room.inviteToken) {
            throw new GameError("INVALID_INVITE", "This room requires its invite link");
        }
        if (room.status === "lobby") {
            if (room.players.length >= room.maxPlayers)
                throw new GameError("ROOM_FULL", "Room is full");
            const player = {
                id: playerId,
                profileId,
                name: this.cleanName(name),
                avatar,
                score: 0,
                connected: true,
                reconnecting: false,
                guesses: 0,
                correctGuesses: 0,
                sessionToken: randomUUID(),
            };
            room.players.push(player);
            this.playerRoom.set(playerId, room.code);
            return { room, spectator: false, sessionToken: player.sessionToken };
        }
        if (room.status === "ended" || !room.allowSpectators) {
            throw new GameError("GAME_STARTED", "This game has already started");
        }
        if (room.spectators.length >= GAME_LIMITS.maxSpectators) {
            throw new GameError("SPECTATORS_FULL", "This game has no room for spectators");
        }
        const spectator = {
            id: playerId,
            profileId,
            name: this.cleanName(name),
            avatar,
            connected: true,
            reconnecting: false,
            sessionToken: randomUUID(),
        };
        room.spectators.push(spectator);
        this.playerRoom.set(playerId, room.code);
        return { room, spectator: true, sessionToken: spectator.sessionToken };
    }
    /**
     * Rebinds an existing seat (player or spectator) to a new socket id. Keeps
     * score, turn order, drawer role and guesses so a reconnect loses nothing.
     */
    resumeSession(code, token, newSocketId) {
        const room = this.rooms.get(code.toUpperCase());
        if (!room)
            throw new GameError("ROOM_NOT_FOUND", "Room not found");
        const player = room.players.find((p) => p.sessionToken === token);
        const spectator = player ? undefined : room.spectators.find((s) => s.sessionToken === token);
        if (!player && !spectator)
            throw new GameError("INVALID_SESSION", "This session is no longer valid");
        const seat = player ?? spectator;
        const previousId = seat.id;
        if (previousId !== newSocketId) {
            // Free the old socket mapping without deleting the seat.
            if (this.playerRoom.get(previousId) === room.code)
                this.playerRoom.delete(previousId);
            this.playerRoom.set(newSocketId, room.code);
            seat.id = newSocketId;
            if (room.hostId === previousId)
                room.hostId = newSocketId;
            if (room.drawerId === previousId)
                room.drawerId = newSocketId;
            if (room.guessed.delete(previousId))
                room.guessed.add(newSocketId);
        }
        seat.connected = true;
        seat.reconnecting = false;
        return { room, player, spectator };
    }
    markDisconnected(playerId) {
        const room = this.roomOf(playerId);
        if (!room)
            return undefined;
        const seat = room.players.find((p) => p.id === playerId) ?? room.spectators.find((s) => s.id === playerId);
        if (!seat)
            return undefined;
        seat.connected = false;
        seat.reconnecting = true;
        return room;
    }
    isSpectator(room, playerId) {
        return room.spectators.some((spectator) => spectator.id === playerId);
    }
    start(room, playerId) {
        if (room.hostId !== playerId)
            throw new GameError("NOT_HOST", "Only the host can start the game");
        if (room.status !== "lobby")
            throw new GameError("WRONG_PHASE", "The game has already started");
        if (room.players.length < GAME_LIMITS.minPlayers) {
            throw new GameError("NEED_PLAYERS", `At least ${GAME_LIMITS.minPlayers} players are required`);
        }
        if (room.customWordsEnabled && this.customWordPool(room).length < GAME_LIMITS.minCustomWords) {
            throw new GameError("INVALID_CONFIG", `Add at least ${GAME_LIMITS.minCustomWords} custom words or turn them off`);
        }
        room.status = "choosing";
        room.round = 1;
        room.turnIndex = -1;
        room.maxRounds = Math.max(1, room.maxRounds);
        room.startedAt = Date.now();
        room.endedAt = undefined;
        room.matchRecorded = false;
        room.matchId = undefined;
        this.nextTurn(room);
    }
    nextTurn(room) {
        const count = room.players.length;
        if (count === 0) {
            room.status = "ended";
            room.drawerId = undefined;
            room.wordChoices = [];
            room.secretWord = undefined;
            room.endsAt = undefined;
            room.endedAt = room.endedAt ?? Date.now();
            room.matchRecorded = true;
            return;
        }
        // Only a full rotation advances the round. The very first turn starts at
        // index 0 without wrapping, so it never counts as a completed round.
        room.turnIndex += 1;
        if (room.turnIndex >= count) {
            room.turnIndex = 0;
            room.round += 1;
        }
        if (room.round > room.maxRounds) {
            room.status = "ended";
            room.drawerId = undefined;
            room.wordChoices = [];
            room.secretWord = undefined;
            room.maskedWord = undefined;
            room.endsAt = undefined;
            room.endedAt = Date.now();
            room.matchRecorded = false;
            room.matchId = undefined;
            this.resetBoard(room);
            return;
        }
        room.drawerId = room.players[room.turnIndex]?.id;
        // The word is not decided yet: the drawer gets three private options.
        room.wordChoices = this.pickWordChoices(room);
        room.secretWord = undefined;
        room.maskedWord = undefined;
        room.guessed.clear();
        this.resetBoard(room);
        room.status = "choosing";
        room.endsAt = Date.now() + GAME_LIMITS.chooseSeconds * 1000;
    }
    chooseWord(room, playerId, word) {
        if (room.status !== "choosing")
            throw new GameError("WRONG_PHASE", "No word choice is active");
        if (room.drawerId !== playerId)
            throw new GameError("NOT_DRAWER", "Only the drawer can choose a word");
        if (!room.wordChoices.includes(word))
            throw new GameError("INVALID_WORD", "Invalid word");
        room.secretWord = word;
        room.maskedWord = word.replace(/[A-Za-z0-9]/g, "_");
        room.wordChoices = [];
        room.status = "drawing";
        room.endsAt = Date.now() + room.drawSeconds * 1000;
    }
    /**
     * Host-only lobby settings; scores and timers stay server-owned. Accepts a
     * bare number for backwards compatibility with the Phase 3 `maxRounds` call.
     */
    configure(room, playerId, settings) {
        if (room.hostId !== playerId)
            throw new GameError("NOT_HOST", "Only the host can change settings");
        if (room.status !== "lobby")
            throw new GameError("WRONG_PHASE", "Settings are locked after the game starts");
        const patch = typeof settings === "number" ? { maxRounds: settings } : settings;
        if (patch.maxRounds !== undefined) {
            if (!Number.isInteger(patch.maxRounds) ||
                patch.maxRounds < GAME_LIMITS.minRounds ||
                patch.maxRounds > GAME_LIMITS.maxRounds) {
                throw new GameError("INVALID_CONFIG", `Rounds must be between ${GAME_LIMITS.minRounds} and ${GAME_LIMITS.maxRounds}`);
            }
            room.maxRounds = patch.maxRounds;
        }
        if (patch.drawSeconds !== undefined) {
            if (!Number.isInteger(patch.drawSeconds) ||
                patch.drawSeconds < GAME_LIMITS.minDrawSeconds ||
                patch.drawSeconds > GAME_LIMITS.maxDrawSeconds) {
                throw new GameError("INVALID_CONFIG", `Drawing time must be ${GAME_LIMITS.minDrawSeconds}–${GAME_LIMITS.maxDrawSeconds} seconds`);
            }
            room.drawSeconds = patch.drawSeconds;
        }
        if (patch.maxPlayers !== undefined) {
            if (!Number.isInteger(patch.maxPlayers) ||
                patch.maxPlayers < GAME_LIMITS.minPlayers ||
                patch.maxPlayers > GAME_LIMITS.maxPlayers ||
                patch.maxPlayers < room.players.length) {
                throw new GameError("INVALID_CONFIG", `Room size must be ${GAME_LIMITS.minPlayers}–${GAME_LIMITS.maxPlayers} and fit everyone here`);
            }
            room.maxPlayers = patch.maxPlayers;
        }
        if (patch.customWordsEnabled !== undefined) {
            if (patch.customWordsEnabled && this.customWordPool(room).length < GAME_LIMITS.minCustomWords) {
                throw new GameError("INVALID_CONFIG", `Add at least ${GAME_LIMITS.minCustomWords} custom words first`);
            }
            room.customWordsEnabled = patch.customWordsEnabled;
        }
        if (patch.allowSpectators !== undefined)
            room.allowSpectators = patch.allowSpectators;
        if (patch.requireInvite !== undefined)
            room.requireInvite = patch.requireInvite;
        if (patch.visibility !== undefined)
            room.visibility = patch.visibility;
    }
    /** Replaces the host's word list. Words never appear in public payloads. */
    setCategories(room, playerId, categories) {
        if (room.hostId !== playerId)
            throw new GameError("NOT_HOST", "Only the host can edit word lists");
        if (room.status !== "lobby")
            throw new GameError("WRONG_PHASE", "Word lists are locked after the game starts");
        const clean = validateCategories(categories);
        if (room.customWordsEnabled && customWordCount(clean) < GAME_LIMITS.minCustomWords) {
            throw new GameError("INVALID_WORDS", `Keep at least ${GAME_LIMITS.minCustomWords} words while custom words are enabled`);
        }
        room.categories = clean;
        return clean;
    }
    customWordPool(room) {
        return room.categories.flatMap((category) => category.words);
    }
    /** Public lobby summaries. Invite-only rooms stay hidden by design. */
    listPublicRooms(limit = 20) {
        return [...this.rooms.values()]
            .filter((room) => room.visibility === "public" && room.status === "lobby" && !room.requireInvite)
            .sort((a, b) => b.players.length - a.players.length || a.code.localeCompare(b.code))
            .slice(0, limit);
    }
    /** Host-only, non-secret share metadata for the invite deep link. */
    inviteFor(room, playerId) {
        if (room.hostId !== playerId)
            throw new GameError("NOT_HOST", "Only the host can share the invite");
        if (room.status === "ended")
            throw new GameError("WRONG_PHASE", "This game has ended");
        return {
            code: room.code,
            inviteToken: room.inviteToken,
            deepLink: `skrible://join?code=${room.code}&invite=${room.inviteToken}`,
        };
    }
    /**
     * Applies an expired timer exactly once. Called by the server tick and before
     * any scoring action so a guess can never land after the buzzer.
     */
    advanceIfExpired(room, now = Date.now()) {
        if (room.status === "lobby" || room.status === "ended" || !room.endsAt) {
            return { changed: false, wordOptions: false };
        }
        if (now < room.endsAt)
            return { changed: false, wordOptions: false };
        if (room.status === "choosing") {
            // Auto-pick one of the drawer's options so the round still starts.
            const drawerId = room.drawerId;
            const choice = room.wordChoices[Math.floor(Math.random() * room.wordChoices.length)];
            if (drawerId && choice) {
                this.chooseWord(room, drawerId, choice);
                return { changed: true, wordOptions: false };
            }
            return this.finishTurn(room);
        }
        return this.finishTurn(room);
    }
    /**
     * Recomputes the visible hint mask from the turn clock. Returns true when the
     * mask changed so the server only broadcasts when a letter is actually
     * revealed (a handful of times per turn).
     */
    refreshHints(room, now = Date.now()) {
        if (room.status !== "drawing" || !room.secretWord)
            return false;
        const next = maskedWordFor(room.secretWord, room.endsAt, room.drawSeconds, now);
        if (next === room.maskedWord)
            return false;
        room.maskedWord = next;
        return true;
    }
    /** Advances the turn and reports whether a new word choice must be offered. */
    finishTurn(room) {
        this.nextTurn(room);
        const status = room.status;
        return { changed: true, wordOptions: status === "choosing" };
    }
    guess(room, playerId, raw) {
        const player = room.players.find((p) => p.id === playerId);
        if (!player ||
            room.status !== "drawing" ||
            !room.secretWord ||
            playerId === room.drawerId ||
            room.guessed.has(playerId)) {
            return { correct: false };
        }
        const normalize = (value) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
        const guess = normalize(raw);
        player.guesses += 1;
        if (guess && guess === normalize(room.secretWord)) {
            room.guessed.add(playerId);
            player.correctGuesses += 1;
            const remaining = Math.max(0, (room.endsAt ?? Date.now()) - Date.now());
            const score = 100 + Math.round(remaining / 1000);
            player.score += score;
            const drawer = room.players.find((p) => p.id === room.drawerId);
            if (drawer)
                drawer.score += GAME_LIMITS.drawerPointsPerGuess;
            return {
                correct: true,
                playerName: player.name,
                playerId: player.id,
                score,
                drawerPoints: GAME_LIMITS.drawerPointsPerGuess,
            };
        }
        return { correct: false };
    }
    updateIdentity(room, playerId, name, avatar) {
        const seat = room.players.find((player) => player.id === playerId) ??
            room.spectators.find((spectator) => spectator.id === playerId);
        if (!seat)
            throw new GameError("NOT_IN_ROOM", "Join a room first");
        seat.name = this.cleanName(name);
        seat.avatar = resolveAvatar(avatar);
        return seat;
    }
    /** Host-only mute. Muting also blocks guesses so chat cannot bypass it. */
    mute(room, hostId, targetId, muted) {
        if (room.hostId !== hostId)
            throw new GameError("NOT_HOST", "Only the host can mute players");
        if (targetId === hostId)
            throw new GameError("CANT_MODERATE", "You cannot mute yourself");
        const target = room.players.find((player) => player.id === targetId) ??
            room.spectators.find((spectator) => spectator.id === targetId);
        if (!target)
            throw new GameError("NOT_IN_ROOM", "That player is not here");
        if (muted)
            room.mutedProfileIds.add(target.profileId);
        else
            room.mutedProfileIds.delete(target.profileId);
        return target;
    }
    /** Kick removes the seat; ban additionally blocks this profile from rejoining. */
    kick(room, hostId, targetId, ban = false) {
        if (room.hostId !== hostId)
            throw new GameError("NOT_HOST", "Only the host can remove players");
        if (targetId === hostId)
            throw new GameError("CANT_MODERATE", "You cannot remove yourself");
        const target = room.players.find((player) => player.id === targetId) ??
            room.spectators.find((spectator) => spectator.id === targetId);
        if (!target)
            throw new GameError("NOT_IN_ROOM", "That player is not here");
        if (ban) {
            room.bannedProfileIds.add(target.profileId);
            room.bannedSocketIds.add(target.id);
        }
        room.mutedProfileIds.delete(target.profileId);
        const updated = this.removePlayer(targetId);
        return { target, room: updated };
    }
    isMuted(room, playerId) {
        const seat = room.players.find((player) => player.id === playerId) ??
            room.spectators.find((spectator) => spectator.id === playerId);
        return seat ? room.mutedProfileIds.has(seat.profileId) : false;
    }
    /**
     * True when a chat line would reveal the current word (exact or embedded,
     * ignoring case, spacing and punctuation). Used to block leaks before broadcast.
     */
    containsSecret(room, text) {
        if (!room.secretWord)
            return false;
        const normalize = (value) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
        const secret = normalize(room.secretWord);
        return secret.length > 0 && normalize(text).includes(secret);
    }
    pushChat(room, message) {
        const full = { ...message, id: randomUUID(), at: Date.now() };
        room.chat.push(full);
        if (room.chat.length > GAME_LIMITS.maxChatHistory) {
            room.chat.splice(0, room.chat.length - GAME_LIMITS.maxChatHistory);
        }
        return full;
    }
    beginStroke(room, playerId, input) {
        this.assertActiveDrawer(room, playerId);
        if (input.tool === "eraser" && !/^#[0-9a-fA-F]{6}$/.test(input.color)) {
            throw new GameError("INVALID_STROKE", "Invalid eraser color");
        }
        if (room.strokes.some((s) => s.id === input.id)) {
            throw new GameError("INVALID_STROKE", "Duplicate stroke id");
        }
        if (room.strokes.length >= GAME_LIMITS.maxStrokes) {
            throw new GameError("BOARD_FULL", "The canvas is full. Clear it to keep drawing.");
        }
        // A new stroke implicitly finishes any stroke still open (dropped end packet).
        const open = room.strokes[room.strokes.length - 1];
        if (open && !open.complete)
            open.complete = true;
        const stroke = {
            id: input.id,
            seq: room.nextStrokeSeq++,
            points: [],
            color: input.color,
            width: input.width,
            tool: input.tool,
            complete: false,
        };
        room.strokes.push(stroke);
        room.redoStack = [];
        room.boardVersion += 1;
        return stroke;
    }
    appendStrokePoints(room, playerId, strokeId, points, chunkSeq) {
        this.assertActiveDrawer(room, playerId);
        if (!points.length)
            throw new GameError("INVALID_STROKE", "No points supplied");
        if (points.length > GAME_LIMITS.maxPointChunk) {
            throw new GameError("INVALID_STROKE", "Too many points in one batch");
        }
        const stroke = room.strokes[room.strokes.length - 1];
        if (!stroke || stroke.id !== strokeId || stroke.complete) {
            throw new GameError("INVALID_STROKE", "That stroke is not accepting points");
        }
        // A retransmitted chunk is a no-op, so a flaky mobile network can resend
        // safely without drawing the same points twice.
        if (chunkSeq !== undefined && chunkSeq <= (stroke.chunkSeq ?? 0)) {
            return { stroke, appended: 0 };
        }
        if (room.totalPoints + points.length > GAME_LIMITS.maxRoomPoints) {
            throw new GameError("BOARD_FULL", "The canvas is full. Clear it to keep drawing.");
        }
        let appended = 0;
        for (const point of points) {
            if (!isNormalizedPoint(point))
                throw new GameError("INVALID_STROKE", "Point out of range");
            const previous = stroke.points[stroke.points.length - 1];
            if (previous && samePoint(previous, point))
                continue;
            stroke.points.push({ x: point.x, y: point.y });
            appended += 1;
        }
        if (stroke.points.length > GAME_LIMITS.maxPointsPerStroke) {
            // Keep the stroke bounded; later points are dropped rather than failing the draw.
            stroke.points.length = GAME_LIMITS.maxPointsPerStroke;
        }
        if (chunkSeq !== undefined)
            stroke.chunkSeq = chunkSeq;
        room.totalPoints += appended;
        room.boardVersion += 1;
        return { stroke, appended };
    }
    endStroke(room, playerId, strokeId) {
        this.assertActiveDrawer(room, playerId);
        const stroke = room.strokes[room.strokes.length - 1];
        if (!stroke || stroke.id !== strokeId)
            throw new GameError("INVALID_STROKE", "Unknown stroke");
        if (!stroke.complete) {
            stroke.complete = true;
            room.boardVersion += 1;
        }
        return stroke;
    }
    undo(room, playerId) {
        this.assertActiveDrawer(room, playerId);
        const stroke = room.strokes.pop();
        if (!stroke)
            throw new GameError("NOTHING_TO_UNDO", "Nothing to undo");
        stroke.complete = true;
        room.redoStack.push(stroke);
        if (room.redoStack.length > GAME_LIMITS.maxRedo)
            room.redoStack.shift();
        room.boardVersion += 1;
        return stroke;
    }
    redo(room, playerId) {
        this.assertActiveDrawer(room, playerId);
        const stroke = room.redoStack.pop();
        if (!stroke)
            throw new GameError("NOTHING_TO_REDO", "Nothing to redo");
        if (room.strokes.length >= GAME_LIMITS.maxStrokes) {
            room.redoStack.push(stroke);
            throw new GameError("BOARD_FULL", "The canvas is full. Clear it to keep drawing.");
        }
        room.strokes.push(stroke);
        room.boardVersion += 1;
        return stroke;
    }
    clearBoard(room, playerId) {
        this.assertActiveDrawer(room, playerId);
        this.resetBoard(room);
        return room;
    }
    leave(playerId) {
        return this.removePlayer(playerId);
    }
    removePlayer(playerId) {
        const code = this.playerRoom.get(playerId);
        if (!code)
            return undefined;
        const room = this.rooms.get(code);
        this.playerRoom.delete(playerId);
        if (!room)
            return undefined;
        const index = room.players.findIndex((p) => p.id === playerId);
        if (index === -1) {
            const spectatorIndex = room.spectators.findIndex((s) => s.id === playerId);
            if (spectatorIndex === -1)
                return room;
            room.spectators.splice(spectatorIndex, 1);
            if (!room.players.length && !room.spectators.length) {
                this.rooms.delete(code);
                return undefined;
            }
            return room;
        }
        room.players.splice(index, 1);
        room.guessed.delete(playerId);
        if (!room.players.length) {
            // Spectators may still be watching the result; keep the room briefly but
            // mark it ended. With nobody left at all the room is released immediately.
            room.status = "ended";
            room.drawerId = undefined;
            room.wordChoices = [];
            room.secretWord = undefined;
            room.maskedWord = undefined;
            room.endsAt = undefined;
            room.endedAt = room.endedAt ?? Date.now();
            room.matchRecorded = true;
            // Spectators may still be watching; keep a valid host id so the room
            // does not end up in an ownerless state while they read the results.
            room.hostId = room.spectators[0]?.id ?? "";
            this.resetBoard(room);
            if (!room.spectators.length) {
                this.rooms.delete(code);
                return undefined;
            }
            return room;
        }
        if (room.hostId === playerId) {
            room.hostId = room.players[Math.min(index, room.players.length - 1)].id;
        }
        if (index < room.turnIndex)
            room.turnIndex -= 1;
        const wasDrawer = room.drawerId === playerId && room.status !== "lobby" && room.status !== "ended";
        if (wasDrawer) {
            // Hand the turn to the player that now occupies the removed drawer's index.
            room.turnIndex = room.turnIndex - 1;
            this.nextTurn(room);
        }
        else if (room.turnIndex >= room.players.length) {
            room.turnIndex = room.players.length - 1;
        }
        return room;
    }
    roomOf(playerId) {
        const code = this.playerRoom.get(playerId);
        return code ? this.rooms.get(code) : undefined;
    }
    /** Rehydrates a room snapshot after a restart. Callers are trusted infrastructure. */
    restoreRoom(room) {
        this.rooms.set(room.code, room);
        for (const player of room.players)
            this.playerRoom.set(player.id, room.code);
        for (const spectator of room.spectators)
            this.playerRoom.set(spectator.id, room.code);
        return room;
    }
    forgetRoom(room) {
        for (const player of room.players)
            this.playerRoom.delete(player.id);
        for (const spectator of room.spectators)
            this.playerRoom.delete(spectator.id);
        this.rooms.delete(room.code);
    }
    pickWordChoices(room) {
        const custom = room.customWordsEnabled ? this.customWordPool(room) : [];
        const pool = custom.length >= GAME_LIMITS.wordChoiceCount ? [...new Set(custom)] : [...WORDS];
        const choices = [];
        while (choices.length < GAME_LIMITS.wordChoiceCount && pool.length > 0) {
            const index = Math.floor(Math.random() * pool.length);
            choices.push(pool.splice(index, 1)[0]);
        }
        return choices;
    }
    assertActiveDrawer(room, playerId) {
        if (room.status !== "drawing") {
            throw new GameError("WRONG_PHASE", "Drawing is not active right now");
        }
        if (room.drawerId !== playerId) {
            throw new GameError("NOT_DRAWER", "Only the current drawer can draw");
        }
    }
    resetBoard(room) {
        room.strokes = [];
        room.redoStack = [];
        room.nextStrokeSeq = 0;
        room.totalPoints = 0;
        room.boardVersion += 1;
    }
    cleanName(name) {
        try {
            return validateName(name);
        }
        catch {
            throw new GameError("INVALID_NAME", "Please choose a friendlier name");
        }
    }
    uniqueCode() {
        const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        let code = "";
        do {
            code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
        } while (this.rooms.has(code));
        return code;
    }
}
export const publicRoomSummary = (room) => ({
    code: room.code,
    hostName: room.players.find((player) => player.id === room.hostId)?.name ?? "Host",
    players: room.players.length,
    maxPlayers: room.maxPlayers,
    round: room.round,
    maxRounds: room.maxRounds,
    drawSeconds: room.drawSeconds,
});
export const publicRoom = (room, viewerId) => {
    const viewerPlayer = room.players.find((player) => player.id === viewerId);
    const viewerSpectator = room.spectators.find((spectator) => spectator.id === viewerId);
    const viewer = viewerPlayer ?? viewerSpectator;
    const isDrawer = viewerPlayer != null && room.drawerId === viewerId;
    return {
        code: room.code,
        status: room.status,
        round: room.round,
        maxRounds: room.maxRounds,
        players: room.players.map(({ id, profileId, name, score, connected, reconnecting, avatar }) => ({
            id,
            profileId,
            name,
            score,
            connected,
            reconnecting: Boolean(reconnecting),
            avatar,
        })),
        spectators: room.spectators.map(({ id, profileId, name, avatar, connected, reconnecting }) => ({
            id,
            profileId,
            name,
            avatar,
            connected,
            reconnecting: Boolean(reconnecting),
        })),
        hostId: room.hostId,
        drawerId: room.drawerId,
        drawerName: room.players.find((p) => p.id === room.drawerId)?.name,
        maxPlayers: room.maxPlayers,
        drawSeconds: room.drawSeconds,
        visibility: room.visibility,
        requireInvite: room.requireInvite,
        allowSpectators: room.allowSpectators,
        customWordsEnabled: room.customWordsEnabled,
        customWordCount: customWordCount(room.categories),
        customCategories: room.categories.map((category) => category.name),
        youAreMuted: viewer ? room.mutedProfileIds.has(viewer.profileId) : false,
        startedAt: room.startedAt,
        endedAt: room.endedAt,
        matchId: room.matchId,
        maskedWord: room.status === "drawing" && room.secretWord
            ? maskedWordFor(room.secretWord, room.endsAt, room.drawSeconds)
            : room.maskedWord,
        endsAt: room.endsAt,
        strokes: room.strokes,
        boardVersion: room.boardVersion,
        /** Server clock so clients offset countdowns instead of trusting the device. */
        serverNow: Date.now(),
        undoDepth: room.strokes.length,
        redoDepth: room.redoStack.length,
        guessedIds: Array.from(room.guessed),
        chat: room.chat.map((message) => ({ ...message })),
        chooseEndsAt: room.status === "choosing" ? room.endsAt : undefined,
        isDrawer,
        isSpectator: viewerSpectator != null,
        avatar: viewer?.avatar,
        // Private data: only ever serialized into the active drawer's own payload.
        wordChoices: isDrawer ? room.wordChoices : undefined,
        secretWord: isDrawer ? room.secretWord : undefined,
    };
};
