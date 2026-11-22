import test from "node:test";
import assert from "node:assert/strict";
import { Game, GameError, GAME_LIMITS, maskedWordFor, publicRoom, publicRoomSummary, type Room, type Stroke } from "./game.js";

const DRAWER = "socket-drawer";
const GUESSER = "socket-guesser";
const THIRD = "socket-third";

type Ctx = { game: Game; room: Room };

function newGame(): Ctx {
  const game = new Game();
  const room = game.createRoom(DRAWER, "Drawer");
  game.joinRoom(room.code, GUESSER, "Guesser");
  return { game, room };
}

/** Room that has started and is waiting for the drawer to pick one of three words. */
function choosingRoom(): Ctx {
  const ctx = newGame();
  ctx.game.start(ctx.room, DRAWER);
  return ctx;
}

/** Room in the drawing phase with a chosen word. */
function startedRoom(): Ctx {
  const ctx = choosingRoom();
  ctx.game.chooseWord(ctx.room, DRAWER, ctx.room.wordChoices[0]!);
  return ctx;
}

function expectCode(fn: () => unknown, code: string) {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof GameError, "expected a GameError");
    assert.equal(error.code, code);
    return true;
  });
}

const strokeBody = { color: "#123456", width: 6, tool: "pen" as const };

function begin({ game, room }: Ctx, id = `stroke-${Math.random().toString(36).slice(2, 10)}`) {
  return game.beginStroke(room, DRAWER, { id, ...strokeBody });
}

function drawStroke(ctx: Ctx, points = [{ x: 0.1, y: 0.1 }]) {
  const stroke = begin(ctx);
  ctx.game.appendStrokePoints(ctx.room, DRAWER, stroke.id, points);
  ctx.game.endStroke(ctx.room, DRAWER, stroke.id);
  return stroke;
}

function player(room: Room, id: string) {
  return room.players.find((p) => p.id === id)!;
}

test("starting requires the host and at least two players", () => {
  const game = new Game();
  const room = game.createRoom(DRAWER, "Drawer");
  expectCode(() => game.start(room, DRAWER), "NEED_PLAYERS");
  game.joinRoom(room.code, GUESSER, "Guesser");
  expectCode(() => game.start(room, GUESSER), "NOT_HOST");
  game.start(room, DRAWER);
  assert.equal(room.status, "choosing");
  assert.equal(room.drawerId, DRAWER);
  assert.equal(room.round, 1);
  assert.equal(room.secretWord, undefined);
  assert.equal(room.maskedWord, undefined);
  assert.equal(room.wordChoices.length, GAME_LIMITS.wordChoiceCount);
  assert.equal(new Set(room.wordChoices).size, GAME_LIMITS.wordChoiceCount);
  assert.ok(room.endsAt && room.endsAt > Date.now());
});

test("word choices and the chosen word stay private to the drawer", () => {
  const ctx = choosingRoom();
  const { room, game } = ctx;
  const drawerChoices = publicRoom(room, DRAWER).wordChoices!;
  const guesserView = publicRoom(room, GUESSER);

  assert.deepEqual(drawerChoices, room.wordChoices);
  assert.equal(guesserView.wordChoices, undefined);
  assert.equal(guesserView.secretWord, undefined);
  assert.equal(guesserView.status, "choosing");

  // A player cannot choose on the drawer's behalf, and off-list words fail.
  expectCode(() => game.chooseWord(room, GUESSER, room.wordChoices[0]!), "NOT_DRAWER");
  expectCode(() => game.chooseWord(room, DRAWER, "not-an-option"), "INVALID_WORD");

  const chosen = room.wordChoices[1]!;
  game.chooseWord(room, DRAWER, chosen);
  assert.equal(room.secretWord, chosen);
  assert.equal(room.maskedWord, "_".repeat(chosen.length));
  assert.equal(room.status, "drawing");
  assert.equal(room.wordChoices.length, 0);
  assert.ok(room.endsAt! > Date.now() + 70_000);

  const afterView = publicRoom(room, GUESSER);
  assert.equal(afterView.secretWord, undefined);
  assert.equal(afterView.wordChoices, undefined);
  assert.equal(afterView.maskedWord, "_".repeat(chosen.length));
  assert.ok(!JSON.stringify(afterView).includes(chosen));
  assert.ok(!JSON.stringify(afterView).includes("sessionToken"));
  assert.ok(!JSON.stringify(publicRoom(room, DRAWER)).includes("sessionToken"));
});

