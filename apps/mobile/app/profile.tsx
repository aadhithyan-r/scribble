import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { router } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { socket } from "../src/socket";
import { deleteAccount, ensureIdentity, logout, rememberProfile } from "../src/auth";
import { getIdentity } from "../src/profile";
import { clearSession } from "../src/session";
import { request } from "../src/request";
import { normalizeAvatar } from "../src/game/avatars";
import { saveAvatarPref } from "../src/avatarPrefs";
import type { LeaderboardRow, MatchRecord, Profile } from "../src/game/types";
import AvatarTile from "../src/components/Avatars";
import AvatarRack from "../src/components/AvatarRack";
import {
  BrutalButton,
  BrutalCard,
  BrutalIconButton,
  BrutalInput,
  BrutalPill,
} from "../src/components/Brutal";
import { BORDER_WIDTH, colors, monoFont, radii, type } from "../src/theme";

export default function ProfileScreen() {
  const stored = getIdentity();
  const [name, setName] = useState(stored?.name ?? "Player");
  const [avatar, setAvatar] = useState(normalizeAvatar(stored?.avatar));
  const [profile, setProfile] = useState<Profile | null>(null);
  const [accuracy, setAccuracy] = useState(0);
  const [history, setHistory] = useState<MatchRecord[]>([]);
  const [board, setBoard] = useState<LeaderboardRow[]>([]);
  const [editing, setEditing] = useState(!stored);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const identity = await ensureIdentity(name.trim() || "Player", avatar);
      setName(identity.name);
      setAvatar(normalizeAvatar(identity.avatar));

      const [me, leaderboard] = await Promise.all([
        request("profile:me"),
        request("leaderboard:global", { limit: 20 }),
      ]);
      if (me.ok && me.profile) {
        setProfile(me.profile);
        setAccuracy(me.accuracy ?? 0);
        setHistory(me.history ?? []);
      }
      if (leaderboard.ok) setBoard(leaderboard.rows ?? []);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Check that the game server is running.");
    } finally {
      setLoading(false);
    }
    // name/avatar are initial values only; edits go through save()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    if (!name.trim()) {
      setError("Pick a nickname first.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await saveAvatarPref(avatar);
      const response = await request("profile:update", { name: name.trim(), avatar });
      if (!response.ok || !response.profile) {
        setError(response.error ?? "Could not save your profile.");
        return;
      }
      setProfile(response.profile);
      rememberProfile(response.profile);
      setEditing(false);
      await load();
    } finally {
      setSaving(false);
    }
  };

  const signOut = () => {
    Alert.alert(
      "Sign out?",
      "Your guest account and stats stay on the server. You can start a new guest next time.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Sign out",
          style: "destructive",
          onPress: () => {
            void logout()
              .catch(() => undefined)
              .finally(() => {
                clearSession();
                socket.disconnect();
                router.replace("/");
              });
          },
        },
      ],
    );
  };

  const removeAccount = () => {
    Alert.alert(
      "Delete your account?",
      "This permanently removes your guest account, stats, custom words and sessions. Past match records will show 'Deleted player'. This cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            void deleteAccount()
              .then(() => {
                clearSession();
                socket.disconnect();
                router.replace("/");
              })
              .catch((failure: unknown) =>
                setError(failure instanceof Error ? failure.message : "Could not delete your account."),
              );
          },
        },
      ],
    );
  };

  return (
    <SafeAreaView style={s.page} edges={["top", "bottom"]}>
      <View style={s.topBar}>
        <BrutalIconButton
          icon="chevronLeft"
          accessibilityLabel="Back"
          onPress={() => router.back()}
          size={42}
        />
        <Text style={s.screenTitle}>PROFILE</Text>
        <View style={s.topSpacer} />
      </View>

      <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
        <BrutalCard bodyStyle={s.heroBody}>
          <View style={s.heroTop}>
            <AvatarTile value={avatar} size={78} />
            <View style={s.heroCopy}>
              {editing ? (
                <BrutalInput
                  value={name}
                  onChangeText={setName}
                  maxLength={18}
                  placeholder="Your nickname"
                  accessibilityLabel="Profile nickname"
                  autoCorrect={false}
                />
              ) : (
                <Text style={s.name}>{profile?.name ?? name}</Text>
              )}
              <Text style={s.meta}>
                {profile
                  ? `${profile.stats.gamesPlayed} games · ${profile.stats.gamesWon} wins · ${accuracy}% accuracy`
                  : "No games yet"}
              </Text>
            </View>
          </View>

          {editing ? (
            <>
              <AvatarRack value={avatar} onChange={setAvatar} title="AVATAR" />
              <View style={s.editActions}>
                <BrutalButton
                  label={saving ? "SAVING…" : "SAVE PROFILE"}
                  onPress={() => void save()}
                  disabled={saving}
                  style={s.saveButton}
                />
                {profile ? (
                  <Pressable onPress={() => setEditing(false)} accessibilityRole="button">
                    <Text style={s.cancel}>CANCEL</Text>
                  </Pressable>
                ) : null}
              </View>
            </>
          ) : (
            <BrutalButton
              label="EDIT NAME & AVATAR"
              color={colors.surface}
              icon="brush"
              onPress={() => setEditing(true)}
            />
          )}

          <View style={s.statsRow}>
            <Stat label="GAMES" value={profile?.stats.gamesPlayed ?? 0} color={colors.yellow} />
            <Stat label="WINS" value={profile?.stats.gamesWon ?? 0} color={colors.green} />
            <Stat label="POINTS" value={profile?.stats.totalPoints ?? 0} color={colors.cyan} />
            <Stat label="ACCURACY" value={`${accuracy}%`} color={colors.amber} />
          </View>

          {loading ? <ActivityIndicator color={colors.ink} style={{ marginTop: 8 }} /> : null}
          {error ? <Text style={s.error}>{error}</Text> : null}

          <View style={s.accountActions}>
            <Pressable onPress={signOut} accessibilityRole="button" accessibilityLabel="Sign out">
              <Text style={s.accountAction}>SIGN OUT</Text>
            </Pressable>
            <Pressable
              onPress={removeAccount}
              accessibilityRole="button"
              accessibilityLabel="Delete account"
            >
              <Text style={s.accountDanger}>DELETE ACCOUNT</Text>
            </Pressable>
          </View>
        </BrutalCard>

        <Text style={s.section}>MATCH HISTORY</Text>
        <BrutalCard bodyStyle={s.listBody}>
          {history.length === 0 ? (
            <Text style={s.empty}>Finish a game to build your history.</Text>
          ) : (
            history.map((match, index) => {
              const me = match.players.find((player) => player.profileId === profile?.id);
              const won = match.winners.includes(profile?.id ?? "");
              return (
                <View key={`${match.id}-${index}`} style={s.historyRow}>
                  <View style={s.historyCopy}>
                    <Text style={s.historyTitle}>
                      ROOM {match.roomCode} · {match.rounds} ROUND{match.rounds === 1 ? "" : "S"}
                    </Text>
                    <Text style={s.historyMeta}>{new Date(match.at).toLocaleString()}</Text>
                  </View>
                  <BrutalPill
                    label={match.winners.length > 1 ? "SHARED" : won ? "WIN" : "LOSS"}
                    color={won ? colors.green : colors.gray}
                  />
                  <Text style={s.historyScore}>
                    #{me?.rank ?? "–"} · {me?.score ?? 0}
                  </Text>
                </View>
              );
            })
          )}
        </BrutalCard>

        <Text style={s.section}>GLOBAL LEADERBOARD</Text>
        <BrutalCard bodyStyle={s.listBody}>
          {board.length === 0 ? (
            <Text style={s.empty}>No completed games yet.</Text>
          ) : (
            board.map((row) => (
              <View key={row.profileId} style={s.boardRow}>
                <Text style={s.rank}>{row.rank}</Text>
                <AvatarTile value={row.avatar} size={30} hasCrown={row.rank === 1} />
                <View style={s.boardCopy}>
                  <Text style={s.boardName} numberOfLines={1}>
                    {row.name}
                  </Text>
                  <Text style={s.historyMeta}>
                    {row.wins}W / {row.gamesPlayed}G · {row.accuracy}%
                  </Text>
                </View>
                <Text style={s.boardPoints}>{row.points}</Text>
              </View>
            ))
          )}
        </BrutalCard>

        <Text style={s.footer}>
          Your account, stats and room seat are saved securely on this device.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function Stat({ label, value, color }: { label: string; value: number | string; color: string }) {
  return (
    <View style={[s.stat, { backgroundColor: color }]}>
      <Text style={s.statValue}>{value}</Text>
      <Text style={s.statLabel}>{label}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  screenTitle: { ...type.label, fontSize: 13, letterSpacing: 3 },
  topSpacer: { width: 46 },
  content: { padding: 16, paddingBottom: 34, gap: 12, width: "100%", maxWidth: 560, alignSelf: "center" },
  heroBody: { padding: 16, gap: 12 },
  heroTop: { flexDirection: "row", alignItems: "center", gap: 12 },
  heroCopy: { flex: 1, gap: 4 },
  name: { fontSize: 24, fontWeight: "900", letterSpacing: -0.8, color: colors.ink },
  meta: { fontSize: 11, fontWeight: "600", color: "#4A4A4A" },
  editActions: { flexDirection: "row", alignItems: "center", gap: 14 },
  saveButton: { flex: 1 },
  cancel: { fontSize: 11, fontWeight: "900", letterSpacing: 1, color: colors.muted },
  statsRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingTop: 2 },
  stat: {
    flexGrow: 1,
    minWidth: "45%",
    borderWidth: BORDER_WIDTH,
    borderColor: colors.ink,
    borderRadius: radii.sm,
    paddingVertical: 9,
    paddingHorizontal: 10,
  },
  statValue: { fontSize: 18, fontWeight: "900", color: colors.ink, letterSpacing: -0.5 },
  statLabel: { fontSize: 8.5, fontWeight: "900", letterSpacing: 1, color: colors.ink, marginTop: 1 },
  error: { color: colors.ink, backgroundColor: colors.pink, borderWidth: 2, borderColor: colors.ink, borderRadius: 8, padding: 8, fontSize: 11, fontWeight: "800" },
  accountActions: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    borderTopWidth: BORDER_WIDTH,
    borderTopColor: colors.ink,
    paddingTop: 12,
  },
  accountAction: { fontSize: 10.5, fontWeight: "900", letterSpacing: 1, color: colors.ink, textDecorationLine: "underline" },
  accountDanger: { fontSize: 10.5, fontWeight: "900", letterSpacing: 1, color: "#C31E24", textDecorationLine: "underline" },
  section: { ...type.label, letterSpacing: 2, marginTop: 8 },
  listBody: { padding: 0 },
  empty: { ...type.body, color: "#555", padding: 14 },
  historyRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 2,
    borderBottomColor: colors.ink,
  },
  historyCopy: { flex: 1 },
  historyTitle: { fontSize: 11, fontWeight: "900", letterSpacing: 0.6, color: colors.ink },
  historyMeta: { fontSize: 9.5, fontWeight: "600", color: "#555", marginTop: 2 },
  historyScore: { fontSize: 11, fontWeight: "900", color: colors.ink, fontFamily: monoFont },
  boardRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderBottomWidth: 2,
    borderBottomColor: colors.ink,
  },
  rank: { width: 20, fontSize: 13, fontWeight: "900", color: colors.ink, fontFamily: monoFont },
  boardCopy: { flex: 1 },
  boardName: { fontSize: 12, fontWeight: "900", color: colors.ink },
  boardPoints: { fontSize: 12, fontWeight: "900", color: colors.ink, fontFamily: monoFont },
  footer: { ...type.tiny, textAlign: "center", fontSize: 9, lineHeight: 14, marginTop: 4 },
});
