import React from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import Svg, { Circle, Ellipse, G, Path, Rect } from "react-native-svg";
import { BORDER_WIDTH, colors } from "../theme";
import { avatarColor, avatarLabel, parseAvatar } from "../game/avatars";

const INK = colors.ink;
const YELLOW = colors.yellow;
const WHITE = "#FFFFFF";
const PINK = "#FF4D8D";

const starPath = (cx: number, cy: number, outer: number, inner: number) => {
  const points: string[] = [];
  for (let index = 0; index < 10; index += 1) {
    const radius = index % 2 === 0 ? outer : inner;
    const angle = -Math.PI / 2 + (index * Math.PI) / 5;
    points.push(`${(cx + Math.cos(angle) * radius).toFixed(2)} ${(cy + Math.sin(angle) * radius).toFixed(2)}`);
  }
  return `M${points.join(" L")} Z`;
};

function Eyes({ index }: { index: number }) {
  switch (index) {
    case 1:
      return (
        <>
          <Path d="M30 42c3-7 9-7 12 0" />
          <Path d="M58 42c3-7 9-7 12 0" />
        </>
      );
    case 2:
      return (
        <>
          <Circle cx="36" cy="40" r="7" fill={WHITE} strokeWidth="3.5" />
          <Circle cx="64" cy="40" r="7" fill={WHITE} strokeWidth="3.5" />
          <Circle cx="39" cy="41" r="3" fill={INK} stroke="none" />
          <Circle cx="60" cy="38" r="3" fill={INK} stroke="none" />
        </>
      );
    case 3:
      return (
        <>
          <Rect x="24" y="34" width="22" height="12" rx="5" fill={INK} />
          <Rect x="54" y="34" width="22" height="12" rx="5" fill={INK} />
          <Path d="M46 38h8" strokeWidth="4" />
          <Path d="M24 37 16 33M76 37l8-4" strokeWidth="4" />
        </>
      );
    case 4:
      return (
        <>
          <Path d="M23 33 77 27" strokeWidth="4" />
          <Rect x="27" y="32" width="21" height="15" rx="4" fill={INK} transform="rotate(-7 37 39)" />
          <Circle cx="64" cy="41" r="4.2" fill={INK} stroke="none" />
        </>
      );
    case 5:
      return (
        <>
          <Circle cx="50" cy="39" r="10" fill={WHITE} strokeWidth="4" />
          <Circle cx="50" cy="39" r="4.5" fill={INK} stroke="none" />
        </>
      );
    case 6:
      return (
        <>
          <Path d="M29 31 41 36M71 31 59 36" strokeWidth="4" />
          <Path d="M31 38l7 3-7 3M69 38l-7 3 7 3" strokeWidth="4" />
        </>
      );
    case 7:
      return (
        <>
          <Path d="M27 31c8-5 38-5 46 0" strokeWidth="5" />
          <Circle cx="38" cy="41" r="4.2" fill={INK} stroke="none" />
          <Circle cx="62" cy="41" r="4.2" fill={INK} stroke="none" />
        </>
      );
    case 8:
      return (
        <>
          <Path d={starPath(38, 40, 9, 4)} fill={INK} stroke="none" />
          <Path d={starPath(62, 40, 9, 4)} fill={INK} stroke="none" />
        </>
      );
    case 9:
      return (
        <>
          <Path d="M31 40h13M56 40h13" strokeWidth="4.5" />
          <Path d="M31 35 44 35M56 35 69 35" strokeWidth="3" />
        </>
      );
    case 10:
      return (
        <>
          <Circle cx="38" cy="40" r="4.2" fill={INK} stroke="none" />
          <Path d="M58 40h13" strokeWidth="4.5" />
        </>
      );
    default:
      return (
        <>
          <Circle cx="38" cy="40" r="4.2" fill={INK} stroke="none" />
          <Circle cx="62" cy="40" r="4.2" fill={INK} stroke="none" />
        </>
      );
  }
}