test("drawing is rejected for non-drawers and outside the drawing phase", () => {
  const game = new Game();
  const room = game.createRoom(DRAWER, "Drawer");
  game.joinRoom(room.code, GUESSER, "Guesser");

  expectCode(() => game.beginStroke(room, DRAWER, { id: "stroke-lobby", ...strokeBody }), "WRONG_PHASE");

  game.start(room, DRAWER);
  expectCode(() => game.beginStroke(room, DRAWER, { id: "stroke-choose", ...strokeBody }), "WRONG_PHASE");

  game.chooseWord(room, DRAWER, room.wordChoices[0]!);
  expectCode(() => game.beginStroke(room, GUESSER, { id: "stroke-guest", ...strokeBody }), "NOT_DRAWER");
  expectCode(() => game.undo(room, GUESSER), "NOT_DRAWER");
  expectCode(() => game.redo(room, GUESSER), "NOT_DRAWER");
  expectCode(() => game.clearBoard(room, GUESSER), "NOT_DRAWER");
  assert.equal(room.strokes.length, 0);
});

test("a stroke appends points, drops duplicates and is stored server-side", () => {
  const ctx = startedRoom();
  const { game, room } = ctx;
  const stroke = begin(ctx);

  const { appended } = game.appendStrokePoints(room, DRAWER, stroke.id, [
    { x: 0.1, y: 0.1 },
    { x: 0.1, y: 0.1 },
    { x: 0.2, y: 0.2 },
  ]);
  assert.equal(appended, 2);
  assert.equal(stroke.points.length, 2);
  assert.equal(room.totalPoints, 2);

  const finished = game.endStroke(room, DRAWER, stroke.id);
  assert.equal(finished.complete, true);
  expectCode(
    () => game.appendStrokePoints(room, DRAWER, stroke.id, [{ x: 0.4, y: 0.4 }]),
    "INVALID_STROKE",
  );

  const second = begin(ctx);
  assert.equal(second.seq, 1);
  assert.equal(room.strokes.length, 2);
});

test("point batches and coordinates are validated", () => {
  const ctx = startedRoom();
  const { game, room } = ctx;
  const stroke = begin(ctx);

  expectCode(
    () => game.appendStrokePoints(room, DRAWER, stroke.id, [{ x: 1.2, y: 0.5 }]),
    "INVALID_STROKE",
  );
  expectCode(
    () =>
      game.appendStrokePoints(
        room,
        DRAWER,
        stroke.id,
        Array.from({ length: GAME_LIMITS.maxPointChunk + 1 }, () => ({ x: 0.5, y: 0.5 })),
      ),
    "INVALID_STROKE",
  );
  expectCode(() => game.beginStroke(room, DRAWER, { id: stroke.id, ...strokeBody }), "INVALID_STROKE");

  game.endStroke(room, DRAWER, stroke.id);
  begin(ctx);
  expectCode(
    () => game.appendStrokePoints(room, DRAWER, stroke.id, [{ x: 0.3, y: 0.3 }]),
    "INVALID_STROKE",
  );
});

