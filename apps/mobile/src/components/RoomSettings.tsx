import React, { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { CustomWordsMode, RoomUpdate } from "../game/types";
import {
  TOTAL_CURATED_WORDS,
  WORD_CATEGORIES,
  parseCustomWords,
  wordCategoryLabel,
  type WordCategoryId,
  type WordMode,
} from "../game/words";
import Icon from "./Icons";
import { BORDER_WIDTH, colors, radii, type } from "../theme";

export type SettingsPatch = {
  maxRounds?: number;
  drawSeconds?: number;
  maxPlayers?: number;
  customWordsEnabled?: boolean;
  customWords?: string;
  customWordsMode?: CustomWordsMode;
  allowSpectators?: boolean;
  requireInvite?: boolean;
  visibility?: "private" | "public";
  wordMode?: WordMode;
  wordCategory?: WordCategoryId | null;
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

function ModeButton({
  label,
  hint,
  active,
  icon,
  onPress,
}: {
  label: string;
  hint: string;
  active: boolean;
  icon: "dice" | "star";
  onPress: () => void;
}) {
  return (
    <View style={styles.modeOption}>
      <View pointerEvents="none" style={styles.choiceShadow} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label} word mode`}
        accessibilityState={{ selected: active }}
        onPress={onPress}
        style={({ pressed }) => [
          styles.modeFace,
          active && styles.modeFaceActive,
          pressed && pressedStyle,
        ]}
      >
        <Icon name={icon} size={17} />
        <View style={styles.modeCopy}>
          <Text style={styles.modeLabel}>{label}</Text>
          <Text style={styles.modeHint}>{hint}</Text>
        </View>
      </Pressable>
    </View>
  );
}

function PackModeButton({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <View style={styles.packOption}>
      <View pointerEvents="none" style={styles.packShadow} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Custom words ${label}`}
        accessibilityState={{ selected: active }}
        onPress={onPress}
        style={({ pressed }) => [
          styles.packFace,
          active && styles.packFaceActive,
          pressed && pressedStyle,
        ]}
      >
        <Text style={styles.packLabel} numberOfLines={1}>
          {label}
        </Text>
      </Pressable>
    </View>
  );
}

