import React, { useState } from "react";
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { DrawTool } from "../game/types";
import Icon, { type IconName } from "./Icons";
import { BORDER_WIDTH, colors, radii, SHADOW_OFFSET } from "../theme";

/** 22-colour matrix: 11 light/vivid tones over 11 deep tones. */
export const COLOR_MATRIX: string[][] = [
  ["#FFFFFF", "#D9D9D9", "#EF4444", "#F97316", "#FACC15", "#84CC16", "#34D399", "#22D3EE", "#2563EB", "#A855F7", "#EC4899"],
  ["#000000", "#4B5563", "#991B1B", "#B45309", "#CA8A04", "#166534", "#0F766E", "#1E3A8A", "#1E293B", "#4C1D95", "#78350F"],
];

const HUE_SWATCHES = [
  "#EF4444", "#F97316", "#FACC15", "#84CC16", "#22C55E", "#14B8A6",
  "#06B6D4", "#3B82F6", "#6366F1", "#A855F7", "#EC4899", "#F43F5E",
];
const SHADES = ["#FEE2E2", "#FCA5A5", null, "#7F1D1D", "#000000"] as const;
export const SIZE_PRESETS = [4, 10, 18, 28, 40] as const;

type Props = {
  tool: DrawTool;
  color: string;
  previousColor: string;
  brushSize: number;
  eraserSize: number;
  canUndo: boolean;
  canRedo: boolean;
  disabled?: boolean;
  onToolChange: (tool: DrawTool) => void;
  onColorChange: (color: string) => void;
  onSwapColors: () => void;
  onBrushSizeChange: (size: number) => void;
  onEraserSizeChange: (size: number) => void;
  onUndo: () => void;
  onRedo: () => void;
  onClear: () => void;
};

const pressedStyle = { transform: [{ translateX: 2 }, { translateY: 2 }] };

const TOOLS: Array<{ id: DrawTool; label: string; icon: IconName }> = [
  { id: "brush", label: "BRUSH", icon: "brush" },
  { id: "fill", label: "FILL", icon: "fill" },
  { id: "eraser", label: "ERASER", icon: "eraser" },
  { id: "dropper", label: "PICK", icon: "dropper" },
  { id: "line", label: "LINE", icon: "line" },
  { id: "rect", label: "RECT", icon: "rect" },
  { id: "circle", label: "CIRCLE", icon: "ellipse" },
];