test("undo and redo move strokes between the two stacks", () => {
  const ctx = startedRoom();
  const { game, room } = ctx;
  const first = drawStroke(ctx);
  const second = drawStroke(ctx, [{ x: 0.2, y: 0.2 }]);

  const version = room.boardVersion;
  const removed = game.undo(room, DRAWER);
  assert.equal(removed.id, second.id);
  assert.equal(room.strokes.length, 1);
  assert.equal(room.redoStack.length, 1);
  assert.equal(room.boardVersion, version + 1);

  const restored = game.redo(room, DRAWER);
  assert.equal(restored.id, second.id);
  assert.equal(room.strokes.length, 2);
  assert.equal(room.redoStack.length, 0);

  game.undo(room, DRAWER);
  game.undo(room, DRAWER);
  assert.equal(room.strokes.length, 0);
  expectCode(() => game.undo(room, DRAWER), "NOTHING_TO_UNDO");

  assert.equal(game.redo(room, DRAWER).id, first.id);
  assert.equal(game.redo(room, DRAWER).id, second.id);
  expectCode(() => game.redo(room, DRAWER), "NOTHING_TO_REDO");
  assert.deepEqual(room.strokes.map((s) => s.seq), [0, 1]);
});

test("a new stroke clears the redo stack", () => {
  const ctx = startedRoom();
  drawStroke(ctx);
  ctx.game.undo(ctx.room, DRAWER);
  assert.equal(ctx.room.redoStack.length, 1);

  begin(ctx);
  assert.equal(ctx.room.redoStack.length, 0);
  expectCode(() => ctx.game.redo(ctx.room, DRAWER), "NOTHING_TO_REDO");
});

test("clear empties the board and both stacks", () => {
  const ctx = startedRoom();
  drawStroke(ctx);
  ctx.game.undo(ctx.room, DRAWER);
  assert.equal(ctx.room.redoStack.length, 1);

  const version = ctx.room.boardVersion;
  ctx.game.clearBoard(ctx.room, DRAWER);
  assert.equal(ctx.room.strokes.length, 0);
  assert.equal(ctx.room.redoStack.length, 0);
  assert.equal(ctx.room.totalPoints, 0);
  assert.equal(ctx.room.boardVersion, version + 1);
  expectCode(() => ctx.game.undo(ctx.room, DRAWER), "NOTHING_TO_UNDO");
});

test("the board has a hard size limit", () => {
  const ctx = startedRoom();
  const { room } = ctx;
  for (let i = 0; i < GAME_LIMITS.maxStrokes; i += 1) {
    const stroke: Stroke = {
      id: `filled-${i}`,
      seq: i,
      points: [],
      color: "#000000",
      width: 4,
      tool: "pen",
      complete: true,
    };
    room.strokes.push(stroke);
  }
  expectCode(() => begin(ctx), "BOARD_FULL");
});

test("correct guesses score by remaining time and credit the drawer", () => {
  const { game, room } = startedRoom();
  room.endsAt = Date.now() + 5_000;

  assert.deepEqual(game.guess(room, GUESSER, "definitely not it"), { correct: false });
  assert.equal(player(room, GUESSER).score, 0);

  const result = game.guess(room, GUESSER, ` ${room.secretWord!.toUpperCase()} `);
  assert.equal(result.correct, true);
  if (!result.correct) throw new Error("expected the guess to be accepted");
  assert.ok(result.score >= 100);
  assert.equal(player(room, GUESSER).score, result.score);
  assert.equal(player(room, DRAWER).score, GAME_LIMITS.drawerPointsPerGuess);
  assert.equal(room.status, "drawing");
  assert.equal(room.guessed.has(GUESSER), true);

  // Public scores always come from server state.
  const view = publicRoom(room, DRAWER);
  assert.equal(view.players.find((p) => p.id === GUESSER)!.score, player(room, GUESSER).score);
  assert.deepEqual(view.guessedIds, [GUESSER]);
});

test("the drawer cannot guess, and repeated guesses never double-score", () => {
  const { game, room } = startedRoom();
  const word = room.secretWord!;

  assert.deepEqual(game.guess(room, DRAWER, word), { correct: false });
  assert.equal(player(room, DRAWER).score, 0);

  const first = game.guess(room, GUESSER, word);
  assert.equal(first.correct, true);
  const scored = player(room, GUESSER).score;
  assert.ok(scored > 0);

  assert.deepEqual(game.guess(room, GUESSER, word), { correct: false });
  assert.equal(player(room, GUESSER).score, scored);
  assert.deepEqual(game.guess(room, GUESSER, ` ${word} `), { correct: false });
  assert.equal(player(room, GUESSER).score, scored);
  assert.equal(player(room, DRAWER).score, GAME_LIMITS.drawerPointsPerGuess);
});

