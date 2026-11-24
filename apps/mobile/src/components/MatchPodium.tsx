import React from "react";
import { StyleSheet, Text, View } from "react-native";
import type { MatchPlayerResult } from "../game/types";
import { Avatar } from "./Avatars";
import { BORDER_WIDTH, colors, monoFont, radii, type } from "../theme";

const PODIUM_GOLD = "#FFD60A";

function PodiumBlock({
  player,
  place,
  height,
  winner = false,
}: {
  player: MatchPlayerResult;
  place: 1 | 2 | 3;
  height: number;
  winner?: boolean;
}) {
  return (
    <View style={[styles.blockOuter, { flex: 1 }]}>
      <View pointerEvents="none" style={styles.blockShadow} />
      <View
        style={[
          styles.blockFace,
          { height, backgroundColor: winner ? PODIUM_GOLD : colors.surface },
        ]}
      >
        <Text style={styles.place}>{place === 1 ? "1ST" : place === 2 ? "2ND" : "3RD"}</Text>
        <View style={[styles.avatarFrame, winner && styles.avatarFrameWinner]}>
          <Avatar
            value={player.avatar}
            size={winner ? 58 : 44}
            showCrown={winner}
          />
        </View>
        <Text style={styles.name} numberOfLines={1}>
          {player.name}
        </Text>
        <Text style={styles.score}>{player.score}</Text>
      </View>
    </View>
  );
}

export default function MatchPodium({
  players,
  myProfileId,
}: {
  players: MatchPlayerResult[];
  myProfileId?: string;
}) {
  const ordered = [...players].sort((a, b) => a.rank - b.rank);
  const first = ordered[0];
  const second = ordered[1];
  const third = ordered[2];
  const rest = ordered.slice(3);

  return (
    <View style={styles.root}>
      <View style={styles.headingRow}>
        <Text style={styles.heading}>FINAL STANDINGS</Text>
        <Text style={styles.count}>{ordered.length} PLAYERS</Text>
      </View>

      <View style={styles.podiumRow}>
        {second ? (
          <PodiumBlock player={second} place={2} height={104} />
        ) : (
          <View style={styles.spacer} />
        )}
        {first ? <PodiumBlock player={first} place={1} height={142} winner /> : null}
        {third ? (
          <PodiumBlock player={third} place={3} height={90} />
        ) : (
          <View style={styles.spacer} />
        )}
      </View>

      {rest.length ? (
        <View style={styles.restList}>
          {rest.map((player) => (
            <View key={`${player.profileId ?? player.name}-${player.rank}`} style={styles.restRow}>
              <View style={styles.rankBox}>
                <Text style={styles.rankText}>{player.rank}</Text>
              </View>
              <Avatar value={player.avatar} size={30} />
              <Text style={styles.restName} numberOfLines={1}>
                {player.name}
                {player.profileId === myProfileId ? " (YOU)" : ""}
              </Text>
              <Text style={styles.restScore}>{player.score}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 8 },
  headingRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  heading: { ...type.label, letterSpacing: 1.4 },
  count: { ...type.tiny, fontSize: 8 },
  podiumRow: { flexDirection: "row", alignItems: "flex-end", gap: 5, paddingTop: 6 },
  spacer: { flex: 1 },
  blockOuter: { paddingRight: 3, paddingBottom: 3 },
  blockShadow: {
    position: "absolute",
    left: 3,
    top: 3,
    right: 0,
    bottom: 0,
    backgroundColor: colors.ink,
    borderRadius: 10,
  },
  blockFace: {
    borderWidth: BORDER_WIDTH,
    borderColor: colors.ink,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 2,
    paddingHorizontal: 5,
    paddingVertical: 7,
    overflow: "hidden",
  },
  place: { ...type.label, fontSize: 9, letterSpacing: 1 },
  avatarFrame: {
    alignItems: "center",
    justifyContent: "center",
    padding: 3,
    borderWidth: 2,
    borderColor: colors.ink,
    borderRadius: radii.pill,
    backgroundColor: colors.surface,
  },
  avatarFrameWinner: { backgroundColor: PODIUM_GOLD },
  name: { fontSize: 10.5, fontWeight: "900", color: colors.ink, maxWidth: "100%" },
  score: { fontSize: 12, fontWeight: "900", color: colors.ink, fontFamily: monoFont },
  restList: { gap: 5, marginTop: 2 },
  restRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    borderTopWidth: 2,
    borderTopColor: colors.ink,
    paddingTop: 6,
  },
  rankBox: {
    width: 26,
    height: 26,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: colors.ink,
    borderRadius: 6,
    backgroundColor: colors.bg,
  },
  rankText: { fontSize: 10, fontWeight: "900", color: colors.ink, fontFamily: monoFont },
  restName: { flex: 1, fontSize: 12, fontWeight: "900", color: colors.ink },
  restScore: { fontSize: 12, fontWeight: "900", color: colors.ink, fontFamily: monoFont },
});
