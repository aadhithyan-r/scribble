import test from "node:test";
import assert from "node:assert/strict";
import { Matchmaker } from "./matchmaking.js";
import { ValidationError } from "./validation.js";

const entry = (socketId: string, profileId = `p-${socketId}`) => ({
  socketId,
  profileId,
  name: socketId,
  avatar: "fox" as const,
  joinedAt: 1_000,
});

const expectCode = (fn: () => unknown, code: string) => {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof ValidationError);
    assert.equal(error.code, code);
    return true;
  });
};

test("matchmaking rejects duplicate sockets and profiles", () => {
  const mm = new Matchmaker({ minPlayers: 2, maxPlayers: 4, waitMs: 5_000 });
  mm.enqueue(entry("a"));
  expectCode(() => mm.enqueue(entry("a")), "ALREADY_QUEUED");
  expectCode(() => mm.enqueue(entry("b", "p-a")), "ALREADY_QUEUED");
  assert.equal(mm.size, 1);
});

test("a match only forms at the minimum size and respects the maximum", () => {
  const mm = new Matchmaker({ minPlayers: 3, maxPlayers: 4, waitMs: 5_000 });
  mm.enqueue(entry("a"));
  mm.enqueue(entry("b"));
  assert.equal(mm.takeMatch(), null);

  mm.enqueue(entry("c"));
  mm.enqueue(entry("d"));
  mm.enqueue(entry("e"));
  const first = mm.takeMatch()!;
  assert.deepEqual(first.map((item) => item.socketId), ["a", "b", "c", "d"]);
  assert.equal(mm.size, 1);
  assert.equal(mm.takeMatch(), null);
});

test("cancel and expiry remove players without forming rooms", () => {
  const mm = new Matchmaker({ minPlayers: 2, maxPlayers: 8, waitMs: 10_000 });
  mm.enqueue(entry("a"));
  mm.enqueue(entry("b"));
  assert.equal(mm.cancel("a"), true);
  assert.equal(mm.cancel("a"), false);
  assert.equal(mm.size, 1);

  assert.deepEqual(mm.expire(1_000 + 10_000).map((item) => item.socketId), ["b"]);
  assert.equal(mm.size, 0);
  assert.equal(mm.takeMatch(), null);
});

test("invalid matchmaking configuration is rejected", () => {
  expectCode(() => new Matchmaker({ minPlayers: 1 }), "INVALID_CONFIG");
  expectCode(() => new Matchmaker({ minPlayers: 4, maxPlayers: 2 }), "INVALID_CONFIG");
  expectCode(() => new Matchmaker({ waitMs: 500 }), "INVALID_CONFIG");
});