test("two players guessing in the same tick each score exactly once", () => {
  const ctx = newGame();
  const { game, room } = ctx;
  game.joinRoom(room.code, THIRD, "Third");
  game.start(room, DRAWER);
  game.chooseWord(room, DRAWER, room.wordChoices[0]!);
  const word = room.secretWord!;

  // Node processes events one at a time, so this mirrors two simultaneous guesses.
  const results = [game.guess(room, GUESSER, word), game.guess(room, THIRD, word)];
  assert.equal(results.every((result) => result.correct), true);
  assert.ok(player(room, GUESSER).score > 0);
  assert.ok(player(room, THIRD).score > 0);
  assert.equal(player(room, DRAWER).score, GAME_LIMITS.drawerPointsPerGuess * 2);
  assert.equal(room.guessed.size, 2);

  // Repeat guesses, including from the same tick, change nothing.
  game.guess(room, GUESSER, word);
  game.guess(room, THIRD, word);
  const total = player(room, GUESSER).score + player(room, THIRD).score;
  game.guess(room, GUESSER, word);
  assert.equal(player(room, GUESSER).score + player(room, THIRD).score, total);
});

test("the drawing timer advances the turn and resets the board", () => {
  const ctx = startedRoom();
  const { game, room } = ctx;
  drawStroke(ctx);
  const drawerBefore = room.drawerId;
  room.endsAt = Date.now() - 1;

  const tick = game.advanceIfExpired(room, Date.now());
  assert.equal(tick.changed, true);
  assert.equal(tick.wordOptions, true);
  assert.equal(room.status, "choosing");
  assert.notEqual(room.drawerId, drawerBefore);
  assert.equal(room.strokes.length, 0);
  assert.equal(room.round, 1);
  assert.equal(room.wordChoices.length, GAME_LIMITS.wordChoiceCount);
  assert.equal(room.secretWord, undefined);
  assert.equal(room.maskedWord, undefined);
  assert.equal(room.guessed.size, 0);

  // A second tick on a fresh timer must not advance again.
  assert.deepEqual(game.advanceIfExpired(room, Date.now()), { changed: false, wordOptions: false });
});

test("the word-choice timer auto-picks one of the drawer's options", () => {
  const ctx = choosingRoom();
  const { game, room } = ctx;
  const choices = [...room.wordChoices];
  room.endsAt = Date.now() - 1;

  const tick = game.advanceIfExpired(room, Date.now());
  assert.equal(tick.changed, true);
  assert.equal(tick.wordOptions, false);
  assert.equal(room.status, "drawing");
  assert.ok(choices.includes(room.secretWord!));
  assert.equal(room.maskedWord, "_".repeat(room.secretWord!.length));
  assert.equal(room.wordChoices.length, 0);
  assert.ok(room.endsAt! > Date.now() + 70_000);
});

test("guesses after the buzzer are not scored", () => {
  const { game, room } = newGame();
  game.joinRoom(room.code, THIRD, "Third");
  game.start(room, DRAWER);
  game.chooseWord(room, DRAWER, room.wordChoices[0]!);
  const word = room.secretWord!;

  room.endsAt = Date.now() - 1;
  game.advanceIfExpired(room);
  assert.equal(room.status, "choosing");

  const late = game.guess(room, THIRD, word);
  assert.equal(late.correct, false);
  assert.equal(player(room, THIRD).score, 0);
  assert.equal(player(room, DRAWER).score, 0);
});

