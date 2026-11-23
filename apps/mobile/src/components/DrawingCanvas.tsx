import React, { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
} from "react-native";
import { Canvas, Circle, Path, Skia } from "@shopify/react-native-skia";
import type { Point, Stroke } from "../game/types";
import { normalizeTouch, shouldSamplePoint } from "../drawing/geometry";

/** Stroke widths are authored against a 400pt-wide canvas and scaled per device. */
const WIDTH_REFERENCE = 400;

type Callbacks = {
  onBegin: (id: string, point: Point) => void;
  onPoints: (id: string, points: Point[]) => void;
  onEnd: (id: string) => void;
};

type Props = {
  strokes: Stroke[];
  editable: boolean;
  hint?: string;
  /** Explicit 4:3 size so every device shares one coordinate space. */
  width?: number;
} & Callbacks;

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
    () => buildStrokePath(stroke.points, canvasWidth, canvasHeight),
    [stroke.points, canvasWidth, canvasHeight],
  );
  const scaledWidth = Math.max(1, (stroke.width * canvasWidth) / WIDTH_REFERENCE);

  if (stroke.points.length === 0) return null;
  if (stroke.points.length === 1) {
    const point = stroke.points[0]!;
    return (
      <Circle
        cx={point.x * canvasWidth}
        cy={point.y * canvasHeight}
        r={scaledWidth / 2}
        color={stroke.color}
      />
    );
  }
  return (
    <Path
      path={path}
      color={stroke.color}
      style="stroke"
      strokeWidth={scaledWidth}
      strokeCap="round"
      strokeJoin="round"
    />
  );
});

const makeStrokeId = () =>
  `stroke_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

export default function DrawingCanvas({ strokes, editable, hint, width, ...callbacks }: Props) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const strokeIdRef = useRef<string | null>(null);
  const lastPointRef = useRef<Point | undefined>(undefined);
  const pendingRef = useRef<Point[]>([]);
  const frameRef = useRef<number | null>(null);
  const callbacksRef = useRef<Callbacks>(callbacks);
  callbacksRef.current = callbacks;

  const flushFrame = () => {
    frameRef.current = null;
    const id = strokeIdRef.current;
    const points = pendingRef.current;
    if (!id || points.length === 0) return;
    pendingRef.current = [];
    callbacksRef.current.onPoints(id, points);
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
    callbacksRef.current.onEnd(id);
  };

  // Never leave a stroke open if the canvas becomes read-only mid-gesture
  // (round change, drawer hand-off, disconnect).
  useEffect(() => {
    if (!editable && strokeIdRef.current) endStroke();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editable]);

  useEffect(
    () => () => {
      if (frameRef.current != null) cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  const handleLayout = (event: LayoutChangeEvent) => {
    const { width: w, height: h } = event.nativeEvent.layout;
    setSize({ width: w, height: h });
  };

  const pointFromEvent = (event: GestureResponderEvent): Point =>
    normalizeTouch(event.nativeEvent.locationX, event.nativeEvent.locationY, size.width, size.height);

  const handleStart = (event: GestureResponderEvent) => {
    if (!editable || size.width <= 0) return;
    // Second finger or palm: ignore the gesture entirely instead of drawing a
    // line between two touches. One stroke per pointer is the whole rule.
    if (event.nativeEvent.touches.length > 1) {
      endStroke();
      return;
    }
    const point = pointFromEvent(event);
    const id = makeStrokeId();
    strokeIdRef.current = id;
    lastPointRef.current = point;
    pendingRef.current = [];
    callbacksRef.current.onBegin(id, point);
  };

  const handleMove = (event: GestureResponderEvent) => {
    if (!editable || !strokeIdRef.current) return;
    const point = pointFromEvent(event);
    if (!shouldSamplePoint(lastPointRef.current, point)) return;
    lastPointRef.current = point;
    pendingRef.current.push(point);
    scheduleFlush();
  };

  const handleRelease = () => {
    if (strokeIdRef.current) endStroke();
  };

  return (
    <View
      style={[styles.wrapper, width != null ? { width, height: width * 0.75 } : null]}
      onLayout={handleLayout}
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
          {size.width > 0
            ? strokes.map((stroke) => (
                <StrokeShape
                  key={stroke.id}
                  stroke={stroke}
                  canvasWidth={size.width}
                  canvasHeight={size.height}
                />
              ))
            : null}
        </Canvas>
      </View>
      {hint ? (
        <View pointerEvents="none" style={styles.hint}>
          <Text style={styles.hintText}>{hint}</Text>
        </View>
      ) : null}
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
  /* The wrapper owns the aspect ratio; the Skia canvas fills it exactly. */
  hint: {
    position: "absolute",
    top: 12,
    left: 12,
    right: 12,
    alignItems: "center",
  },
  hintText: {
    backgroundColor: "rgba(0,0,0,0.08)",
    color: "#000000",
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.4,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    overflow: "hidden",
  },
});
