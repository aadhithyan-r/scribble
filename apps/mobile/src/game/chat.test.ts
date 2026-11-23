import test from "node:test";
import assert from "node:assert/strict";
import { mergeChat } from "./chat";
import type { ChatMessage } from "./types";

const message = (id: string, at: number, text = id): ChatMessage => ({
  id,
  at,
  kind: "chat",
  playerId: "p1",
  name: "Player",
  text,
});

test("merging appends new messages in chronological order", () => {
  const merged = mergeChat([message("a", 1)], [message("b", 3), message("c", 2)]);
  assert.deepEqual(
    merged.map((m) => m.id),
    ["a", "c", "b"],
  );
});

test("duplicate messages from a room snapshot are de-duplicated by id", () => {
  const existing = [message("a", 1), message("b", 2)];
  const merged = mergeChat(existing, [message("b", 2), message("c", 3)]);
  assert.equal(merged.length, 3);
  assert.deepEqual(
    merged.map((m) => m.id),
    ["a", "b", "c"],
  );
});

test("merging an empty batch returns the same array", () => {
  const existing = [message("a", 1)];
  assert.equal(mergeChat(existing, []), existing);
});

test("history is capped to the newest messages", () => {
  const existing = Array.from({ length: 6 }, (_, index) => message(`m${index}`, index));
  const merged = mergeChat(existing, [message("latest", 99)], 3);
  assert.deepEqual(
    merged.map((m) => m.id),
    ["m4", "m5", "latest"],
  );
});

test("a newer version of the same message wins", () => {
  const merged = mergeChat([message("a", 1, "old")], [message("a", 1, "new")]);
  assert.equal(merged[0]!.text, "new");
});