test("hints reveal letters over time without ever exposing the whole word", () => {
  const ctx = startedRoom();
  const { game, room } = ctx;
  const word = room.secretWord!;
  const blank = "_".repeat(word.length);
  assert.equal(room.maskedWord, blank);

  // Halfway through the turn some, but not all, letters are exposed.
  room.endsAt = Date.now() + (room.drawSeconds * 1000) / 2;
  assert.equal(game.refreshHints(room), true);
  const half = room.maskedWord!;
  assert.notEqual(half, blank);
  assert.equal(half.length, word.length);
  assert.ok(half.includes("_"));

  // At the very end at least one letter is still hidden.
  room.endsAt = Date.now() - 1;
  game.refreshHints(room);
  assert.ok(room.maskedWord!.includes("_"));
  assert.notEqual(room.maskedWord, word);

  // The same clock always produces the same mask on every client.
  const endsAt = Date.now() + 30_000;
  assert.equal(
    maskedWordFor(word, endsAt, room.drawSeconds, endsAt - 1_000),
    maskedWordFor(word, endsAt, room.drawSeconds, endsAt - 1_000),
  );

  // The public payload never carries the word while the turn is running.
  room.endsAt = Date.now() + 30_000;
  assert.ok(!JSON.stringify(publicRoom(room, GUESSER)).includes(`"${word}"`));
});

test("a drawer leaving hands the turn over without skipping a round", () => {
  const game = new Game();
  const room = game.createRoom(DRAWER, "Drawer");
  game.joinRoom(room.code, GUESSER, "Guesser");
  game.joinRoom(room.code, THIRD, "Third");
  game.configure(room, DRAWER, { maxRounds: 2 });
  game.start(room, DRAWER);
  game.chooseWord(room, DRAWER, room.wordChoices[0]!);

  const updated = game.removePlayer(DRAWER)!;
  assert.equal(updated.status, "choosing");
  assert.equal(updated.round, 1);
  assert.equal(updated.drawerId, GUESSER);
  assert.equal(updated.hostId, GUESSER);
  assert.equal(updated.players.length, 2);
});

test("public rooms are listed only while joinable", () => {
  const game = new Game();
  const room = game.createRoom(DRAWER, "Drawer");
  assert.equal(game.listPublicRooms().length, 0);

  game.configure(room, DRAWER, { visibility: "public" });
  assert.equal(game.listPublicRooms().length, 1);
  assert.equal(publicRoomSummary(room).players, 1);

  game.joinRoom(room.code, GUESSER, "Guesser");
  game.start(room, DRAWER);
  assert.equal(game.listPublicRooms().length, 0);
});

test("turn rotation respects the configured number of rounds", () => {
  const { game, room } = newGame();
  game.configure(room, DRAWER, 2);
  game.start(room, DRAWER);
  expectCode(() => game.configure(room, DRAWER, 3), "WRONG_PHASE");

  const drawers: string[] = [];
  for (let turn = 0; turn < 4; turn += 1) {
    assert.equal(room.status, "choosing");
    game.chooseWord(room, room.drawerId!, room.wordChoices[0]!);
    drawers.push(room.drawerId!);
    game.nextTurn(room);
  }
  assert.deepEqual(drawers, [DRAWER, GUESSER, DRAWER, GUESSER]);
  assert.equal(room.round, 3);
  assert.equal(room.status, "ended");
  assert.equal(room.secretWord, undefined);
  assert.equal(room.maskedWord, undefined);
  assert.equal(room.wordChoices.length, 0);
});

test("rounds are configurable by the host while in the lobby", () => {
  const { game, room } = newGame();
  expectCode(() => game.configure(room, GUESSER, 2), "NOT_HOST");
  expectCode(() => game.configure(room, DRAWER, 0), "INVALID_CONFIG");
  expectCode(() => game.configure(room, DRAWER, 11), "INVALID_CONFIG");
  expectCode(() => game.configure(room, DRAWER, 2.5), "INVALID_CONFIG");

  game.configure(room, DRAWER, 5);
  assert.equal(room.maxRounds, 5);
  game.start(room, DRAWER);
  assert.equal(room.maxRounds, 5);
  expectCode(() => game.configure(room, DRAWER, 4), "WRONG_PHASE");
});

