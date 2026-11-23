import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { Avatar } from "./Avatars";
import { BrutalIconButton } from "./Brutal";
import { cycleAvatar, randomAvatar, type AvatarLayer } from "../game/avatars";
import { BORDER_WIDTH, colors, radii, type } from "../theme";

type LayerSpec = {
  layer: AvatarLayer;
  label: string;
};

const LAYERS: LayerSpec[] = [
  { layer: "color", label: "COLOR" },
  { layer: "eyes", label: "EYES" },
  { layer: "mouth", label: "MOUTH" },
];

function Arrow({
  direction,
  label,
  onPress,
}: {
  direction: "left" | "right";
  label: string;
  onPress: () => void;
}) {
  return (
    <View style={[styles.arrowSlot, direction === "right" && styles.arrowSlotRight]}>
      <Text style={[styles.arrowLabel, direction === "right" && styles.arrowLabelRight]}>
        {label}
      </Text>
      <BrutalIconButton
        icon={direction === "left" ? "chevronLeft" : "chevronRight"}
        size={32}
        color={colors.surface}
        accessibilityLabel={`Previous ${label.toLowerCase()}`}
        onPress={onPress}
      />
    </View>
  );
}

/**
 * Three stacked arrow pairs flanking a live avatar preview: color, eyes, mouth.
 * The dice button rolls all three layers at once.
 */
export default function AvatarRack({
  value,
  onChange,
  size = 108,
  title = "YOUR CHARACTER",
}: {
  value: string;
  onChange: (next: string) => void;
  size?: number;
  title?: string;
}) {
  return (
    <View style={styles.wrap}>
      <View style={styles.header}>
        <Text style={styles.title}>{title}</Text>
        <BrutalIconButton
          icon="dice"
          size={32}
          color={colors.lime}
          accessibilityLabel="Randomize avatar"
          onPress={() => onChange(randomAvatar())}
        />
      </View>

      <View style={styles.rack}>
        <View style={styles.column}>
          {LAYERS.map(({ layer, label }) => (
            <Arrow
              key={layer}
              direction="left"
              label={label}
              onPress={() => onChange(cycleAvatar(value, layer, -1))}
            />
          ))}
        </View>

        <View style={{ paddingRight: 4, paddingBottom: 4 }}>
          <View pointerEvents="none" style={styles.previewShadow} />
          <View style={[styles.preview, { width: size, height: size }]}>
            <Avatar value={value} size={size - 10} />
          </View>
        </View>

        <View style={styles.column}>
          {LAYERS.map(({ layer, label }) => (
            <Arrow
              key={layer}
              direction="right"
              label={label}
              onPress={() => onChange(cycleAvatar(value, layer, 1))}
            />
          ))}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 6 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  title: { ...type.label, letterSpacing: 2 },
  rack: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 4,
  },
  column: { gap: 4 },
  arrowSlot: { height: 46, justifyContent: "space-between" },
  arrowSlotRight: { alignItems: "flex-end" },
  arrowLabel: {
    fontSize: 7.5,
    lineHeight: 9,
    fontWeight: "900",
    letterSpacing: 0.9,
    color: colors.ink,
  },
  arrowLabelRight: { textAlign: "right" },
  previewShadow: {
    position: "absolute",
    left: 4,
    top: 4,
    right: 0,
    bottom: 0,
    backgroundColor: colors.ink,
    borderRadius: radii.lg,
  },
  preview: {
    borderRadius: radii.lg,
    borderWidth: BORDER_WIDTH,
    borderColor: colors.ink,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
});