export default function DrawingToolbar({
  tool,
  color,
  previousColor,
  brushSize,
  eraserSize,
  canUndo,
  canRedo,
  disabled = false,
  onToolChange,
  onColorChange,
  onSwapColors,
  onBrushSizeChange,
  onEraserSizeChange,
  onUndo,
  onRedo,
  onClear,
}: Props) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [hexDraft, setHexDraft] = useState(color.replace("#", ""));
  const isEraser = tool === "eraser";
  const activeSize = isEraser ? eraserSize : brushSize;
  const setActiveSize = (next: number) => {
    const clamped = Math.max(2, Math.min(60, Math.round(next)));
    if (isEraser) onEraserSizeChange(clamped);
    else onBrushSizeChange(clamped);
  };

  const applyHex = () => {
    const value = `#${hexDraft.replace(/[^0-9a-fA-F]/g, "").slice(0, 6)}`;
    if (/^#[0-9a-fA-F]{6}$/.test(value)) {
      onColorChange(value);
      setPickerOpen(false);
    }
  };

  return (
    <View style={styles.dock}>
      {/* Row 1: active/previous split tile + 22-colour matrix */}
      <View style={styles.row}>
        <View style={styles.splitGroup}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Swap colours, active ${color} previous ${previousColor}`}
            disabled={disabled}
            onPress={onSwapColors}
            style={({ pressed }) => [styles.splitTile, pressed && pressedStyle]}
          >
            <View style={[styles.splitHalf, { backgroundColor: color }]} />
            <View style={[styles.splitHalf, styles.splitHalfBottom, { backgroundColor: previousColor }]} />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Custom colour"
            disabled={disabled}
            onPress={() => {
              setHexDraft(color.replace("#", ""));
              setPickerOpen(true);
            }}
            style={({ pressed }) => [styles.plusButton, pressed && pressedStyle]}
          >
            <Icon name="plus" size={16} strokeWidth={3} />
          </Pressable>
        </View>

        <View style={styles.matrix}>
          {COLOR_MATRIX.map((row, rowIndex) => (
            <View key={rowIndex} style={styles.matrixRow}>
              {row.map((swatch, columnIndex) => {
                const selected = color.toUpperCase() === swatch.toUpperCase();
                return (
                  <Pressable
                    key={swatch}
                    accessibilityRole="button"
                    accessibilityLabel={`Colour ${swatch}`}
                    accessibilityState={{ selected, disabled }}
                    disabled={disabled}
                    onPress={() => onColorChange(swatch)}
                    style={[
                      styles.matrixCell,
                      selected && styles.matrixCellActive,
                      columnIndex < row.length - 1 && styles.matrixDivider,
                    ]}
                  >
                    <View style={[styles.matrixSwatch, { backgroundColor: swatch }]} />
                  </Pressable>
                );
              })}
            </View>
          ))}
        </View>
      </View>

      {/* Row 2: tool pills */}
      <View style={styles.row}>
        {TOOLS.map((entry) => {
          const selected = tool === entry.id;
          return (
            <Pressable
              key={entry.id}
              accessibilityRole="button"
              accessibilityLabel={`${entry.label} tool`}
              accessibilityState={{ selected, disabled }}
              disabled={disabled}
              onPress={() => onToolChange(entry.id)}
              style={({ pressed }) => [
                styles.toolPill,
                selected && styles.toolPillActive,
                pressed && pressedStyle,
              ]}
            >
              <Icon name={entry.icon} size={15} strokeWidth={2.4} />
              <Text style={styles.toolText}>{entry.label}</Text>
            </Pressable>
          );
        })}
      </View>

      {/* Row 3: sizes + history */}
      <View style={styles.row}>
        <View style={styles.sizeGroup}>
          {SIZE_PRESETS.map((preset) => {
            const selected = activeSize === preset;
            return (
              <Pressable
                key={preset}
                accessibilityRole="button"
                accessibilityLabel={`${isEraser ? "Eraser" : "Brush"} size ${preset}`}
                accessibilityState={{ selected, disabled }}
                disabled={disabled}
                onPress={() => setActiveSize(preset)}
                style={({ pressed }) => [styles.sizeDot, selected && styles.sizeDotActive, pressed && pressedStyle]}
              >
                <View
                  style={{
                    width: Math.max(4, preset * 0.42),
                    height: Math.max(4, preset * 0.42),
                    borderRadius: preset,
                    backgroundColor: selected ? colors.ink : colors.surface,
                    borderWidth: 1.5,
                    borderColor: colors.ink,
                  }}
                />
              </Pressable>
            );
          })}
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Decrease size"
          disabled={disabled}
          onPress={() => setActiveSize(activeSize - 2)}
          style={({ pressed }) => [styles.stepButton, pressed && pressedStyle]}
        >
          <Text style={styles.stepText}>-</Text>
        </Pressable>
        <View style={styles.previewBox}>
          <View
            style={{
              width: Math.min(30, Math.max(4, activeSize * 0.55)),
              height: Math.min(30, Math.max(4, activeSize * 0.55)),
              borderRadius: activeSize,
              backgroundColor: isEraser ? colors.surface : color,
              borderWidth: 2,
              borderColor: colors.ink,
            }}
          />
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Increase size"
          disabled={disabled}
          onPress={() => setActiveSize(activeSize + 2)}
          style={({ pressed }) => [styles.stepButton, pressed && pressedStyle]}
        >
          <Text style={styles.stepText}>+</Text>
        </Pressable>

        <View style={styles.actionGroup}>
          <Action icon="undo" label="UNDO" accessibilityLabel="Undo last action" disabled={disabled || !canUndo} onPress={onUndo} />
          <Action icon="redo" label="REDO" accessibilityLabel="Redo action" disabled={disabled || !canRedo} onPress={onRedo} />
          <Action icon="trash" label="CLEAR" accessibilityLabel="Clear canvas" disabled={disabled} onPress={onClear} danger />
        </View>
      </View>

      <Modal visible={pickerOpen} transparent animationType="fade" onRequestClose={() => setPickerOpen(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>CUSTOM COLOUR</Text>
            {SHADES.map((shade, shadeIndex) => (
              <View key={shadeIndex} style={styles.hueRow}>
                {HUE_SWATCHES.map((hue) => {
                  const swatch = shade ?? hue;
                  return (
                    <Pressable
                      key={`${shadeIndex}-${hue}`}
                      accessibilityRole="button"
                      accessibilityLabel={`Pick ${swatch}`}
                      onPress={() => {
                        onColorChange(swatch);
                        setHexDraft(swatch.replace("#", ""));
                      }}
                      style={[styles.hueSwatch, { backgroundColor: swatch }, color.toUpperCase() === swatch.toUpperCase() && styles.hueActive]}
                    />
                  );
                })}
              </View>
            ))}
            <View style={styles.hexRow}>
              <Text style={styles.hexHash}>#</Text>
              <TextInput
                value={hexDraft}
                onChangeText={setHexDraft}
                autoCapitalize="characters"
                maxLength={6}
                placeholder="FFD60A"
                placeholderTextColor="#888"
                style={styles.hexInput}
              />
              <Pressable accessibilityRole="button" accessibilityLabel="Apply colour" onPress={applyHex} style={styles.hexApply}>
                <Text style={styles.hexApplyText}>APPLY</Text>
              </Pressable>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="Close colour picker" onPress={() => setPickerOpen(false)} style={styles.modalClose}>
              <Text style={styles.modalCloseText}>CLOSE</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function Action({
  icon,
  label,
  accessibilityLabel,
  disabled,
  onPress,
  danger = false,
}: {
  icon: IconName;
  label: string;
  accessibilityLabel: string;
  disabled: boolean;
  onPress: () => void;
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
      <Icon name={icon} size={13} strokeWidth={2.6} />
      <Text style={styles.actionText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  dock: {
    gap: 6,
    borderWidth: BORDER_WIDTH,
    borderColor: colors.ink,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
    padding: 6,
    marginRight: SHADOW_OFFSET,
    marginBottom: SHADOW_OFFSET,
    shadowColor: colors.ink,
    shadowOpacity: 1,
    shadowRadius: 0,
    shadowOffset: { width: SHADOW_OFFSET, height: SHADOW_OFFSET },
    elevation: 0,
  },
  row: { flexDirection: "row", alignItems: "center", gap: 5 },
  splitGroup: { flexDirection: "row", alignItems: "center", gap: 4 },
  splitTile: {
    width: 44,
    height: 44,
    borderWidth: BORDER_WIDTH,
    borderColor: colors.ink,
    borderRadius: 8,
    overflow: "hidden",
    backgroundColor: colors.surface,
  },
  splitHalf: { flex: 1 },
  splitHalfBottom: { borderTopWidth: 2, borderTopColor: colors.ink },
  plusButton: {
    width: 26,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: BORDER_WIDTH,
    borderColor: colors.ink,
    borderRadius: 8,
    backgroundColor: colors.yellow,
  },
  matrix: { flex: 1, borderWidth: 2, borderColor: colors.ink, borderRadius: 7, overflow: "hidden" },
  matrixRow: { flexDirection: "row" },
  matrixCell: { flex: 1, alignItems: "center", justifyContent: "center", paddingVertical: 3 },
  matrixCellActive: { backgroundColor: colors.gold },
  matrixDivider: { borderRightWidth: 1.5, borderRightColor: colors.ink },
  matrixSwatch: { width: 18, height: 18, borderRadius: 3, borderWidth: 1, borderColor: colors.ink },
  toolPill: {
    flex: 1,
    minHeight: 34,
    borderRadius: 8,
    borderWidth: BORDER_WIDTH,
    borderColor: colors.ink,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
    gap: 1,
    paddingHorizontal: 1,
  },
  toolPillActive: { backgroundColor: colors.gold },
  toolText: { fontSize: 7.5, fontWeight: "900", letterSpacing: 0.2, color: colors.ink },
  sizeGroup: { flexDirection: "row", alignItems: "center", gap: 3 },
  sizeDot: {
    width: 22,
    height: 30,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: colors.ink,
    borderRadius: 5,
    backgroundColor: colors.surface,
  },
  sizeDotActive: { backgroundColor: colors.gold },
  stepButton: {
    width: 22,
    height: 30,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: colors.ink,
    borderRadius: 5,
    backgroundColor: colors.surface,
  },
  stepText: { fontSize: 15, fontWeight: "900", color: colors.ink, lineHeight: 16 },
  previewBox: {
    width: 26,
    height: 30,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: colors.ink,
    borderRadius: 5,
    backgroundColor: colors.bg,
  },
  actionGroup: { flex: 1, flexDirection: "row", gap: 3, justifyContent: "flex-end" },
  action: {
    flexGrow: 1,
    flexBasis: 0,
    minWidth: 0,
    minHeight: 30,
    borderRadius: 5,
    borderWidth: 2,
    borderColor: colors.ink,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
    gap: 1,
  },
  actionDanger: { backgroundColor: colors.pink },
  actionDisabled: { opacity: 0.35 },
  actionText: { fontSize: 7, fontWeight: "900", letterSpacing: 0.2, color: colors.ink },
  modalBackdrop: { flex: 1, backgroundColor: colors.backdrop, alignItems: "center", justifyContent: "center", padding: 20 },
  modalCard: {
    width: "100%",
    maxWidth: 520,
    gap: 7,
    borderWidth: BORDER_WIDTH,
    borderColor: colors.ink,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
    padding: 14,
    shadowColor: colors.ink,
    shadowOpacity: 1,
    shadowRadius: 0,
    shadowOffset: { width: 6, height: 6 },
    elevation: 0,
  },
  modalTitle: { fontSize: 14, fontWeight: "900", letterSpacing: 1.2, color: colors.ink },
  hueRow: { flexDirection: "row", gap: 4 },
  hueSwatch: { flex: 1, height: 26, borderWidth: 2, borderColor: colors.ink, borderRadius: 5 },
  hueActive: { borderWidth: 4, borderColor: colors.ink },
  hexRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 },
  hexHash: { fontSize: 16, fontWeight: "900", color: colors.ink },
  hexInput: {
    flex: 1,
    height: 40,
    borderWidth: 2,
    borderColor: colors.ink,
    borderRadius: 7,
    paddingHorizontal: 8,
    fontWeight: "800",
    color: colors.ink,
    backgroundColor: colors.bg,
  },
  hexApply: {
    height: 40,
    paddingHorizontal: 12,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: colors.ink,
    borderRadius: 7,
    backgroundColor: colors.green,
  },
  hexApplyText: { fontSize: 10, fontWeight: "900", letterSpacing: 0.8, color: colors.ink },
  modalClose: {
    alignSelf: "flex-end",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 2,
    borderColor: colors.ink,
    borderRadius: 7,
    backgroundColor: colors.surface,
  },
  modalCloseText: { fontSize: 10, fontWeight: "900", letterSpacing: 0.8, color: colors.ink },
});
