import React, { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  StyleSheet,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
} from "react-native";
import { Canvas, Circle, Path, Skia } from "@shopify/react-native-skia";
import type { DrawTool, FillRun, Point, Stroke } from "../game/types";
import { normalizeTouch, shouldSamplePoint } from "../drawing/geometry";
import { floodFillRuns, rasterize, sampleColor } from "../drawing/raster";

/** Widths are authored in the 1000 x 750 canvas space and scaled per device. */
const WIDTH_REFERENCE = 1000;

type Callbacks = {
  onBegin: (id: string, point: Point) => void;
  onPoints: (id: string, points: Point[]) => void;
  onEnd: (id: string) => void;
  onShape: (
    id: string,
    kind: "line" | "rect" | "ellipse",
    start: Point,
    end: Point,
  ) => void;
  onFill: (runs: FillRun[], color: string) => void;
  onPickColor: (color: string) => void;
};

type Props = {
  strokes: Stroke[];
  editable: boolean;
  /** Explicit 4:3 size so every device shares one coordinate space. */
  width?: number;
  tool?: DrawTool;
  color?: string;
  size?: number;
} & Partial<Callbacks>;

export function buildStrokePath(points: Point[], canvasWidth: number, canvasHeight: number) {
  const path = Skia.Path.Make();
  if (points.length < 2 || canvasWidth <= 0 || canvasHeight <= 0) return path;

  const first = points[0]!;
  path.moveTo(first.x * canvasWidth, first.y * canvasHeight);
  // Quadratic smoothing through segment midpoints removes the polyline look
  // without needing the full raw touch stream on other devices.
  for (let index = 1; index < points.length - 1; index += 1) {
    const current = points[index]!;
    const next = points[index + 1]!;
    path.quadTo(
      current.x * canvasWidth,
      current.y * canvasHeight,
      ((current.x + next.x) / 2) * canvasWidth,
      ((current.y + next.y) / 2) * canvasHeight,
    );
  }
  const last = points[points.length - 1]!;
  path.lineTo(last.x * canvasWidth, last.y * canvasHeight);
  return path;
}

const widthFor = (width: number, canvasWidth: number) =>
  Math.max(1, (width * canvasWidth) / WIDTH_REFERENCE);

const StrokeShape = memo(function StrokeShape({
  stroke,
  canvasWidth,
  canvasHeight,
}: {
  stroke: Stroke;
  canvasWidth: number;
  canvasHeight: number;
}) {
  const path = useMemo(
    () => buildStrokePath(stroke.points ?? [], canvasWidth, canvasHeight),
    [stroke.points, canvasWidth, canvasHeight],
  );
  const points = stroke.points ?? [];
  if (points.length === 0) return null;
  if (points.length === 1) {
    const point = points[0]!;
    return (
      <Circle
        cx={point.x * canvasWidth}
        cy={point.y * canvasHeight}
        r={widthFor(stroke.width, canvasWidth) / 2}
        color={stroke.color}
      />
    );
  }
  return (
    <Path
      path={path}
      color={stroke.color}
      style="stroke"
      strokeWidth={widthFor(stroke.width, canvasWidth)}
      strokeCap="round"
      strokeJoin="round"
    />
  );
});

const FillShape = memo(function FillShape({
  stroke,
  canvasWidth,
  canvasHeight,
}: {
  stroke: Stroke;
  canvasWidth: number;
  canvasHeight: number;
}) {
  const path = useMemo(() => {
    const built = Skia.Path.Make();
    for (const run of stroke.runs ?? []) {
      built.addRect(
        Skia.XYWHRect(
          run.x * canvasWidth,
          run.y * canvasHeight,
          run.w * canvasWidth + 0.6,
          run.h * canvasHeight + 0.6,
        ),
      );
    }
    return built;
  }, [stroke.runs, canvasWidth, canvasHeight]);
  return <Path path={path} color={stroke.color} />;
});

