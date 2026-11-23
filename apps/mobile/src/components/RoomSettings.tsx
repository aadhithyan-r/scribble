import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { RoomUpdate } from "../game/types";
import Icon from "./Icons";
import { BORDER_WIDTH, colors, radii, type } from "../theme";

export type SettingsPatch = {
  maxRounds?: number;
  drawSeconds?: number;
  maxPlayers?: number;
  customWordsEnabled?: boolean;
  allowSpectators?: boolean;
  requireInvite?: boolean;
  visibility?: "private" | "public";
};

type Props = {
  room: RoomUpdate;
  isHost: boolean;
  onConfigure: (patch: SettingsPatch) => void;
  onOpenWords: () => void;
};

const pressedStyle = { transform: [{ translateX: 2 }, { translateY: 2 }] };

function Stepper({
  label,
  hint,
  value,
  suffix,
  onDecrease,
  onIncrease,
  disabled,
}: {
  label: string;
  hint: string;
  value: number | string;
  suffix?: string;
  onDecrease: () => void;
  onIncrease: () => void;
  disabled: boolean;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.labels}>
        <Text style={styles.title}>{label}</Text>
        <Text style={styles.hint}>{hint}</Text>
      </View>
      {disabled ? (
        <View style={styles.valueBox}>
          <Text style={styles.value}>
            {value}
            {suffix ?? ""}
          </Text>
        </View>
      ) : (
        <View style={styles.stepper}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Decrease ${label}`}
            style={({ pressed }) => [styles.stepButton, pressed && pressedStyle]}
            onPress={onDecrease}
          >
            <Text style={styles.stepText}>−</Text>
          </Pressable>
          <View style={styles.valueBox}>
            <Text style={styles.value}>
              {value}
              {suffix ?? ""}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Increase ${label}`}
            style={({ pressed }) => [styles.stepButton, pressed && pressedStyle]}
            onPress={onIncrease}
          >
            <Text style={styles.stepText}>+</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

function Toggle({
  label,
  hint,
  value,
  onChange,
  disabled,
}: {
  label: string;
  hint: string;
  value: boolean;
  onChange: (next: boolean) => void;
  disabled: boolean;
}) {
  return (
    <Pressable
      style={({ pressed }) => [styles.row, disabled && styles.rowDisabled, pressed && !disabled && pressedStyle]}
      onPress={() => onChange(!value)}
      disabled={disabled}
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value, disabled }}
    >
      <View style={styles.labels}>
        <Text style={styles.title}>{label}</Text>
        <Text style={styles.hint}>{hint}</Text>
      </View>
      <View style={[styles.toggle, value && styles.toggleOn]}>
        <View style={[styles.knob, value && styles.knobOn]} />
        <Text style={styles.toggleText}>{value ? "ON" : "OFF"}</Text>
      </View>
    </Pressable>
  );
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export default function RoomSettings({ room, isHost, onConfigure, onOpenWords }: Props) {
  const locked = !isHost;
  // Older/partial room snapshots may omit the custom-word collections.
  const customCategories = room.customCategories ?? [];
  const customWordCount = room.customWordCount ?? 0;
  return (
    <View style={styles.card}>
      <View style={styles.headingRow}>
        <Text style={styles.heading}>GAME SETTINGS</Text>
        {locked ? <Icon name="lock" size={16} /> : null}
      </View>
      <Stepper
        label="Rounds"
        hint="Each player draws once per round"
        value={room.maxRounds}
        onDecrease={() => {
          const next = clamp(room.maxRounds - 1, 1, 10);
          if (next !== room.maxRounds) onConfigure({ maxRounds: next });
        }}
        onIncrease={() => {
          const next = clamp(room.maxRounds + 1, 1, 10);
          if (next !== room.maxRounds) onConfigure({ maxRounds: next });
        }}
        disabled={locked}
      />
      <Stepper
        label="Drawing time"
        hint="Seconds per turn (30–180)"
        value={room.drawSeconds}
        suffix="s"
        onDecrease={() => {
          const next = clamp(room.drawSeconds - 15, 30, 180);
          if (next !== room.drawSeconds) onConfigure({ drawSeconds: next });
        }}
        onIncrease={() => {
          const next = clamp(room.drawSeconds + 15, 30, 180);
          if (next !== room.drawSeconds) onConfigure({ drawSeconds: next });
        }}
        disabled={locked}
      />
      <Stepper
        label="Room size"
        hint="Players allowed in this room"
        value={room.maxPlayers}
        onDecrease={() => {
          const next = clamp(room.maxPlayers - 1, 2, 8);
          if (next !== room.maxPlayers) onConfigure({ maxPlayers: next });
        }}
        onIncrease={() => {
          const next = clamp(room.maxPlayers + 1, 2, 8);
          if (next !== room.maxPlayers) onConfigure({ maxPlayers: next });
        }}
        disabled={locked}
      />
      <Toggle
        label="Custom words"
        hint={
          customWordCount > 0
            ? `${customWordCount} words in ${customCategories.length} list(s)`
            : "Add custom word lists first"
        }
        value={room.customWordsEnabled}
        onChange={(next) => onConfigure({ customWordsEnabled: next })}
        disabled={locked}
      />
      {isHost ? (
        <Pressable
          style={({ pressed }) => [styles.linkRow, pressed && pressedStyle]}
          onPress={onOpenWords}
          accessibilityRole="button"
          accessibilityLabel="Manage custom words"
        >
          <View style={styles.linkCopy}>
            <Text style={styles.link}>MANAGE WORD LISTS</Text>
            <Text style={styles.linkMeta}>{customCategories.join(", ") || "none yet"}</Text>
          </View>
          <Icon name="arrowRight" size={16} />
        </Pressable>
      ) : null}
      <Toggle
        label="Allow spectators"
        hint="Late joiners watch without guessing or drawing"
        value={room.allowSpectators}
        onChange={(next) => onConfigure({ allowSpectators: next })}
        disabled={locked}
      />
      <Toggle
        label="Require invite link"
        hint="The room code alone will not let people in"
        value={room.requireInvite}
        onChange={(next) => onConfigure({ requireInvite: next })}
        disabled={locked}
      />
      <Toggle
        label="Public room"
        hint="Listed on the home screen for anyone to join"
        value={room.visibility === "public"}
        onChange={(next) => onConfigure({ visibility: next ? "public" : "private" })}
        disabled={locked || room.requireInvite}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    padding: 12,
    gap: 2,
    borderWidth: BORDER_WIDTH,
    borderColor: colors.ink,
  },
  headingRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingBottom: 6,
  },
  heading: { ...type.label, letterSpacing: 1.6 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    paddingVertical: 8,
    borderTopWidth: 2,
    borderTopColor: colors.ink,
  },
  rowDisabled: { opacity: 0.8 },
  labels: { flexShrink: 1, flex: 1 },
  title: { fontSize: 12.5, fontWeight: "900", color: colors.ink },
  hint: { fontSize: 9.5, fontWeight: "600", color: "#555", marginTop: 1, lineHeight: 13 },
  stepper: { flexDirection: "row", alignItems: "center", gap: 5 },
  stepButton: {
    width: 32,
    height: 32,
    borderRadius: 7,
    borderWidth: BORDER_WIDTH,
    borderColor: colors.ink,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.yellow,
  },
  stepText: { fontSize: 16, lineHeight: 18, fontWeight: "900", color: colors.ink },
  valueBox: {
    minWidth: 44,
    paddingHorizontal: 6,
    paddingVertical: 6,
    borderRadius: 7,
    borderWidth: 2,
    borderColor: colors.ink,
    backgroundColor: colors.bg,
    alignItems: "center",
    justifyContent: "center",
  },
  value: { fontSize: 13, fontWeight: "900", color: colors.ink },
  toggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    minWidth: 64,
    paddingHorizontal: 7,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: BORDER_WIDTH,
    borderColor: colors.ink,
    backgroundColor: colors.surface,
  },
  toggleOn: { backgroundColor: colors.yellow },
  knob: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.surface,
    borderWidth: 2,
    borderColor: colors.ink,
  },
  knobOn: { backgroundColor: colors.ink },
  toggleText: { fontSize: 9, fontWeight: "900", letterSpacing: 0.8, color: colors.ink },
  linkRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 9,
    borderTopWidth: 2,
    borderTopColor: colors.ink,
  },
  linkCopy: { flex: 1 },
  link: { fontSize: 11, fontWeight: "900", letterSpacing: 0.8, color: colors.ink, textDecorationLine: "underline" },
  linkMeta: { fontSize: 9.5, fontWeight: "600", color: "#555", marginTop: 1 },
});
