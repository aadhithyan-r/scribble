import test from "node:test";
import assert from "node:assert/strict";
import {
  appendPoints,
  applyClear,
  applyRedo,
  applyUndo,
  beginStroke,
  boardFromRoom,
  completeStroke,
  emptyBoard,
  shouldAdoptRoomBoard,
  type Board,
} from "./board";
import { normalizeTouch, shouldSamplePoint } from "./geometry";
import type { Stroke } from "../game/types";

const base = { seq: 0, color: "#112233", width: 6, tool: "pen" as const };

function withStroke(id = "stroke-1"): Board {
  return beginStroke(emptyBoard(), { id, ...base, point: { x: 0.1, y: 0.1 } });
}

test("beginStroke adds an open stroke and tracks undo depth", () => {
  const board = withStroke();
  assert.equal(board.strokes.length, 1);
  assert.equal(board.strokes[0]!.complete, false);
  assert.equal(board.undoDepth, 1);
  assert.equal(board.redoDepth, 0);

  // Duplicate ids are ignored (idempotent remote begin).
  const duplicate = beginStroke(board, { id: "stroke-1", ...base });
  assert.equal(duplicate, board);
});

test("appendPoints merges and de-duplicates points without mutating input", () => {
  const board = withStroke();
  const next = appendPoints(board, "stroke-1", [
    { x: 0.1, y: 0.1 },
    { x: 0.2, y: 0.2 },
    { x: 0.2, y: 0.2 },
    { x: 0.3, y: 0.3 },
  ]);
  assert.deepEqual(next.strokes[0]!.points, [
    { x: 0.1, y: 0.1 },
    { x: 0.2, y: 0.2 },
    { x: 0.3, y: 0.3 },
  ]);
  // Original board is untouched.
  assert.equal(board.strokes[0]!.points.length, 1);
  // No-op when nothing new is added or the id is unknown.
  assert.equal(appendPoints(next, "stroke-1", [{ x: 0.3, y: 0.3 }]), next);
  assert.equal(appendPoints(next, "missing", [{ x: 0.9, y: 0.9 }]), next);
});

test("completeStroke only affects the matching stroke", () => {
  const board = completeStroke(withStroke(), "stroke-1");
  assert.equal(board.strokes[0]!.complete, true);
  assert.equal(completeStroke(board, "stroke-1"), board);
  assert.equal(completeStroke(board, "missing"), board);
});

test("undo and redo follow the server's depths", () => {
  const board = withStroke();
  const undone = applyUndo(board, { strokeId: "stroke-1", undoDepth: 0, redoDepth: 1 });
  assert.equal(undone.strokes.length, 0);
  assert.equal(undone.undoDepth, 0);
  assert.equal(undone.redoDepth, 1);

  const stroke: Stroke = {
    id: "stroke-1",
    seq: 0,
    points: [{ x: 0.1, y: 0.1 }],
    color: "#112233",
    width: 6,
    tool: "pen",
    complete: true,
  };
  const redone = applyRedo(undone, { stroke, undoDepth: 1, redoDepth: 0 });
  assert.equal(redone.strokes.length, 1);
  assert.equal(redone.strokes[0]!.complete, true);
  assert.equal(redone.undoDepth, 1);

  // Replaying the same redo event twice must not duplicate strokes.
  assert.equal(applyRedo(redone, { stroke, undoDepth: 1, redoDepth: 0 }), redone);
});

test("clear empties the board", () => {
  const cleared = applyClear(withStroke(), { undoDepth: 0, redoDepth: 0 });
  assert.equal(cleared.strokes.length, 0);
});

test("boardFromRoom copies server strokes", () => {
  const room = {
    strokes: [
      {
        id: "s1",
        seq: 0,
        points: [{ x: 0.5, y: 0.5 }],
        color: "#000000",
        width: 4,
        tool: "pen" as const,
        complete: true,
      },
    ],
    undoDepth: 1,
    redoDepth: 2,
  };
  const board = boardFromRoom(room);
  assert.equal(board.strokes.length, 1);
  assert.deepEqual(board.strokes[0]!.points, [{ x: 0.5, y: 0.5 }]);
  assert.equal(board.redoDepth, 2);
});

test("room snapshots are adopted when they are ahead of the local board", () => {
  const board = withStroke();
  const stroke = board.strokes[0]!;

  // Same board: keep local (avoids clobbering points in flight).
  assert.equal(
    shouldAdoptRoomBoard(board, { status: "drawing", strokes: [stroke], boardVersion: 4 }),
    false,
  );
  // Server has more strokes.
  assert.equal(
    shouldAdoptRoomBoard(board, {
      status: "drawing",
      strokes: [stroke, { ...stroke, id: "stroke-2", seq: 1 }],
      boardVersion: 5,
    }),
    true,
  );
  // Not drawing any more (new round / game over).
  assert.equal(shouldAdoptRoomBoard(board, { status: "choosing", strokes: [], boardVersion: 9 }), true);
  // Same count but different ids (missed an undo).
  assert.equal(
    shouldAdoptRoomBoard(board, {
      status: "drawing",
      strokes: [{ ...stroke, id: "different" }],
      boardVersion: 6,
    }),
    true,
  );
});

test("touch coordinates are normalized and clamped", () => {
  assert.deepEqual(normalizeTouch(50, 25, 100, 50), { x: 0.5, y: 0.5 });
  assert.deepEqual(normalizeTouch(-20, 500, 100, 100), { x: 0, y: 1 });
  assert.deepEqual(normalizeTouch(10, 10, 0, 0), { x: 0, y: 0 });
});

test("points closer than the threshold are skipped", () => {
  assert.equal(shouldSamplePoint(undefined, { x: 0.4, y: 0.4 }), true);
  assert.equal(shouldSamplePoint({ x: 0.4, y: 0.4 }, { x: 0.4001, y: 0.4001 }), false);
  assert.equal(shouldSamplePoint({ x: 0.4, y: 0.4 }, { x: 0.5, y: 0.5 }), true);
});
