import React, { useRef, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import type { ChatMessage } from "../game/types";
import Icon from "./Icons";
import { BORDER_WIDTH, colors, radii } from "../theme";

type Props = {
  messages: ChatMessage[];
  meId?: string;
  disabled: boolean;
  placeholder: string;
  guessed: boolean;
  /** Portrait bottom bar or landscape side column. */
  style?: StyleProp<ViewStyle>;
  onSend: (text: string) => void;
};

export default function ChatPanel({
  messages,
  meId,
  disabled,
  placeholder,
  guessed,
  style,
  onSend,
}: Props) {
  const [value, setValue] = useState("");
  const listRef = useRef<ScrollView>(null);
  const canSend = !disabled && value.trim().length > 0;
  const history = messages ?? [];

  const send = () => {
    const text = value.trim();
    if (!text || disabled) return;
    onSend(text);
    setValue("");
  };

  return (
    <View style={[styles.panel, style]}>
      <ScrollView
        ref={listRef}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
        accessibilityLabel="Chat and guesses"
        keyboardShouldPersistTaps="handled"
      >
        {history.length === 0 ? (
          <Text style={styles.empty}>
            {guessed ? "You guessed it. Watch the others sweat." : "Chat and guesses appear here."}
          </Text>
        ) : (
          history.map((message) => {
            if (message.kind === "system") {
              return (
                <Text key={message.id} style={styles.system}>
                  {message.text}
                </Text>
              );
            }
            if (message.kind === "correct") {
              return (
                <View key={message.id} style={styles.correctBubble}>
                  <Icon name="check" size={12} />
                  <Text style={styles.correctText}>{message.text}</Text>
                </View>
              );
            }
            const mine = message.playerId != null && message.playerId === meId;
            return (
              <View key={message.id} style={[styles.bubble, mine && styles.bubbleMine]}>
                <Text style={styles.author}>{message.name ?? "Player"}</Text>
                <Text style={styles.message}>{message.text}</Text>
              </View>
            );
          })
        )}
      </ScrollView>

      <View style={styles.inputRow}>
        <TextInput
          style={[styles.input, disabled && styles.inputDisabled]}
          value={value}
          onChangeText={setValue}
          placeholder={guessed ? "Guessed it — say hi" : placeholder}
          placeholderTextColor={colors.muted}
          selectionColor={colors.ink}
          editable={!disabled}
          maxLength={100}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="send"
          onSubmitEditing={send}
          accessibilityLabel={placeholder}
          blurOnSubmit={false}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send message"
          accessibilityState={{ disabled: !canSend }}
          style={({ pressed }) => [
            styles.send,
            !canSend && styles.sendDisabled,
            pressed && canSend && styles.sendPressed,
          ]}
          disabled={!canSend}
          onPress={send}
        >
          <Icon name="arrowRight" size={18} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    height: 176,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: BORDER_WIDTH,
    borderColor: colors.ink,
    paddingTop: 7,
    paddingHorizontal: 7,
    paddingBottom: 7,
    gap: 6,
  },
  list: { flex: 1 },
  listContent: { gap: 5, paddingBottom: 3 },
  empty: { fontSize: 11, fontStyle: "italic", fontWeight: "600", color: colors.muted },
  bubble: {
    borderWidth: 2,
    borderColor: colors.ink,
    borderRadius: 8,
    backgroundColor: colors.bg,
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  bubbleMine: { backgroundColor: colors.amber },
  author: { fontSize: 9, fontWeight: "900", letterSpacing: 0.6, color: colors.ink, textTransform: "uppercase" },
  message: { fontSize: 12, lineHeight: 16, fontWeight: "600", color: "#1A1A1A" },
  system: {
    fontSize: 9,
    lineHeight: 13,
    fontWeight: "800",
    letterSpacing: 0.6,
    color: colors.muted,
    textAlign: "center",
    textTransform: "uppercase",
  },
  correctBubble: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    alignSelf: "flex-start",
    borderWidth: 2,
    borderColor: colors.ink,
    borderRadius: 8,
    backgroundColor: colors.green,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  correctText: { fontSize: 11, lineHeight: 15, fontWeight: "900", color: colors.ink },
  inputRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  input: {
    flex: 1,
    height: 42,
    borderWidth: BORDER_WIDTH,
    borderColor: colors.ink,
    borderRadius: radii.sm,
    backgroundColor: colors.bg,
    paddingHorizontal: 10,
    fontSize: 13,
    fontWeight: "600",
    color: colors.ink,
  },
  inputDisabled: { opacity: 0.55 },
  send: {
    width: 42,
    height: 42,
    borderRadius: radii.sm,
    borderWidth: BORDER_WIDTH,
    borderColor: colors.ink,
    backgroundColor: colors.yellow,
    alignItems: "center",
    justifyContent: "center",
  },
  sendDisabled: { opacity: 0.35 },
  sendPressed: { transform: [{ translateX: 2 }, { translateY: 2 }] },
});