test("chat lines that would reveal the word are detected", () => {
  const { game, room } = startedRoom();
  const word = room.secretWord!;
  assert.equal(game.containsSecret(room, word), true);
  assert.equal(game.containsSecret(room, word.toUpperCase()), true);
  assert.equal(game.containsSecret(room, `it is a ${word}!`), true);
  assert.equal(game.containsSecret(room, word.split("").join(" ")), true);
  assert.equal(game.containsSecret(room, "what a great drawing"), false);

  const choosing = choosingRoom();
  assert.equal(choosing.game.containsSecret(choosing.room, "anything"), false);
});

test("chat history is server-owned and bounded", () => {
  const { game, room } = startedRoom();
  const message = game.pushChat(room, { kind: "chat", playerId: GUESSER, name: "Guesser", text: "hi" });
  assert.ok(message.id.length > 0);
  assert.ok(message.at > 0);
  assert.equal(room.chat.length, 1);
  assert.equal(publicRoom(room, DRAWER).chat.at(-1)!.text, "hi");

  for (let index = 0; index < GAME_LIMITS.maxChatHistory + 10; index += 1) {
    game.pushChat(room, { kind: "system", text: `m${index}` });
  }
  assert.equal(room.chat.length, GAME_LIMITS.maxChatHistory);
  assert.equal(room.chat.at(-1)!.text, `m${GAME_LIMITS.maxChatHistory + 9}`);
});

test("a leaving drawer hands the turn over and clears the board", () => {
  const ctx = startedRoom();
  const { game, room } = ctx;
  begin(ctx);
  assert.equal(room.strokes.length, 1);

  const updated = game.leave(DRAWER);
  assert.ok(updated);
  assert.equal(updated!.players.length, 1);
  assert.equal(updated!.drawerId, GUESSER);
  assert.equal(updated!.strokes.length, 0);
  assert.equal(updated!.status, "choosing");
  assert.equal(updated!.secretWord, undefined);
});

test("a session token reconnects to the same seat", () => {
  const { game, room } = startedRoom();
  const seat = room.players.find((p) => p.id === GUESSER)!;
  seat.score = 250;
  room.guessed.add(GUESSER);
  const token = seat.sessionToken;
  const secret = room.secretWord;

  const result = game.resumeSession(room.code, token, "socket-new");
  if (!result.player) throw new Error("expected a player seat");
  assert.equal(result.player.id, "socket-new");
  assert.equal(result.player.score, 250);
  assert.equal(result.player.connected, true);
  assert.equal(room.guessed.has("socket-new"), true);
  assert.equal(room.guessed.has(GUESSER), false);
  assert.equal(game.playerRoom.get("socket-new"), room.code);
  assert.equal(game.playerRoom.get(GUESSER), undefined);
  assert.equal(room.players.length, 2);
  assert.equal(room.secretWord, secret);
  assert.equal(room.status, "drawing");
});

test("a disconnected drawer keeps the secret and unmasks nothing for guessers", () => {
  const { game, room } = startedRoom();
  const secret = room.secretWord!;
  game.markDisconnected(DRAWER);

  const guesserView = publicRoom(room, GUESSER);
  assert.equal(guesserView.secretWord, undefined);
  assert.equal(guesserView.maskedWord, "_".repeat(secret.length));
  assert.ok(!JSON.stringify(guesserView).includes(secret));

  const resumed = game.resumeSession(room.code, player(room, DRAWER).sessionToken, "socket-back");
  if (!resumed.player) throw new Error("expected a player seat");
  assert.equal(resumed.player.id, "socket-back");
  assert.equal(room.drawerId, "socket-back");
  assert.equal(publicRoom(room, "socket-back").secretWord, secret);
});

test("an invalid session token cannot take over a seat", () => {
  const { game, room } = startedRoom();
  expectCode(() => game.resumeSession(room.code, "not-a-real-token", "socket-x"), "INVALID_SESSION");
  expectCode(() => game.resumeSession("ZZZZZ", "not-a-real-token", "socket-x"), "ROOM_NOT_FOUND");
});
