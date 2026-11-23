import React from "react";
import Svg, { Circle, Path, Rect } from "react-native-svg";
import { colors } from "../theme";

export type IconName =
  | "settings"
  | "crown"
  | "brush"
  | "eraser"
  | "undo"
  | "redo"
  | "trash"
  | "trophy"
  | "lock"
  | "globe"
  | "users"
  | "share"
  | "chevronLeft"
  | "chevronRight"
  | "plus"
  | "arrowRight"
  | "check"
  | "close"
  | "bolt"
  | "play"
  | "refresh"
  | "info"
  | "eye"
  | "mute"
  | "dice"
  | "star";

const starPath = (cx: number, cy: number, outer: number, inner: number) => {
  const points: string[] = [];
  for (let index = 0; index < 10; index += 1) {
    const radius = index % 2 === 0 ? outer : inner;
    const angle = -Math.PI / 2 + (index * Math.PI) / 5;
    points.push(`${(cx + Math.cos(angle) * radius).toFixed(2)} ${(cy + Math.sin(angle) * radius).toFixed(2)}`);
  }
  return `M${points.join(" L")} Z`;
};

const CONTENT: Record<IconName, React.ReactNode> = {
  settings: (
    <>
      <Circle cx="12" cy="12" r="3.4" />
      <Path d="M12 2.8v2.6M12 18.6v2.6M21.2 12h-2.6M5.4 12H2.8M18.5 5.5l-1.8 1.8M7.3 16.7l-1.8 1.8M18.5 18.5l-1.8-1.8M7.3 7.3 5.5 5.5" />
    </>
  ),
  crown: (
    <>
      <Path d="M3 18.5 4.8 7.5l4.4 4L12 5l2.8 6.5 4.4-4L21 18.5Z" />
      <Path d="M4 21.2h16" />
    </>
  ),
  brush: (
    <>
      <Path d="M4 20.5c.2-2.4.9-4.2 3-4.6l10.4-10.4 2.6 2.6L9.6 18.5c-.4 2-2 2.5-4.2 2.5" />
      <Path d="M14.8 6.2 17.4 8.8" />
    </>
  ),
  eraser: (
    <>
      <Path d="M15.6 4.2 20 8.6 9.4 19.2H5.2L3 17Z" />
      <Path d="M9.6 8.2l6.4 6.4M9.4 19.2H21" />
    </>
  ),
  undo: (
    <>
      <Path d="M4.2 10.2H14a5.4 5.4 0 0 1 0 10.8H9.4" />
      <Path d="M8.2 5.6 4 10.2l4.2 4.6" />
    </>
  ),
  redo: (
    <>
      <Path d="M19.8 10.2H10a5.4 5.4 0 0 0 0 10.8h4.6" />
      <Path d="M15.8 5.6 20 10.2l-4.2 4.6" />
    </>
  ),
  trash: (
    <>
      <Path d="M3.6 6.8h16.8M9 6.8V3.6h6v3.2" />
      <Path d="M5.6 6.8 6.8 21h10.4l1.2-14.2" />
      <Path d="M10 10.6v6.6M14 10.6v6.6" />
    </>
  ),
  trophy: (
    <>
      <Path d="M7.6 3.4h8.8v7.2a4.4 4.4 0 0 1-8.8 0Z" />
      <Path d="M7.6 5.6H3.4v2.2a4 4 0 0 0 4.2 4M16.4 5.6h4.2v2.2a4 4 0 0 1-4.2 4" />
      <Path d="M12 15v4.4M7.8 21h8.4" />
    </>
  ),
  lock: (
    <>
      <Rect x="4.4" y="10.6" width="15.2" height="10.4" rx="2.2" />
      <Path d="M8 10.6V7.8a4 4 0 0 1 8 0v2.8" />
      <Circle cx="12" cy="15.8" r="1.3" fill={colors.ink} />
    </>
  ),
  globe: (
    <>
      <Circle cx="12" cy="12" r="9" />
      <Path d="M3 12h18" />
      <Path d="M12 3c-3.4 3-3.4 15 0 18M12 3c3.4 3 3.4 15 0 18" />
    </>
  ),
  users: (
    <>
      <Circle cx="9" cy="8" r="3.6" />
      <Path d="M2.8 20.4c0-3.8 2.8-6 6.2-6s6.2 2.2 6.2 6" />
      <Circle cx="17.2" cy="9.4" r="2.7" />
      <Path d="M16.4 14.6c3 .2 4.8 2.3 4.8 5.4" />
    </>
  ),
  share: (
    <>
      <Path d="M12 15.6V3.4M8 7.2l4-3.8 4 3.8" />
      <Path d="M5 12.4V21h14v-8.6" />
    </>
  ),
  chevronLeft: <Path d="M15.4 4.6 8 12l7.4 7.4" />,
  chevronRight: <Path d="M8.6 4.6 16 12l-7.4 7.4" />,
  dice: (
    <>
      <Rect x="3.4" y="3.4" width="17.2" height="17.2" rx="3.4" />
      <Circle cx="8.2" cy="8.2" r="1.35" fill={colors.ink} stroke="none" />
      <Circle cx="15.8" cy="8.2" r="1.35" fill={colors.ink} stroke="none" />
      <Circle cx="12" cy="12" r="1.35" fill={colors.ink} stroke="none" />
      <Circle cx="8.2" cy="15.8" r="1.35" fill={colors.ink} stroke="none" />
      <Circle cx="15.8" cy="15.8" r="1.35" fill={colors.ink} stroke="none" />
    </>
  ),
  plus: <Path d="M12 4.8v14.4M4.8 12h14.4" />,
  arrowRight: <Path d="M3.6 12h16.8M14.2 5.6 20.4 12l-6.2 6.4" />,
  check: <Path d="M4.4 12.8 9.6 18 19.6 5.6" />,
  close: <Path d="M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4" />,
  bolt: <Path d="M13.2 2.4 4.2 14h6.6l-1.2 7.6L19.8 9h-6.6Z" />,
  play: <Path d="M7 3.6 20 12 7 20.4Z" fill={colors.ink} />,
  refresh: (
    <>
      <Path d="M20 12a8 8 0 1 1-2.6-5.9" />
      <Path d="M20.2 3.8v5h-5" />
    </>
  ),
  info: (
    <>
      <Circle cx="12" cy="12" r="9" />
      <Path d="M12 10.8v5.6" />
      <Circle cx="12" cy="7.6" r="1.1" fill={colors.ink} />
    </>
  ),
  eye: (
    <>
      <Path d="M2.2 12S5.8 5.2 12 5.2 21.8 12 21.8 12 18.2 18.8 12 18.8 2.2 12 2.2 12Z" />
      <Circle cx="12" cy="12" r="3" />
    </>
  ),
  mute: (
    <>
      <Path d="M4 9.4h3.4L12 5.4v13.2l-4.6-4H4Z" />
      <Path d="M16 9.4 20.6 15M20.6 9.4 16 15" />
    </>
  ),
  star: <Path d={starPath(12, 12, 9.2, 4)} />,
};

export default function Icon({
  name,
  size = 22,
  color = colors.ink,
  strokeWidth = 2.4,
}: {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
}) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {CONTENT[name]}
    </Svg>
  );
}
