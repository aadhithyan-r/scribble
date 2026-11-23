import React from "react";
import { Platform, View, type StyleProp, type ViewStyle } from "react-native";
import Svg, { G, Path, Polygon, Rect, Text as SvgText } from "react-native-svg";

const INK = "#000000";
/** Vibrant Neo-Brutalist palette, one tile per letter. */
const TILE_COLORS = ["#FFD600", "#FF4D8D", "#38D947", "#00E5FF", "#9B7BFF", "#FF8C00", "#FFD600"];
const TILE_TILTS = [-6, 5, -4, 6, -5, 4, -6];
const LETTERS = ["S", "K", "R", "I", "B", "L", "E"];

const TILE = 38;
const GAP = 4;
const START_X = 4;
const TILE_Y = 14;
/** Solid hard shadow offset behind every sticker tile. */
const SHADOW = 3.5;

const FONT_FAMILY = Platform.select({ ios: "System", android: "sans-serif", default: "sans-serif" });

/**
 * The Skrible wordmark: seven staggered sticker tiles with heavy ink borders
 * and a solid black offset, a tilted pencil and a hand-drawn scribble
 * underline. Pure react-native-svg, no fonts or images to load.
 */
export default function SkribleLogo({
  width = 320,
  style,
}: {
  width?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const height = Math.round((width * 100) / 360);
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel="Skrible"
      style={[{ width, height }, style]}
    >
      <Svg width="100%" height="100%" viewBox="0 0 360 100">
        {LETTERS.map((letter, index) => {
          const x = START_X + index * (TILE + GAP);
          const tilt = TILE_TILTS[index]!;
          const cx = x + TILE / 2;
          const cy = TILE_Y + TILE / 2;
          return (
            <G key={`${letter}${index}`} transform={`rotate(${tilt} ${cx} ${cy})`}>
              <Rect
                x={x + SHADOW}
                y={TILE_Y + SHADOW}
                width={TILE}
                height={TILE}
                rx={7}
                fill={INK}
              />
              <Rect
                x={x}
                y={TILE_Y}
                width={TILE}
                height={TILE}
                rx={7}
                fill={TILE_COLORS[index]}
                stroke={INK}
                strokeWidth={3}
              />
              <SvgText
                x={cx}
                y={cy + 8}
                fill={INK}
                stroke={INK}
                strokeWidth={1.6}
                fontSize={24}
                fontWeight="900"
                fontFamily={FONT_FAMILY}
                textAnchor="middle"
              >
                {letter}
              </SvgText>
            </G>
          );
        })}

        {/* Pencil resting at the end of the word, tilted like it just drew it. */}
        <G transform="translate(300 24) rotate(-18 22 10)">
          <Polygon points="1,10 14,2 14,18" fill={INK} transform="translate(3 3)" />
          <Rect x={17} y={5} width={26} height={16} fill={INK} transform="translate(3 3)" />
          <Rect x={43} y={5} width={8} height={16} fill={INK} transform="translate(3 3)" />
          <Polygon
            points="1,10 14,2 14,18"
            fill="#FFE082"
            stroke={INK}
            strokeWidth={3}
            strokeLinejoin="round"
          />
          <Rect x={17} y={2} width={26} height={16} fill="#FFD600" stroke={INK} strokeWidth={3} />
          <Rect x={43} y={2} width={8} height={16} fill="#FF4D8D" stroke={INK} strokeWidth={3} />
          <Path d="M17 2v16" stroke={INK} strokeWidth={3} />
        </G>

        {/* Hand-drawn scribble underline. */}
        <Path
          d="M6 78c12-8 22 6 34-1s22 5 34-2 22 6 34-1 22 5 34-2 22 6 34-1 22 5 34-2 22 6 34-1"
          fill="none"
          stroke={INK}
          strokeWidth={3.2}
          strokeLinecap="round"
        />
      </Svg>
    </View>
  );
}
