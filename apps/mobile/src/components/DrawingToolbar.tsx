import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { Tool } from "../game/types";
import Icon from "./Icons";
import { BORDER_WIDTH, colors, radii } from "../theme";

export const PALETTE = [
  "#000000",
  "#EF4444",
  "#F59E0B",
  "#10B981",
  "#3B82F6",
  "#A855F7",
  "#EC4899",
  "#8B5E3C",
];

export const BRUSH_SIZES = [4, 10, 20];

type Props = {
  tool: Tool;
  color: string;
  size: number;
  canUndo: boolean;
  canRedo: boolean;
  disabled?: boolean;
  onToolChange: (tool: Tool) => void;
  onColorChange: (color: string) => void;
  onSizeChange: (size: number) => void;
  onUndo: () => void;
  onRedo: () => void;
  onClear: () => void;
};

const pressedStyle = { transform: [{ translateX: 2 }, { translateY: 2 }] };

export default function DrawingToolbar({
  tool,
  color,
  size,
  canUndo,
  canRedo,
  disabled = false,
  onToolChange,
  onColorChange,
  onSizeChange,
  onUndo,
  onRedo,
  onClear,
}: Props) {
  return (
    <View style={styles.container}>
      <View style={styles.row}>
        {PALETTE.map((swatch) => {
          const selected = tool === "pen" && color === swatch;
          return (
            <Pressable
              key={swatch}
              accessibilityRole="button"
              accessibilityLabel={`Colour ${swatch}`}
              accessibilityState={{ selected, disabled }}
              disabled={disabled}
              hitSlop={4}
              onPress={() => onColorChange(swatch)}
              style={({ pressed }) => [
                styles.swatchButton,
                selected && styles.swatchSelected,
                pressed && pressedStyle,
              ]}
            >
              <View style={[styles.swatch, { backgroundColor: swatch }]} />
            </Pressable>
          );
        })}
      </View>

      <View style={styles.row}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Pen"
          accessibilityState={{ selected: tool === "pen", disabled }}
          disabled={disabled}
          onPress={() => onToolChange("pen")}
          style={({ pressed }) => [
            styles.pill,
            tool === "pen" && styles.pillActive,
            pressed && pressedStyle,
          ]}
        >
          <Icon name="brush" size={16} />
          <Text style={styles.pillText}>PEN</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Eraser"
          accessibilityState={{ selected: tool === "eraser", disabled }}
          disabled={disabled}
          onPress={() => onToolChange("eraser")}
          style={({ pressed }) => [
            styles.pill,
            tool === "eraser" && styles.pillActive,
            pressed && pressedStyle,
          ]}
        >
          <Icon name="eraser" size={16} />
          <Text style={styles.pillText}>ERASER</Text>
        </Pressable>

        <View style={styles.divider} />

        {BRUSH_SIZES.map((brush) => {
          const selected = size === brush;
          return (
            <Pressable
              key={brush}
              accessibilityRole="button"
              accessibilityLabel={`Brush size ${brush}`}
              accessibilityState={{ selected, disabled }}
              disabled={disabled}
              hitSlop={4}
              onPress={() => onSizeChange(brush)}
              style={({ pressed }) => [
                styles.sizeButton,
                selected && styles.sizeSelected,
                pressed && pressedStyle,
              ]}
            >
              <View
                style={{
                  width: Math.max(4, brush * 0.7),
                  height: Math.max(4, brush * 0.7),
                  borderRadius: brush,
                  backgroundColor: selected ? colors.ink : colors.surface,
                  borderWidth: 1.5,
                  borderColor: colors.ink,
                }}
              />
            </Pressable>
          );
        })}
      </View>

      <View style={styles.row}>
        <ActionButton
          label="UNDO"
          icon="undo"
          disabled={disabled || !canUndo}
          onPress={onUndo}
          accessibilityLabel="Undo last stroke"
        />
        <ActionButton
          label="REDO"
          icon="redo"
          disabled={disabled || !canRedo}
          onPress={onRedo}
          accessibilityLabel="Redo stroke"
        />
        <ActionButton
          label="CLEAR"
          icon="trash"
          danger
          disabled={disabled}
          onPress={onClear}
          accessibilityLabel="Clear canvas"
        />
      </View>
    </View>
  );
}

function ActionButton({
  label,
  icon,
  onPress,
  disabled,
  accessibilityLabel,
  danger = false,
}: {
  label: string;
  icon: "undo" | "redo" | "trash";
  onPress: () => void;
  disabled: boolean;
  accessibilityLabel: string;
  danger?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.action,
        danger && styles.actionDanger,
        disabled && styles.actionDisabled,
        pressed && pressedStyle,
      ]}
    >
      <Icon name={icon} size={15} />
      <Text style={styles.actionText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { gap: 8 },
  row: { flexDirection: "row", alignItems: "center", gap: 5, flexWrap: "wrap" },
  swatchButton: {
    width: 32,
    height: 32,
    borderRadius: 7,
    borderWidth: BORDER_WIDTH,
    borderColor: colors.ink,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
  },
  swatchSelected: {
    borderWidth: 3,
    shadowColor: colors.ink,
    shadowOpacity: 1,
    shadowRadius: 0,
    shadowOffset: { width: 2, height: 2 },
    elevation: 0,
  },
  swatch: { width: 21, height: 21, borderRadius: 3, borderWidth: 1, borderColor: colors.ink },
  pill: {
    minHeight: 38,
    paddingHorizontal: 11,
    borderRadius: radii.sm,
    borderWidth: BORDER_WIDTH,
    borderColor: colors.ink,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    backgroundColor: colors.surface,
  },
  pillActive: { backgroundColor: colors.yellow },
  pillText: { fontSize: 10, fontWeight: "900", letterSpacing: 1, color: colors.ink },
  divider: { width: 2, height: 26, backgroundColor: colors.ink, marginHorizontal: 3 },
  sizeButton: {
    width: 36,
    height: 36,
    borderRadius: radii.sm,
    borderWidth: BORDER_WIDTH,
    borderColor: colors.ink,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
  },
  sizeSelected: { backgroundColor: colors.yellow },
  action: {
    flex: 1,
    minHeight: 40,
    borderRadius: radii.sm,
    borderWidth: BORDER_WIDTH,
    borderColor: colors.ink,
    backgroundColor: colors.surface,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
  },
  actionDanger: { backgroundColor: colors.pink },
  actionDisabled: { opacity: 0.35 },
  actionText: { fontSize: 10, fontWeight: "900", letterSpacing: 0.8, color: colors.ink },
});