function CategoryChip({
  label,
  count,
  active,
  onPress,
}: {
  label: string;
  count: number;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <View style={styles.categoryOption}>
      <View pointerEvents="none" style={styles.choiceShadow} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label} category, ${count} words`}
        accessibilityState={{ selected: active }}
        onPress={onPress}
        style={({ pressed }) => [
          styles.categoryFace,
          active && styles.categoryFaceActive,
          pressed && pressedStyle,
        ]}
      >
        <Text style={styles.categoryLabel} numberOfLines={2}>
          {label}
        </Text>
        <View style={[styles.categoryCount, active && styles.categoryCountActive]}>
          <Text style={styles.categoryCountText}>{count}</Text>
        </View>
      </Pressable>
    </View>
  );
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export default function RoomSettings({
  room,
  isHost,
  onConfigure,
  onOpenWords,
}: Props) {
  const locked = !isHost;
  // Older/partial room snapshots may omit the custom-word collections.
  const customCategories = room.customCategories ?? [];
  const customWordCount = room.customWordCount ?? 0;
  const savedWordCount = room.savedWordCount ?? 0;
  const wordMode: WordMode = room.wordMode ?? "random";
  const wordCategory: WordCategoryId = room.wordCategory ?? "animals";
  const customWordsMode: CustomWordsMode = room.customWordsMode ?? "off";
  const [customWordsDraft, setCustomWordsDraft] = useState(() =>
    (room.customWords ?? []).join(", "),
  );
  const parsedWords = parseCustomWords(customWordsDraft);
  const updatePack = (mode: CustomWordsMode, draft = customWordsDraft) =>
    onConfigure(
      mode === "off"
        ? { customWordsMode: mode }
        : { customWordsMode: mode, customWords: draft },
    );
  return (
    <View style={styles.card}>
      <View style={styles.headingRow}>
        <Text style={styles.heading}>GAME SETTINGS</Text>
        {locked ? <Icon name="lock" size={16} /> : null}
      </View>
      <View style={styles.wordModeSection}>
        <View style={styles.labels}>
          <Text style={styles.title}>Word mode</Text>
          <Text style={styles.hint}>
            {isHost ? "Choose the pool for this room" : "Host's live selection"}
          </Text>
        </View>
        {isHost ? (
          <>
            <View style={styles.modeRow}>
              <ModeButton
                label="RANDOM MIX"
                hint={`ALL ${TOTAL_CURATED_WORDS} WORDS`}
                icon="dice"
                active={wordMode === "random"}
                onPress={() => onConfigure({ wordMode: "random", wordCategory: null })}
              />
              <ModeButton
                label="BY CATEGORY"
                hint="PICK A THEME"
                icon="star"
                active={wordMode === "category"}
                onPress={() =>
                  onConfigure({ wordMode: "category", wordCategory })
                }
              />
            </View>
            {wordMode === "category" ? (
              <View style={styles.categoryGrid}>
                {WORD_CATEGORIES.map((category) => (
                  <CategoryChip
                    key={category.id}
                    label={category.label}
                    count={category.count}
                    active={wordCategory === category.id}
                    onPress={() =>
                      onConfigure({ wordMode: "category", wordCategory: category.id })
                    }
                  />
                ))}
              </View>
            ) : null}
          </>
        ) : (
          <View style={styles.readOnlyPill}>
            <Icon name={wordMode === "random" ? "dice" : "star"} size={14} />
            <Text style={styles.readOnlyText}>
              {wordMode === "category"
                ? `CATEGORY: ${wordCategoryLabel(wordCategory)}`
                : "MODE: RANDOM MIX"}
            </Text>
          </View>
        )}
      </View>
      <View style={styles.wordModeSection}>
        <View style={styles.labels}>
          <Text style={styles.title}>Custom words</Text>
          <Text style={styles.hint}>
            {isHost ? "Add your own pack to this room" : "Host's word pack"}
          </Text>
        </View>
        {isHost ? (
          <>
            <View style={styles.packModeRow}>
              <PackModeButton
                label="OFF"
                active={customWordsMode === "off"}
                onPress={() => updatePack("off")}
              />
              <PackModeButton
                label="MIX IN"
                active={customWordsMode === "mix"}
                onPress={() => updatePack("mix")}
              />
              <PackModeButton
                label="CUSTOM ONLY"
                active={customWordsMode === "only"}
                onPress={() => updatePack("only")}
              />
            </View>
            {customWordsMode !== "off" ? (
              <>
                <TextInput
                  style={styles.packInput}
                  value={customWordsDraft}
                  onChangeText={(text) => {
                    setCustomWordsDraft(text);
                    // Sync while typing so tapping START cannot race a blur.
                    onConfigure({ customWordsMode, customWords: text });
                  }}
                  onBlur={() => updatePack(customWordsMode)}
                  placeholder="Add words separated by commas..."
                  placeholderTextColor={colors.muted}
                  selectionColor={colors.ink}
                  multiline
                  maxLength={5000}
                  autoCapitalize="none"
                  autoCorrect={false}
                  accessibilityLabel="Custom words, separated by commas"
                />
                <View style={styles.packMetaRow}>
                  <View style={styles.packCountPill}>
                    <Text style={styles.packCountText}>{parsedWords.length} WORDS READY</Text>
                  </View>
                  {customWordsMode === "only" && parsedWords.length < 3 ? (
                    <View style={styles.packWarningPill}>
                      <Icon name="info" size={11} />
                      <Text style={styles.packWarningText}>ADD AT LEAST 3 WORDS</Text>
                    </View>
                  ) : null}
                </View>
              </>
            ) : null}
          </>
        ) : (
          <View style={styles.readOnlyPill}>
            <Icon name="info" size={14} />
            <Text style={styles.readOnlyText}>
              {customWordsMode === "off"
                ? "CUSTOM PACK: OFF"
                : `CUSTOM PACK: ${room.customWordCount ?? 0} WORDS (${customWordsMode === "mix" ? "MIX" : "ONLY"})`}
            </Text>
          </View>
        )}
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
        label="Saved word lists"
        hint={
          savedWordCount > 0
            ? `${savedWordCount} words in ${customCategories.length} list(s)`
            : "Add saved word lists first"
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
  wordModeSection: { gap: 7, paddingBottom: 9 },
  modeRow: { flexDirection: "row", gap: 6 },
  modeOption: { flex: 1, paddingRight: 3, paddingBottom: 3 },
  choiceShadow: {
    position: "absolute",
    left: 3,
    top: 3,
    right: 0,
    bottom: 0,
    backgroundColor: colors.ink,
    borderRadius: 9,
  },
  modeFace: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingHorizontal: 8,
    paddingVertical: 7,
    borderWidth: BORDER_WIDTH,
    borderColor: colors.ink,
    borderRadius: 9,
    backgroundColor: colors.surface,
  },
  modeFaceActive: { backgroundColor: colors.gold },
  modeCopy: { flex: 1 },
  modeLabel: { fontSize: 10, fontWeight: "900", letterSpacing: 0.7, color: colors.ink },
  modeHint: { fontSize: 8, fontWeight: "700", letterSpacing: 0.3, color: "#555", marginTop: 1 },
  readOnlyPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    padding: 8,
    borderWidth: BORDER_WIDTH,
    borderColor: colors.ink,
    borderRadius: 8,
    backgroundColor: colors.bg,
  },
  readOnlyText: { fontSize: 10, fontWeight: "900", letterSpacing: 0.6, color: colors.ink },
  categoryGrid: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  categoryOption: { width: "48.5%", paddingRight: 3, paddingBottom: 3 },
  categoryFace: {
    minHeight: 40,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 7,
    borderWidth: BORDER_WIDTH,
    borderColor: colors.ink,
    borderRadius: 8,
    backgroundColor: colors.surface,
  },
  categoryFaceActive: { backgroundColor: colors.gold },
  categoryLabel: {
    flex: 1,
    fontSize: 9,
    lineHeight: 11,
    fontWeight: "900",
    letterSpacing: 0.4,
    color: colors.ink,
  },
  categoryCount: {
    minWidth: 24,
    alignItems: "center",
    paddingVertical: 2,
    borderWidth: 2,
    borderColor: colors.ink,
    borderRadius: 5,
    backgroundColor: colors.bg,
  },
  categoryCountActive: { backgroundColor: colors.surface },
  categoryCountText: { fontSize: 8, fontWeight: "900", color: colors.ink },
  packModeRow: { flexDirection: "row", gap: 4 },
  packOption: { flex: 1, paddingRight: 2, paddingBottom: 2 },
  packShadow: {
    position: "absolute",
    left: 2,
    top: 2,
    right: 0,
    bottom: 0,
    backgroundColor: colors.ink,
    borderRadius: 7,
  },
  packFace: {
    minHeight: 34,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 4,
    paddingVertical: 6,
    borderWidth: 2,
    borderColor: colors.ink,
    borderRadius: 7,
    backgroundColor: colors.surface,
  },
  packFaceActive: { backgroundColor: colors.yellow },
  packLabel: { fontSize: 8, fontWeight: "900", letterSpacing: 0.4, color: colors.ink },
  packInput: {
    minHeight: 64,
    maxHeight: 110,
    borderWidth: BORDER_WIDTH,
    borderColor: colors.ink,
    borderRadius: 8,
    backgroundColor: colors.bg,
    paddingHorizontal: 9,
    paddingVertical: 8,
    fontSize: 12,
    fontWeight: "600",
    color: colors.ink,
    textAlignVertical: "top",
  },
  packMetaRow: { flexDirection: "row", flexWrap: "wrap", gap: 5 },
  packCountPill: {
    borderWidth: 2,
    borderColor: colors.ink,
    borderRadius: 6,
    backgroundColor: colors.lime,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  packCountText: { fontSize: 8, fontWeight: "900", letterSpacing: 0.5, color: colors.ink },
  packWarningPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderWidth: 2,
    borderColor: colors.ink,
    borderRadius: 6,
    backgroundColor: colors.amber,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  packWarningText: { fontSize: 8, fontWeight: "900", letterSpacing: 0.4, color: colors.ink },
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
