import { Platform, type TextStyle } from "react-native";

/** Neo-Brutalism palette: warm paper, pure ink, loud flats. */
export const colors = {
  bg: "#FFFDF7",
  surface: "#FFFFFF",
  ink: "#000000",
  yellow: "#FFD600",
  gold: "#FFD60A",
  pink: "#FF4D8D",
  green: "#38D947",
  like: "#2ECC71",
  nope: "#FF595E",
  lavender: "#9B7BFF",
  amber: "#FFE082",
  lime: "#B8E986",
  cyan: "#7CE0F9",
  gray: "#B0B0B0",
  muted: "#6F6F6F",
  danger: "#E5484D",
  backdrop: "rgba(0, 0, 0, 0.5)",
} as const;

/** Every bordered surface uses the same chunky ink outline. */
export const BORDER_WIDTH = 2.5;
/** Solid offset shadow distance behind cards and buttons. */
export const SHADOW_OFFSET = 4;
/** How far the face travels when a button is pressed. */
export const PRESS_OFFSET = 3;

export const radii = {
  xs: 6,
  sm: 10,
  md: 14,
  lg: 18,
  xl: 24,
  pill: 999,
} as const;

export const monoFont = Platform.select({
  ios: "Menlo",
  android: "monospace",
  default: "monospace",
});

export const type = {
  display: {
    fontSize: 42,
    lineHeight: 43,
    fontWeight: "900",
    letterSpacing: -2.4,
    color: colors.ink,
  },
  title: {
    fontSize: 26,
    lineHeight: 29,
    fontWeight: "900",
    letterSpacing: -1,
    color: colors.ink,
  },
  heading: {
    fontSize: 20,
    lineHeight: 24,
    fontWeight: "900",
    letterSpacing: -0.5,
    color: colors.ink,
  },
  subheading: {
    fontSize: 16,
    lineHeight: 20,
    fontWeight: "900",
    letterSpacing: -0.2,
    color: colors.ink,
  },
  body: {
    fontSize: 13,
    lineHeight: 19,
    fontWeight: "600",
    color: "#333333",
  },
  label: {
    fontSize: 10,
    lineHeight: 13,
    fontWeight: "900",
    letterSpacing: 1.4,
    textTransform: "uppercase",
    color: colors.ink,
  },
  tiny: {
    fontSize: 9,
    lineHeight: 12,
    fontWeight: "800",
    letterSpacing: 0.6,
    color: colors.muted,
  },
} satisfies Record<string, TextStyle>;