const ShapeMark = memo(function ShapeMark({
  kind,
  x1,
  y1,
  x2,
  y2,
  color,
  width,
  canvasWidth,
  canvasHeight,
  opacity = 1,
}: {
  kind: "line" | "rect" | "ellipse";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  width: number;
  canvasWidth: number;
  canvasHeight: number;
  opacity?: number;
}) {
  const path = useMemo(() => {
    const built = Skia.Path.Make();
    const ax = x1 * canvasWidth;
    const ay = y1 * canvasHeight;
    const bx = x2 * canvasWidth;
    const by = y2 * canvasHeight;
    if (kind === "line") {
      built.moveTo(ax, ay);
      built.lineTo(bx, by);
    } else if (kind === "rect") {
      built.addRect(Skia.XYWHRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay)));
    } else {
      built.addOval(Skia.XYWHRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay)));
    }
    return built;
  }, [kind, x1, y1, x2, y2, canvasWidth, canvasHeight]);

  return (
    <Path
      path={path}
      color={color}
      opacity={opacity}
      style="stroke"
      strokeWidth={widthFor(width, canvasWidth)}
      strokeCap="round"
      strokeJoin="round"
    />
  );
});

const makeId = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

const isShapeTool = (value: DrawTool) =>
  value === "line" || value === "rect" || value === "circle";
const shapeKind = (value: DrawTool): "line" | "rect" | "ellipse" =>
  value === "circle" ? "ellipse" : value === "rect" ? "rect" : "line";

