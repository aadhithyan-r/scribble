import type { FillRun, Point, RoomUpdate, Stroke, StrokeKind, Tool } from "../game/types";

/**
 * Local mirror of the server's authoritative board. Every mutation here has a
 * matching server event; nothing is applied optimistically except the drawer's
 * own in-progress action (which the server validates on arrival).
 */
export type Board = {
  strokes: Stroke[];
  undoDepth: number;
  redoDepth: number;
};

export const emptyBoard = (): Board => ({ strokes: [], undoDepth: 0, redoDepth: 0 });

const cloneStroke = (stroke: Stroke, points?: Point[]): Stroke => ({
  ...stroke,
  points: points ?? (stroke.points ?? []).map((p) => ({ x: p.x, y: p.y })),
  ...(stroke.runs ? { runs: stroke.runs.map((run) => ({ ...run })) } : {}),
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
    kind: "stroke",
  };
  const strokes = [...board.strokes, stroke];
  return { strokes, undoDepth: strokes.length, redoDepth: 0 };
}

/** Appends a committed line / rect / ellipse action to the local board. */
export function addShape(
  board: Board,
  input: {
    id: string;
    seq?: number;
    kind: Extract<StrokeKind, "line" | "rect" | "ellipse">;
    color: string;
    width: number;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  },
): Board {
  if (board.strokes.some((stroke) => stroke.id === input.id)) return board;
  const stroke: Stroke = {
    id: input.id,
    seq: input.seq ?? board.strokes.length,
    points: [],
    color: input.color,
    width: input.width,
    tool: "pen",
    complete: true,
    kind: input.kind,
    x1: input.x1,
    y1: input.y1,
    x2: input.x2,
    y2: input.y2,
  };
  const strokes = [...board.strokes, stroke];
  return { strokes, undoDepth: strokes.length, redoDepth: 0 };
}

/** Appends a flood-fill action (scanline runs) to the local board. */
export function addFill(
  board: Board,
  input: { id: string; seq?: number; color: string; runs: FillRun[] },
): Board {
  if (board.strokes.some((stroke) => stroke.id === input.id)) return board;
  const stroke: Stroke = {
    id: input.id,
    seq: input.seq ?? board.strokes.length,
    points: [],
    color: input.color,
    width: 1,
    tool: "pen",
    complete: true,
    kind: "fill",
    runs: input.runs.map((run) => ({ ...run })),
  };
  const strokes = [...board.strokes, stroke];
  return { strokes, undoDepth: strokes.length, redoDepth: 0 };
}

/** Appends a clear marker so Undo can restore every previous action. */
export function addClear(board: Board, action: Stroke): Board {
  if (board.strokes.some((stroke) => stroke.id === action.id)) return board;
  const strokes = [...board.strokes, { ...action, points: [], complete: true, kind: "clear" as const }];
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

/**
 * New servers send the clear action so it stays in history (undoable).
 * Legacy servers send no action, in which case the board is wiped.
 */
export function applyClear(
  board: Board,
  event: { undoDepth: number; redoDepth: number; action?: Stroke },
): Board {
  if (event.action) {
    return addClear(board, event.action);
  }
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