function Mouth({ index }: { index: number }) {
  switch (index) {
    case 1:
      return (
        <>
          <Path d="M33 52c5 14 29 14 34 0" strokeWidth="4.5" />
          <Path d="M40 57h20" strokeWidth="3" />
        </>
      );
    case 2:
      return (
        <>
          <Path d="M35 53c5 11 25 11 30 0" strokeWidth="4.5" />
          <Rect x="44" y="58" width="6" height="6" fill={WHITE} strokeWidth="2.5" />
          <Rect x="50" y="58" width="6" height="6" fill={WHITE} strokeWidth="2.5" />
        </>
      );
    case 3:
      return <Ellipse cx="50" cy="59" rx="7" ry="6" fill={INK} stroke="none" />;
    case 4:
      return <Path d="M37 58c4-5 8 5 12 0s8 5 14 0" strokeWidth="4" />;
    case 5:
      return <Path d="M38 61c4-8 20-8 24 0" strokeWidth="4.5" />;
    case 6:
      return <Path d="M39 57h22" strokeWidth="4.5" />;
    case 7:
      return (
        <>
          <Path d="M36 53c4 10 24 10 28 0" strokeWidth="4.5" />
          <Path d="M44 58h12v4c0 4-12 4-12 0Z" fill={PINK} strokeWidth="3" />
        </>
      );
    case 8:
      return (
        <>
          <Path d="M38 56q6 8 12 0q6 8 12 0" strokeWidth="4" />
          <Path d="M46 52h8l-4 5Z" fill={INK} strokeWidth="2" />
        </>
      );
    case 9:
      return (
        <>
          <Path
            d="M50 58c-6-4-18-4-18 1 0 5 11 6 18 1 7 5 18 4 18-1 0-5-12-5-18-1Z"
            fill={INK}
            stroke="none"
          />
          <Path d="M42 66c3 3 13 3 16 0" strokeWidth="3.5" />
        </>
      );
    default:
      return <Path d="M38 56c6 8 18 8 24 0" strokeWidth="4.5" />;
  }
}

function Crown() {
  return (
    <G transform="rotate(-9 50 18)">
      <Path
        d="M31 25 28 8l12 8 10-14 10 14 12-8-3 17Z"
        fill={YELLOW}
        stroke={INK}
        strokeWidth="4"
        strokeLinejoin="round"
      />
      <Path d="M31 25h38" strokeWidth="4" />
      <Circle cx="28" cy="8" r="3" fill={YELLOW} stroke={INK} strokeWidth="3" />
      <Circle cx="50" cy="3" r="3" fill={YELLOW} stroke={INK} strokeWidth="3" />
      <Circle cx="72" cy="8" r="3" fill={YELLOW} stroke={INK} strokeWidth="3" />
    </G>
  );
}

export function Avatar({
  value,
  size = 48,
  hasCrown = false,
  showCrown = false,
  style,
}: {
  value?: string | null;
  size?: number;
  hasCrown?: boolean;
  /** Explicit podium alias; either prop renders the same SVG crown. */
  showCrown?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const config = parseAvatar(value);
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      stroke={INK}
      strokeWidth={4.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
    >
      <Path
        d="M15 96c0-18 15-31 35-31s35 13 35 31Z"
        fill={avatarColor(value)}
        strokeWidth="4.5"
        strokeLinejoin="round"
      />
      <Circle cx="50" cy="43" r="27" fill={avatarColor(value)} strokeWidth="4.5" />
      <Eyes index={config.eyes} />
      <Mouth index={config.mouth} />
      {hasCrown || showCrown ? <Crown /> : null}
    </Svg>
  );
}

/**
 * Framed avatar badge used in rosters and headers. The selected state draws the
 * same hard ink offset as buttons and cards.
 */
export default function AvatarTile({
  value,
  size = 52,
  selected = false,
  hasCrown = false,
  style,
}: {
  value?: string | null;
  size?: number;
  selected?: boolean;
  hasCrown?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const offset = selected ? 5 : 0;
  const tileRadius = Math.round(size * 0.3);

  return (
    <View style={[{ paddingRight: offset, paddingBottom: offset }, style]}>
      {selected ? (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            left: offset,
            top: offset,
            right: 0,
            bottom: 0,
            backgroundColor: INK,
            borderRadius: tileRadius,
          }}
        />
      ) : null}
      <View
        accessible
        accessibilityRole="image"
        accessibilityLabel={avatarLabel(value)}
        style={{
          width: size,
          height: size,
          borderRadius: tileRadius,
          backgroundColor: colors.surface,
          borderWidth: BORDER_WIDTH,
          borderColor: INK,
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
        }}
      >
        <Avatar value={value} size={Math.round(size * 0.86)} hasCrown={hasCrown} />
      </View>
    </View>
  );
}