export default function DrawingCanvas({
  strokes,
  editable,
  width,
  tool = "brush",
  color = "#000000",
  size = 10,
  onBegin,
  onPoints,
  onEnd,
  onShape,
  onFill,
  onPickColor,
}: Props) {
  const [measured, setMeasured] = useState({ width: 0, height: 0 });
  const [ring, setRing] = useState<Point | null>(null);
  const [preview, setPreview] = useState<{
    kind: "line" | "rect" | "ellipse";
    start: Point;
    end: Point;
  } | null>(null);

  const strokeIdRef = useRef<string | null>(null);
  const lastPointRef = useRef<Point | undefined>(undefined);
  const pendingRef = useRef<Point[]>([]);
  const frameRef = useRef<number | null>(null);
  const startRef = useRef<Point | null>(null);
  const tapRef = useRef<Point | null>(null);
  const callbacksRef = useRef<Partial<Callbacks>>({ onBegin, onPoints, onEnd, onShape, onFill, onPickColor });
  callbacksRef.current = { onBegin, onPoints, onEnd, onShape, onFill, onPickColor };

  // Clear markers reset everything before them so the visible board matches
  // the server's action history.
  const visible = useMemo(() => {
    const out: Stroke[] = [];
    for (const action of strokes) {
      if (action.kind === "clear") out.length = 0;
      else out.push(action);
    }
    return out;
  }, [strokes]);

  const flushFrame = () => {
    frameRef.current = null;
    const id = strokeIdRef.current;
    const points = pendingRef.current;
    if (!id || points.length === 0) return;
    pendingRef.current = [];
    callbacksRef.current.onPoints?.(id, points);
  };

  const scheduleFlush = () => {
    if (frameRef.current != null) return;
    frameRef.current = requestAnimationFrame(flushFrame);
  };

  const endStroke = () => {
    const id = strokeIdRef.current;
    if (!id) return;
    if (frameRef.current != null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    flushFrame();
    strokeIdRef.current = null;
    lastPointRef.current = undefined;
    callbacksRef.current.onEnd?.(id);
  };

  // Never leave a gesture open if the canvas becomes read-only mid-gesture.
  useEffect(() => {
    if (!editable) {
      if (strokeIdRef.current) endStroke();
      setPreview(null);
      setRing(null);
      startRef.current = null;
      tapRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editable]);

  useEffect(
    () => () => {
      if (frameRef.current != null) cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  const pointFromEvent = (event: GestureResponderEvent): Point =>
    normalizeTouch(event.nativeEvent.locationX, event.nativeEvent.locationY, measured.width, measured.height);

  const beginFreehand = (point: Point) => {
    const id = makeId("stroke");
    strokeIdRef.current = id;
    lastPointRef.current = point;
    pendingRef.current = [];
    callbacksRef.current.onBegin?.(id, point);
  };

  const handleStart = (event: GestureResponderEvent) => {
    if (!editable || measured.width <= 0) return;
    if (event.nativeEvent.touches.length > 1) {
      endStroke();
      return;
    }
    const point = pointFromEvent(event);
    setRing(point);
    startRef.current = point;
    tapRef.current = point;

    if (tool === "fill" || tool === "dropper") return;
    if (tool === "brush" || tool === "eraser") {
      beginFreehand(point);
      return;
    }
    if (!isShapeTool(tool)) return;
    setPreview({ kind: shapeKind(tool), start: point, end: point });
  };

  const handleMove = (event: GestureResponderEvent) => {
    if (!editable) return;
    const point = pointFromEvent(event);
    setRing(point);
    if (strokeIdRef.current) {
      if (!shouldSamplePoint(lastPointRef.current, point)) return;
      lastPointRef.current = point;
      pendingRef.current.push(point);
      scheduleFlush();
      return;
    }
    const start = startRef.current;
    if (start && isShapeTool(tool)) {
      setPreview({ kind: shapeKind(tool), start, end: point });
    }
  };

  const handleRelease = () => {
    setRing(null);
    const start = startRef.current;
    const tapped = tapRef.current;
    startRef.current = null;
    tapRef.current = null;

    if (strokeIdRef.current) {
      endStroke();
      return;
    }
    if (!start || !tapped) return;

    if (tool === "dropper") {
      const grid = rasterize(strokes.filter((action) => action.complete));
      callbacksRef.current.onPickColor?.(sampleColor(grid, tapped));
      return;
    }
    if (tool === "fill") {
      const grid = rasterize(strokes.filter((action) => action.complete));
      const runs = floodFillRuns(grid, tapped, color);
      if (runs.length) callbacksRef.current.onFill?.(runs, color);
      return;
    }

    if (!isShapeTool(tool)) return;
    const current = preview?.end ?? start;
    setPreview(null);
    const moved = Math.hypot(current.x - start.x, current.y - start.y);
    if (moved < 0.008) return;
    callbacksRef.current.onShape?.(makeId(tool), shapeKind(tool), start, current);
  };

  return (
    <View
      testID="skrible-drawing-canvas"
      collapsable={false}
      style={[styles.wrapper, width != null ? { width, height: width * 0.75 } : null]}
      onLayout={(event: LayoutChangeEvent) => {
        const { width: w, height: h } = event.nativeEvent.layout;
        setMeasured({ width: w, height: h });
      }}
      onStartShouldSetResponder={() => editable}
      onMoveShouldSetResponder={() => editable}
      onResponderGrant={handleStart}
      onResponderMove={handleMove}
      onResponderRelease={handleRelease}
      onResponderTerminate={handleRelease}
      onResponderTerminationRequest={() => false}
      accessibilityLabel={editable ? "Drawing canvas. Drag to draw." : "Drawing canvas, read only."}
    >
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <Canvas style={StyleSheet.absoluteFill}>
          {measured.width > 0
            ? visible.map((action) => {
                if (action.kind === "fill") {
                  return (
                    <FillShape
                      key={action.id}
                      stroke={action}
                      canvasWidth={measured.width}
                      canvasHeight={measured.height}
                    />
                  );
                }
                if (action.kind === "line" || action.kind === "rect" || action.kind === "ellipse") {
                  if (action.x1 == null || action.y1 == null || action.x2 == null || action.y2 == null) return null;
                  return (
                    <ShapeMark
                      key={action.id}
                      kind={action.kind}
                      x1={action.x1}
                      y1={action.y1}
                      x2={action.x2}
                      y2={action.y2}
                      color={action.color}
                      width={action.width}
                      canvasWidth={measured.width}
                      canvasHeight={measured.height}
                    />
                  );
                }
                return (
                  <StrokeShape
                    key={action.id}
                    stroke={action}
                    canvasWidth={measured.width}
                    canvasHeight={measured.height}
                  />
                );
              })
            : null}
          {preview ? (
            <ShapeMark
              kind={preview.kind}
              x1={preview.start.x}
              y1={preview.start.y}
              x2={preview.end.x}
              y2={preview.end.y}
              color={color}
              width={size}
              canvasWidth={measured.width}
              canvasHeight={measured.height}
              opacity={0.55}
            />
          ) : null}
          {ring ? (
            <Circle
              cx={ring.x * measured.width}
              cy={ring.y * measured.height}
              r={Math.max(6, widthFor(size, measured.width) / 2 + 4)}
              color={tool === "eraser" ? "#000000" : color}
              style="stroke"
              strokeWidth={1.5}
              opacity={0.6}
            />
          ) : null}
        </Canvas>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // The frame (border + hard shadow) is owned by the game screen so the shared
  // 4:3 canvas fills it edge to edge without changing touch coordinates.
  wrapper: {
    width: "100%",
    aspectRatio: 4 / 3,
    backgroundColor: "#FFFFFF",
    overflow: "hidden",
  },
});
