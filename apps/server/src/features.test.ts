import test from "node:test";
import assert from "node:assert/strict";
import { Game, GAME_LIMITS, publicRoom, type Room } from "./game.js";
import { isCloseGuess, levenshteinDistance } from "./close-guess.js";
import { sanitizeCustomWords } from "./custom-words.js";

const HOST = "socket-host";
const GUEST = "socket-guest";
const THIRD = "socket-third";

const expectCode = (fn: () => unknown, code: string) => {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { code?: string }).code, code);
    return true;
  });
};

function lobby() {
  const game = new Game();
  const room = game.createRoom(HOST, "Host");
  game.joinRoom(room.code, GUEST, "Guest");
  return { game, room };
}

function drawingRoom(word = "elephant", withThird = false): { game: Game; room: Room; word: string } {
  const { game, room } = lobby();
  if (withThird) game.joinRoom(room.code, THIRD, "Third");
  game.configure(room, HOST, {
    customWords: `${word}, tiger, zebra`,
    customWordsMode: "only",
  });
  game.start(room, HOST);
  assert.ok(room.wordChoices.includes(word));
  game.chooseWord(room, HOST, word);
  return { game, room, word };
}

test("levenshtein normalizes case and whitespace and detects useful near misses", () => {
  assert.equal(levenshteinDistance(" Kitten ", "kitten"), 0);
  assert.equal(levenshteinDistance("ICE   cream", "ice cream"), 0);
  assert.equal(levenshteinDistance("piza", "pizza"), 1);

  assert.equal(isCloseGuess("piza", "pizza"), true, "4-6 letters allow one edit");
  assert.equal(isCloseGuess("elephnat", "elephant"), true, "long words allow two edits");
  assert.equal(isCloseGuess("icecream", "ice cream"), true, "spaces are ignored");
  assert.equal(isCloseGuess("lion", "pizza"), false, "unrelated words are not close");
  assert.equal(isCloseGuess("cot", "cat"), false, "words under 4 letters are ignored");
  assert.equal(isCloseGuess("pizza", "pizza"), false, "an exact match is handled as correct");
});

test("a typo during the drawing phase is marked close without scoring", () => {
  const { game, room } = drawingRoom();
  const before = room.players.find((player) => player.id === GUEST)!.score;
  const result = game.guess(room, GUEST, "elephnat");
  assert.deepEqual(result, { correct: false, close: true });
  assert.equal(room.players.find((player) => player.id === GUEST)!.score, before);
  assert.deepEqual(game.guess(room, GUEST, "zzzzzz"), { correct: false });
});

test("custom packs are sanitized, deduplicated and capped", () => {
  const words = sanitizeCustomWords(
    " Pizza,  ice   cream\npizza, taco, x, bad!, burger, Pizza ",
  );
  assert.deepEqual(words, ["Pizza", "ice cream", "taco", "burger"]);

  const capped = sanitizeCustomWords(
    Array.from({ length: 130 }, (_, index) => `word${index}`).join(","),
  );
  assert.equal(capped.length, 100);
});

test("custom packs support off, mix and only pool selection with privacy", () => {
  const { game, room } = lobby();
  game.configure(room, HOST, {
    customWords: "alpha, beta, gamma, delta",
    customWordsMode: "mix",
    wordMode: "category",
    wordCategory: "animals",
  });

  const mixed = game.wordPoolFor(room);
  assert.equal(mixed.length, 45 + 4);
  for (const word of ["alpha", "beta", "gamma", "delta"]) assert.ok(mixed.includes(word));

  game.configure(room, HOST, { customWordsMode: "off" });
  assert.equal(game.wordPoolFor(room).length, 45);
  assert.equal(game.wordPoolFor(room).includes("alpha"), false);

  game.configure(room, HOST, { customWordsMode: "only" });
  assert.deepEqual(game.wordPoolFor(room), ["alpha", "beta", "gamma", "delta"]);

  const hostView = publicRoom(room, HOST) as ReturnType<typeof publicRoom> & {
    customWords?: string[];
  };
  const guestView = publicRoom(room, GUEST) as ReturnType<typeof publicRoom> & {
    customWords?: string[];
  };
  assert.deepEqual(hostView.customWords, ["alpha", "beta", "gamma", "delta"]);
  assert.equal(guestView.customWords, undefined);
  assert.equal(guestView.customWordsMode, "only");
  assert.equal(guestView.customWordCount, 4);

  game.start(room, HOST);
  assert.equal(room.wordChoices.every((word) => game.wordPoolFor(room).includes(word)), true);
});

test("custom-only mode rejects a pack with fewer than three words", () => {
  const { game, room } = lobby();
  game.configure(room, HOST, { customWords: "one, two", customWordsMode: "only" });
  expectCode(() => game.start(room, HOST), "INVALID_CONFIG");
});

test("reactions allow one vote per player and pay the drawer crowd bonus once", () => {
  const { game, room } = drawingRoom("elephant", true);

  const first = game.react(room, GUEST, "like");
  assert.equal(first.duplicate, false);
  const duplicate = game.react(room, GUEST, "nope");
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.reaction, "like");
  assert.equal(duplicate.likes, 1);
  assert.equal(duplicate.nopes, 0);
  expectCode(() => game.react(room, HOST, "like"), "CANT_REACT");

  assert.deepEqual(room.reactions.size, 1);
  const drawerBefore = room.players.find((player) => player.id === HOST)!.score;
  game.nextTurn(room);

  assert.equal(room.players.find((player) => player.id === HOST)!.score, drawerBefore + GAME_LIMITS.reactionBonus);
  assert.equal(room.lastTurnSummary?.likes, 1);
  assert.equal(room.lastTurnSummary?.nopes, 0);
  assert.equal(room.lastTurnSummary?.reactionBonus, 20);
  assert.equal(room.drawingGallery.length, 1);
  assert.equal(room.drawingGallery[0]?.word, "elephant");
  assert.equal(room.reactions.size, 0, "votes reset for the next turn");
});

test("a split crowd vote does not award the bonus", () => {
  const { game, room } = drawingRoom("elephant", true);
  game.react(room, GUEST, "like");
  game.react(room, THIRD, "nope");
  const drawerBefore = room.players.find((player) => player.id === HOST)!.score;
  game.nextTurn(room);
  assert.equal(room.players.find((player) => player.id === HOST)!.score, drawerBefore);
  assert.equal(room.lastTurnSummary?.reactionBonus, 0);
});
