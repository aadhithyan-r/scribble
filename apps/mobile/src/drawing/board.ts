import type { Point, RoomUpdate, Stroke, Tool } from "../game/types";

/**
 * Local mirror of the server's authoritative board. Every mutation here has a
 * matching server event; nothing is applied optimistically except the drawer's
 * own in-progress stroke (which the server validates on arrival).
 */
export type Board = {
  strokes: Stroke[];
  undoDepth: number;
  redoDepth: number;
};

export const emptyBoard = (): Board => ({ strokes: [], undoDepth: 0, redoDepth: 0 });

const cloneStroke = (stroke: Stroke, points?: Point[]): Stroke => ({
  ...stroke,
  points: points ?? stroke.points.map((p) => ({ x: p.x, y: p.y })),
});

export const boardFromRoom = (
  room: Pick<RoomUpdate, "strokes" | "undoDepth" | "redoDepth">,
): Board => ({
  strokes: room.strokes.map((stroke) => cloneStroke(stroke)),
  undoDepth: room.undoDepth,
  redoDepth: room.redoDepth,
});

export function beginStroke(
  board: Board,
  input: { id: string; seq: number; color: string; width: number; tool: Tool; point?: Point },
): Board {
  if (board.strokes.some((stroke) => stroke.id === input.id)) return board;
  const stroke: Stroke = {
    id: input.id,
    seq: input.seq,
    points: input.point ? [{ x: input.point.x, y: input.point.y }] : [],
    color: input.color,
    width: input.width,
    tool: input.tool,
    complete: false,
  };
  const strokes = [...board.strokes, stroke];
  return { strokes, undoDepth: strokes.length, redoDepth: 0 };
}

/**
 * Appends to the identified stroke. Points are de-duplicated against the
 * previous point so repeated touch samples do not inflate the history.
 */
export function appendPoints(board: Board, strokeId: string, points: Point[]): Board {
  const index = board.strokes.findIndex((stroke) => stroke.id === strokeId);
  if (index === -1 || points.length === 0) return board;

  const stroke = board.strokes[index]!;
  const merged = stroke.points.slice();
  for (const point of points) {
    const previous = merged[merged.length - 1];
    if (previous && previous.x === point.x && previous.y === point.y) continue;
    merged.push({ x: point.x, y: point.y });
  }
  if (merged.length === stroke.points.length) return board;

  const strokes = board.strokes.slice();
  strokes[index] = { ...stroke, points: merged };
  return { ...board, strokes };
}

export function completeStroke(board: Board, strokeId: string): Board {
  const index = board.strokes.findIndex((stroke) => stroke.id === strokeId);
  if (index === -1) return board;
  const stroke = board.strokes[index]!;
  if (stroke.complete) return board;
  const strokes = board.strokes.slice();
  strokes[index] = { ...stroke, complete: true };
  return { ...board, strokes };
}

export function applyUndo(
  board: Board,
  event: { strokeId: string; undoDepth: number; redoDepth: number },
): Board {
  const strokes = board.strokes.filter((stroke) => stroke.id !== event.strokeId);
  return { strokes, undoDepth: event.undoDepth, redoDepth: event.redoDepth };
}

export function applyRedo(
  board: Board,
  event: { stroke: Stroke; undoDepth: number; redoDepth: number },
): Board {
  if (board.strokes.some((stroke) => stroke.id === event.stroke.id)) return board;
  const strokes = [...board.strokes, cloneStroke(event.stroke)];
  return { strokes, undoDepth: event.undoDepth, redoDepth: event.redoDepth };
}

export function applyClear(
  board: Board,
  event: { undoDepth: number; redoDepth: number },
): Board {
  return { strokes: [], undoDepth: event.undoDepth, redoDepth: event.redoDepth };
}

/** True when the server snapshot should replace the local board mirror. */
export function shouldAdoptRoomBoard(
  board: Board,
  room: Pick<RoomUpdate, "status" | "strokes" | "boardVersion">,
) {
  if (room.status !== "drawing") return true;
  if (room.strokes.length > board.strokes.length) return true;
  if (room.strokes.length !== board.strokes.length) return false;
  return room.strokes.some((stroke, index) => stroke.id !== board.strokes[index]?.id);
}
