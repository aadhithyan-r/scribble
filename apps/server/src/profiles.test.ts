import test from "node:test";
import assert from "node:assert/strict";
import { ProfileStore } from "./profiles.js";
import { ValidationError } from "./validation.js";

test("identity is stable behind a hashed token and names are validated", () => {
  const store = new ProfileStore();
  const first = store.identify(undefined, "Alice", "panda");
  assert.equal(first.profile.name, "Alice");
  assert.equal(first.profile.avatar, "panda");
  assert.equal(first.profile.stats.gamesPlayed, 0);
  assert.equal(store.identityCount(), 1);

  const resumed = store.identify(first.token, "Ignored", "robot");
  assert.equal(resumed.profile.id, first.profile.id);
  assert.equal(resumed.profile.name, "Alice");
  assert.equal(store.identityCount(), 1);

  assert.throws(
    () => store.identify(undefined, "you idiot", undefined),
    (error: unknown) => error instanceof ValidationError && error.code === "INVALID_NAME",
  );

  const updated = store.update(first.profile.id, { name: "Alice B", avatar: "cat" });
  assert.equal(updated.name, "Alice B");
  assert.equal(updated.avatar, "cat");
});

test("matches update wins, points, accuracy and history", () => {
  const store = new ProfileStore();
  const alice = store.identify(undefined, "Alice", "fox").profile;
  const bob = store.identify(undefined, "Bob", "robot").profile;

  const match = store.recordMatch({
    roomCode: "ABCDE",
    rounds: 2,
    players: [
      { profileId: alice.id, name: alice.name, avatar: alice.avatar, score: 300, guesses: 4, correctGuesses: 3 },
      { profileId: bob.id, name: bob.name, avatar: bob.avatar, score: 120, guesses: 5, correctGuesses: 2 },
    ],
  });

  assert.equal(match.players[0]!.rank, 1);
  assert.equal(match.players[0]!.won, true);
  assert.equal(match.players[1]!.rank, 2);
  assert.deepEqual(match.winners, [alice.id]);

  const aliceView = store.view(alice.id)!;
  assert.equal(aliceView.profile.stats.gamesPlayed, 1);
  assert.equal(aliceView.profile.stats.gamesWon, 1);
  assert.equal(aliceView.profile.stats.totalPoints, 300);
  assert.equal(aliceView.accuracy, 75);
  assert.equal(aliceView.history[0]!.id, match.id);

  const bobView = store.view(bob.id)!;
  assert.equal(bobView.profile.stats.gamesPlayed, 1);
  assert.equal(bobView.profile.stats.gamesWon, 0);
  assert.equal(bobView.accuracy, 40);

  const board = store.leaderboard();
  assert.equal(board[0]!.profileId, alice.id);
  assert.equal(board[0]!.wins, 1);
  assert.equal(board[1]!.profileId, bob.id);
});

test("ties share first place and empty matches are harmless", () => {
  const store = new ProfileStore();
  const alice = store.identify(undefined, "Alice", "fox").profile;
  const bob = store.identify(undefined, "Bob", "robot").profile;
  const match = store.recordMatch({
    roomCode: "ABCDE",
    rounds: 1,
    players: [
      { profileId: alice.id, name: alice.name, avatar: alice.avatar, score: 100, guesses: 1, correctGuesses: 1 },
      { profileId: bob.id, name: bob.name, avatar: bob.avatar, score: 100, guesses: 1, correctGuesses: 1 },
    ],
  });
  assert.equal(match.players.every((player) => player.rank === 1), true);
  assert.equal(match.winners.length, 2);
  assert.equal(store.view(alice.id)!.profile.stats.gamesWon, 1);
  assert.equal(store.view(bob.id)!.profile.stats.gamesWon, 1);

  assert.doesNotThrow(() =>
    store.recordMatch({ roomCode: "ZZZZZ", rounds: 1, players: [] }),
  );
  assert.equal(store.leaderboard().length, 2);
});
