import test from "node:test";
import assert from "node:assert/strict";
import { Game, GameError, GAME_LIMITS, publicRoom, type Room } from "./game.js";
import { ValidationError } from "./validation.js";

const HOST = "socket-host";
const GUEST = "socket-guest";
const THIRD = "socket-third";
const WATCHER = "socket-watcher";

const expectCode = (fn: () => unknown, code: string) => {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof GameError, `expected GameError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
};

const expectValidation = (fn: () => unknown, code: string) => {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof ValidationError);
    assert.equal(error.code, code);
    return true;
  });
};

function lobby() {
  const game = new Game();
  const room = game.createRoom(HOST, "Host");
  game.joinRoom(room.code, GUEST, "Guest");
  return { game, room };
}

function started(): { game: Game; room: Room; word: string } {
  const ctx = lobby();
  ctx.game.start(ctx.room, HOST);
  const word = ctx.room.wordChoices[0]!;
  ctx.game.chooseWord(ctx.room, HOST, word);
  return { ...ctx, word };
}

const foodWords = ["pizza", "sushi", "tacos", "burger"];

test("custom words are validated, host-only and never public", () => {
  const { game, room } = lobby();
  const categories = [{ name: "Food", words: foodWords }];

  expectCode(() => game.setCategories(room, GUEST, categories), "NOT_HOST");
  expectValidation(() => game.setCategories(room, HOST, [{ name: "Bad", words: ["fuck"] }]), "INVALID_WORDS");
  expectValidation(() => game.setCategories(room, HOST, [{ name: "Bad", words: ["word1"] }]), "INVALID_WORDS");

  game.setCategories(room, HOST, categories);
  const guestView = publicRoom(room, GUEST);
  assert.equal(guestView.customWordCount, 4);
  assert.deepEqual(guestView.customCategories, ["Food"]);
  assert.equal(
    foodWords.some((word) => JSON.stringify(guestView).includes(word)),
    false,
    "custom words must stay private",
  );

  game.configure(room, HOST, { customWordsEnabled: true });
  game.start(room, HOST);
  assert.equal(room.wordChoices.every((word) => foodWords.includes(word)), true);
  assert.equal(publicRoom(room, GUEST).wordChoices, undefined);

  game.chooseWord(room, HOST, room.wordChoices[0]!);
  assert.equal(publicRoom(room, GUEST).secretWord, undefined);
  assert.equal(publicRoom(room, HOST).secretWord, room.secretWord);
});

test("custom words cannot be enabled without enough words", () => {
  const { game, room } = lobby();
  game.setCategories(room, HOST, [{ name: "Tiny", words: ["pizza", "sushi"] }]);
  expectCode(() => game.configure(room, HOST, { customWordsEnabled: true }), "INVALID_CONFIG");
  room.customWordsEnabled = true; // defensive start-time check
  expectCode(() => game.start(room, HOST), "INVALID_CONFIG");
  room.customWordsEnabled = false;
  game.start(room, HOST);
  assert.equal(room.status, "choosing");
});

test("room configuration is host-only, lobby-only and bounded", () => {
  const { game, room } = lobby();
  expectCode(() => game.configure(room, GUEST, { maxRounds: 2 }), "NOT_HOST");
  game.configure(room, HOST, {
    maxRounds: 5,
    drawSeconds: 45,
    maxPlayers: 4,
    allowSpectators: false,
    requireInvite: true,
  });
  assert.equal(room.maxRounds, 5);
  assert.equal(room.drawSeconds, 45);
  assert.equal(room.maxPlayers, 4);
  assert.equal(room.allowSpectators, false);
  assert.equal(room.requireInvite, true);

  expectCode(() => game.configure(room, HOST, { maxPlayers: 1 }), "INVALID_CONFIG");
  expectCode(() => game.configure(room, HOST, { drawSeconds: 5 }), "INVALID_CONFIG");
  expectCode(() => game.configure(room, HOST, { maxRounds: 99 }), "INVALID_CONFIG");

  game.configure(room, HOST, 3); // Phase 3 number form still works
  assert.equal(room.maxRounds, 3);
  game.start(room, HOST);
  expectCode(() => game.configure(room, HOST, { maxRounds: 4 }), "WRONG_PHASE");
  assert.equal(room.drawSeconds, 45);
});

test("invite tokens gate access and the deep link carries the secret", () => {
  const { game, room } = lobby();
  game.configure(room, HOST, { requireInvite: true });
  assert.equal(room.inviteToken.length, 48);
  assert.equal(room.requireInvite, true);

  expectCode(() => game.joinRoom(room.code, THIRD, "Third"), "INVALID_INVITE");
  expectCode(() => game.joinRoom(room.code, THIRD, "Third", { invite: "0".repeat(48) }), "INVALID_INVITE");
  const joined = game.joinRoom(room.code, THIRD, "Third", { invite: room.inviteToken });
  assert.equal(joined.spectator, false);
  assert.equal(room.players.length, 3);

  const invite = game.inviteFor(room, HOST);
  assert.equal(invite.code, room.code);
  assert.equal(invite.inviteToken, room.inviteToken);
  assert.ok(invite.deepLink.includes(room.inviteToken));
  expectCode(() => game.inviteFor(room, GUEST), "NOT_HOST");
});

test("room size is configurable and enforced", () => {
  const { game, room } = lobby();
  game.configure(room, HOST, { maxPlayers: 2 });
  expectCode(() => game.joinRoom(room.code, THIRD, "Third"), "ROOM_FULL");
  game.configure(room, HOST, { maxPlayers: 3 });
  assert.equal(game.joinRoom(room.code, THIRD, "Third").spectator, false);
  assert.equal(room.players.length, 3);
});

test("spectators watch without guessing, drawing or affecting the turn", () => {
  const { game, room, word } = started();
  const drawerBefore = room.drawerId;
  const joined = game.joinRoom(room.code, WATCHER, "Watcher", { profileId: "profile-watcher" });
  assert.equal(joined.spectator, true);
  assert.equal(room.spectators.length, 1);
  assert.equal(room.players.length, 2);

  const view = publicRoom(room, WATCHER);
  assert.equal(view.isSpectator, true);
  assert.equal(view.secretWord, undefined);
  assert.equal(view.wordChoices, undefined);
  assert.ok(!JSON.stringify(view).includes(word));

  // A spectator's text is never evaluated as a guess.
  assert.deepEqual(game.guess(room, WATCHER, word), { correct: false });
  assert.equal(
    room.players.reduce((total, player) => total + player.score, 0),
    0,
  );
  expectCode(
    () => game.beginStroke(room, WATCHER, { id: "watcher-stroke", color: "#123456", width: 6, tool: "pen" }),
    "NOT_DRAWER",
  );

  // The turn rotation only considers real players.
  game.nextTurn(room);
  assert.notEqual(room.drawerId, WATCHER);
  assert.notEqual(room.drawerId, drawerBefore);
  	assert.equal(publicRoom(room, WATCHER).isDrawer, false);
});

test("spectators can be disabled for a room", () => {
  const fresh = lobby();
  fresh.game.configure(fresh.room, HOST, { allowSpectators: false });
  fresh.game.start(fresh.room, HOST);
  expectCode(() => fresh.game.joinRoom(fresh.room.code, THIRD, "Third"), "GAME_STARTED");
});

test("kick removes a seat, ban blocks rejoin, and the host is protected", () => {
  const { game, room } = lobby();
  const guestProfile = room.players.find((player) => player.id === GUEST)!.profileId;
  expectCode(() => game.kick(room, GUEST, HOST), "NOT_HOST");
  expectCode(() => game.kick(room, HOST, HOST), "CANT_MODERATE");

  game.kick(room, HOST, GUEST);
  assert.equal(room.players.length, 1);
  assert.equal(game.playerRoom.get(GUEST), undefined);
  assert.equal(game.joinRoom(room.code, GUEST, "Guest").spectator, false);

  const second = game.joinRoom(room.code, THIRD, "Third").room.players.find((p) => p.id === THIRD)!;
  assert.equal(second.profileId, THIRD);
  game.kick(room, HOST, THIRD, true);
  assert.equal(room.bannedProfileIds.has(THIRD), true);
  expectCode(
    () => game.joinRoom(room.code, THIRD, "Third", { profileId: THIRD }),
    "BANNED",
  );
  assert.equal(room.bannedProfileIds.has(guestProfile), false);
});

test("kicking the drawer hands the turn to the remaining player", () => {
  const { game, room } = started();
  expectCode(() => game.kick(room, HOST, HOST), "CANT_MODERATE");

  // Rotate so the drawer is the guest, then kick that drawer.
  game.nextTurn(room);
  assert.equal(room.drawerId, GUEST);
  game.chooseWord(room, GUEST, room.wordChoices[0]!);
  game.kick(room, HOST, GUEST);

  assert.equal(room.players.length, 1);
  assert.equal(room.drawerId, HOST);
  assert.equal(room.status, "choosing");
});

test("mute is host-only and tracked per profile", () => {
  const { game, room } = lobby();
  expectCode(() => game.mute(room, GUEST, HOST, true), "NOT_HOST");
  expectCode(() => game.mute(room, HOST, HOST, true), "CANT_MODERATE");
  expectCode(() => game.mute(room, HOST, "missing", true), "NOT_IN_ROOM");

  game.mute(room, HOST, GUEST, true);
  assert.equal(game.isMuted(room, GUEST), true);
  assert.equal(game.isMuted(room, HOST), false);
  game.mute(room, HOST, GUEST, false);
  assert.equal(game.isMuted(room, GUEST), false);
});

test("guess attempts are counted for accuracy statistics", () => {
  const { game, room, word } = started();
  game.guess(room, GUEST, "wrong");
  game.guess(room, GUEST, "definitely wrong");
  game.guess(room, GUEST, word);
  const guest = room.players.find((player) => player.id === GUEST)!;
  assert.equal(guest.guesses, 3);
  assert.equal(guest.correctGuesses, 1);
  assert.equal(room.players.find((player) => player.id === HOST)!.guesses, 0);
});

test("a finished game stamps its end time for match recording", () => {
  const { game, room, word } = started();
  room.maxRounds = 1;
  game.guess(room, GUEST, word);
  game.nextTurn(room); // guest's turn
  game.nextTurn(room); // wraps to the first player: round 2 > 1
  assert.equal(room.status, "ended");
  assert.ok(room.endedAt);
  assert.equal(room.matchRecorded, false);
  assert.equal(room.secretWord, undefined);
  assert.equal(room.wordChoices.length, 0);
});

test("GAME_LIMITS exposes the Phase 4 bounds used by the socket schemas", () => {
  assert.equal(GAME_LIMITS.minPlayers, 2);
  assert.equal(GAME_LIMITS.maxSpectators, 12);
  assert.equal(GAME_LIMITS.minDrawSeconds, 30);
  assert.equal(GAME_LIMITS.maxDrawSeconds, 180);
  assert.equal(GAME_LIMITS.minCustomWords, 3);
});
