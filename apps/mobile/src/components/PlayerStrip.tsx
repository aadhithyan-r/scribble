import React from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import type { PlayerInfo } from "../game/types";
import AvatarTile from "./Avatars";
import Icon from "./Icons";
import { BORDER_WIDTH, colors, radii, type } from "../theme";

type Props = {
  players: PlayerInfo[];
  drawerId?: string;
  hostId: string;
  meId?: string;
  guessedIds?: string[];
  spectatorCount?: number;
};

export default function PlayerStrip({
  players,
  drawerId,
  hostId,
  meId,
  guessedIds = [],
  spectatorCount = 0,
}: Props) {
  const roster = players ?? [];
  const guessed = guessedIds ?? [];
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.content}
      accessibilityLabel={`Players: ${roster.map((player) => player.name).join(", ")}`}
    >
      {roster.map((player) => {
        const isDrawer = player.id === drawerId;
        const isMe = player.id === meId;
        const hasGuessed = guessed.includes(player.id);
        return (
          <View
            key={player.id}
            style={[
              styles.chip,
              isDrawer && styles.chipDrawer,
              player.reconnecting && styles.chipReconnecting,
              !player.connected && styles.chipOffline,
            ]}
          >
            <AvatarTile value={player.avatar} size={34} hasCrown={player.id === hostId} />
            <View style={styles.names}>
              <Text style={styles.name} numberOfLines={1}>
                {player.name}
                {isMe ? " (you)" : ""}
              </Text>
              <View style={styles.metaRow}>
                <Text style={styles.score}>{player.score}</Text>
                {isDrawer ? <Icon name="brush" size={11} /> : null}
                {hasGuessed ? <Icon name="check" size={11} /> : null}
                {player.reconnecting || !player.connected ? (
                  <Text style={styles.status}>{player.reconnecting ? "RECONNECTING" : "OFFLINE"}</Text>
                ) : null}
              </View>
            </View>
          </View>
        );
      })}
      {spectatorCount > 0 ? (
        <View style={[styles.chip, styles.spectatorChip]}>
          <View style={styles.eyeBadge}>
            <Icon name="eye" size={16} />
          </View>
          <View style={styles.names}>
            <Text style={styles.name}>{spectatorCount} watching</Text>
            <Text style={styles.score}>spectators</Text>
          </View>
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { gap: 8, paddingVertical: 2, paddingRight: 8 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    backgroundColor: colors.surface,
    borderRadius: radii.sm,
    paddingVertical: 5,
    paddingHorizontal: 6,
    borderWidth: BORDER_WIDTH,
    borderColor: colors.ink,
    minWidth: 132,
  },
  chipDrawer: { backgroundColor: colors.yellow },
  chipOffline: { opacity: 0.55 },
  chipReconnecting: { backgroundColor: colors.amber },
  spectatorChip: { backgroundColor: colors.cyan },
  eyeBadge: {
    width: 34,
    height: 34,
    borderRadius: 9,
    borderWidth: 2,
    borderColor: colors.ink,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  names: { flexShrink: 1 },
  name: { fontSize: 12, fontWeight: "900", color: colors.ink, maxWidth: 104 },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 1 },
  score: { fontSize: 10, fontWeight: "900", color: "#333", letterSpacing: 0.4 },
  status: { ...type.tiny, fontSize: 7.5, letterSpacing: 0.4 },
});
