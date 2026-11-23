import React, { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { WordCategory } from "../game/types";
import Icon from "./Icons";
import { BrutalButton, BrutalInput, BrutalSheet } from "./Brutal";
import { BORDER_WIDTH, colors, radii, type } from "../theme";

type Props = {
  visible: boolean;
  initial: WordCategory[];
  onClose: () => void;
  onSave: (categories: WordCategory[]) => Promise<string | null>;
};

const parseWords = (value: string) =>
  value
    .split(/[,\n]/)
    .map((word) => word.replace(/\s+/g, " ").trim())
    .filter(Boolean);

export default function WordListEditor({ visible, initial, onClose, onSave }: Props) {
  const [categories, setCategories] = useState<WordCategory[]>(initial ?? []);
  const [name, setName] = useState("");
  const [words, setWords] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (visible) {
      setCategories(initial ?? []);
      setName("");
      setWords("");
      setEditing(null);
      setError(null);
    }
  }, [visible, initial]);

  const total = categories.reduce((sum, category) => sum + category.words.length, 0);

  const commitCategory = () => {
    const cleanName = name.replace(/\s+/g, " ").trim();
    const parsed = parseWords(words);
    if (!cleanName) {
      setError("Give the category a name.");
      return;
    }
    if (!parsed.length) {
      setError("Add at least one word.");
      return;
    }
    setError(null);
    setCategories((current) => {
      const next = [...current];
      if (editing != null) next[editing] = { name: cleanName, words: parsed };
      else next.push({ name: cleanName, words: parsed });
      return next;
    });
    setName("");
    setWords("");
    setEditing(null);
  };

  const removeCategory = (index: number) => {
    setCategories((current) => current.filter((_, position) => position !== index));
    if (editing === index) {
      setEditing(null);
      setName("");
      setWords("");
    }
  };

  const startEdit = (index: number) => {
    const category = categories[index]!;
    setEditing(index);
    setName(category.name);
    setWords(category.words.join(", "));
    setError(null);
  };

  const save = async () => {
    if (total < 3) {
      setError("Add at least 3 words before saving (or turn custom words off).");
      return;
    }
    setBusy(true);
    setError(null);
    const message = await onSave(categories);
    setBusy(false);
    if (message) setError(message);
    else onClose();
  };

  return (
    <BrutalSheet
      visible={visible}
      onClose={onClose}
      title="Word lists"
      footer={
        <BrutalButton
          label={busy ? "SAVING…" : "SAVE ALL"}
          onPress={() => void save()}
          disabled={busy}
          icon="check"
        />
      }
    >
      <Text style={styles.sub}>
        {total} word{total === 1 ? "" : "s"} · guests never see these until a word is chosen. Words are
        2–24 letters; spaces, hyphens and apostrophes are allowed.
      </Text>

      {categories.map((category, index) => (
        <View key={`${category.name}-${index}`} style={styles.categoryRow}>
          <Pressable
            style={styles.categoryCopy}
            onPress={() => startEdit(index)}
            accessibilityRole="button"
            accessibilityLabel={`Edit ${category.name}`}
          >
            <Text style={styles.categoryName}>{category.name}</Text>
            <Text style={styles.categoryMeta} numberOfLines={1}>
              {category.words.slice(0, 4).join(", ")}
              {category.words.length > 4 ? "…" : ""}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => removeCategory(index)}
            accessibilityRole="button"
            accessibilityLabel={`Remove ${category.name}`}
            hitSlop={6}
          >
            <Icon name="trash" size={17} />
          </Pressable>
        </View>
      ))}
      {categories.length === 0 ? <Text style={styles.empty}>No categories yet.</Text> : null}

      <Text style={styles.fieldLabel}>{editing != null ? "EDIT LIST" : "NEW LIST"}</Text>
      <BrutalInput
        value={name}
        onChangeText={setName}
        placeholder="Category name (e.g. Food)"
        maxLength={24}
        accessibilityLabel="Category name"
      />
      <BrutalInput
        value={words}
        onChangeText={setWords}
        placeholder="Words separated by commas or new lines"
        multiline
        maxLength={1200}
        accessibilityLabel="Category words"
        style={styles.wordsInput}
      />
      <BrutalButton
        label={editing != null ? "UPDATE LIST" : "ADD LIST"}
        color={colors.cyan}
        compact
        icon="plus"
        onPress={commitCategory}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </BrutalSheet>
  );
}

const styles = StyleSheet.create({
  sub: { fontSize: 10.5, lineHeight: 15, fontWeight: "600", color: "#555" },
  categoryRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 10,
    borderWidth: BORDER_WIDTH,
    borderColor: colors.ink,
    borderRadius: radii.sm,
    backgroundColor: colors.surface,
  },
  categoryCopy: { flex: 1 },
  categoryName: { fontSize: 12.5, fontWeight: "900", color: colors.ink },
  categoryMeta: { fontSize: 9.5, fontWeight: "600", color: "#555", marginTop: 2 },
  empty: { fontSize: 11, fontStyle: "italic", fontWeight: "600", color: colors.muted },
  fieldLabel: { ...type.label, marginBottom: -8 },
  wordsInput: { minHeight: 78, textAlignVertical: "top", fontSize: 12 },
  error: {
    borderWidth: 2,
    borderColor: colors.ink,
    borderRadius: 8,
    backgroundColor: colors.pink,
    color: colors.ink,
    padding: 8,
    fontSize: 11,
    fontWeight: "800",
  },
});
