import test from "node:test";
import assert from "node:assert/strict";
import { Game, publicRoom } from "./game.js";
import {
  CURATED_CATEGORIES,
  CURATED_CATEGORY_IDS,
  CURATED_WORD_POOL,
  CURATED_WORDS_BY_CATEGORY,
  type CuratedCategoryId,
} from "./words.js";

const HOST = "socket-host";
const GUEST = "socket-guest";

function startedRoom(
  options: {
    wordMode?: "random" | "category";
    wordCategory?: CuratedCategoryId | null;
  },
  maxRounds = 5,
) {
  const game = new Game();
  const room = game.createRoom(HOST, "Host", "profile-host", "fox", options);
  game.joinRoom(room.code, GUEST, "Guest");
  game.configure(room, HOST, { maxRounds });
  game.start(room, HOST);
  return { game, room };
}

test("curated dictionary has five categories of exactly 45 unique words", () => {
  assert.equal(CURATED_CATEGORIES.length, 5);
  assert.deepEqual(
    CURATED_CATEGORIES.map((category) => category.id),
    [...CURATED_CATEGORY_IDS],
  );
  assert.deepEqual(
    CURATED_CATEGORIES.map((category) => category.label),
    ["ANIMALS", "FOOD & DRINKS", "OBJECTS & TECH", "PLACES & NATURE", "ACTIONS & SPORTS"],
  );

  const allWords: string[] = [];
  for (const category of CURATED_CATEGORIES) {
    assert.equal(category.words.length, 45, `${category.id} must have 45 words`);
    assert.equal(
      new Set(category.words).size,
      category.words.length,
      `${category.id} contains a duplicate`,
    );
    for (const word of category.words) {
      assert.equal(word, word.trim());
      assert.ok(word.length > 0);
      allWords.push(word);
    }
  }

  assert.equal(allWords.length, 225);
  assert.equal(new Set(allWords).size, 225, "words must be unique across all categories");
  assert.equal(CURATED_WORD_POOL.length, 225);
});

test("random mode draws unique words across multiple categories", () => {
  const { game, room } = startedRoom({ wordMode: "random" });
  const offered = new Set<string>();
  const categories = new Set<CuratedCategoryId>();

  for (let turn = 0; turn < 10; turn += 1) {
    assert.equal(room.status, "choosing");
    assert.equal(room.wordChoices.length, 3);
    assert.equal(new Set(room.wordChoices).size, 3);

    for (const word of room.wordChoices) {
      assert.ok(CURATED_WORD_POOL.includes(word));
      assert.equal(offered.has(word), false, `${word} was offered twice`);
      offered.add(word);
      const category = CURATED_CATEGORIES.find((entry) => entry.words.includes(word));
      assert.ok(category);
      categories.add(category.id);
    }

    game.chooseWord(room, room.drawerId!, room.wordChoices[0]!);
    game.nextTurn(room);
  }

  assert.ok(offered.size >= 30);
  assert.ok(categories.size > 1, "random mode should span more than one category");
  const guestView = publicRoom(room, GUEST);
  assert.equal(guestView.wordMode, "random");
  assert.equal(guestView.wordCategory, null);
});

test("category mode draws strictly from the selected category without repeats", () => {
  const { game, room } = startedRoom({ wordMode: "category", wordCategory: "food" });
  const offered = new Set<string>();

  for (let turn = 0; turn < 10; turn += 1) {
    assert.equal(room.status, "choosing");
    assert.equal(room.wordChoices.length, 3);
    assert.equal(new Set(room.wordChoices).size, 3);
    for (const word of room.wordChoices) {
      assert.ok(CURATED_WORDS_BY_CATEGORY.food.includes(word));
      assert.equal(offered.has(word), false, `${word} was offered twice`);
      offered.add(word);
    }
    game.chooseWord(room, room.drawerId!, room.wordChoices[0]!);
    game.nextTurn(room);
  }

  assert.equal(offered.size, 30);
  const guestView = publicRoom(room, GUEST);
  assert.equal(guestView.wordMode, "category");
  assert.equal(guestView.wordCategory, "food");
});

test("word settings validate, default to animals, and clear in random mode", () => {
  const game = new Game();
  const room = game.createRoom(HOST, "Host", "profile-host", "fox");
  game.joinRoom(room.code, GUEST, "Guest");

  assert.equal(room.wordMode, "random");
  assert.equal(room.wordCategory, null);

  game.configure(room, HOST, { wordMode: "category" });
  assert.equal(room.wordMode, "category");
  assert.equal(room.wordCategory, "animals");

  game.configure(room, HOST, { wordCategory: "places" });
  assert.equal(room.wordMode, "category");
  assert.equal(room.wordCategory, "places");

  game.configure(room, HOST, { wordMode: "random" });
  assert.equal(room.wordMode, "random");
  assert.equal(room.wordCategory, null);

  assert.throws(
    () => game.configure(room, GUEST, { wordMode: "category" }),
    (error: unknown) =>
      error instanceof Error && (error as { code?: string }).code === "NOT_HOST",
  );
  game.configure(room, HOST, { wordMode: "category", wordCategory: "objects" });
  assert.throws(
    () => game.configure(room, HOST, { wordCategory: "not-real" as never }),
    (error: unknown) =>
      error instanceof Error && (error as { code?: string }).code === "INVALID_CONFIG",
  );
  // A rejected patch must not leave the room half-updated.
  assert.equal(room.wordMode, "category");
  assert.equal(room.wordCategory, "objects");
});

test("an exhausted category pool resets cleanly for the next turn", () => {
  const { game, room } = startedRoom(
    { wordMode: "category", wordCategory: "animals" },
    10,
  );

  const offered = new Set<string>();
  for (let turn = 0; turn < 15; turn += 1) {
    for (const word of room.wordChoices) offered.add(word);
    game.chooseWord(room, room.drawerId!, room.wordChoices[0]!);
    game.nextTurn(room);
  }

  // 15 turns x 3 offers exhaust all 45 animals; the next turn starts a fresh pass.
  assert.equal(offered.size, 45);
  assert.equal(room.status, "choosing");
  assert.equal(room.wordChoices.length, 3);
  assert.equal(new Set(room.wordChoices).size, 3);
  assert.equal(room.usedWords.size, 3);
  for (const word of room.wordChoices) {
    assert.ok(CURATED_WORDS_BY_CATEGORY.animals.includes(word));
  }
});
