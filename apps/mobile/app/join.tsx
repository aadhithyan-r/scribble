import React, { useEffect, useState } from "react";
import { ActivityIndicator, Alert, StyleSheet, Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { setSession } from "../src/session";
import { ensureIdentity, rememberProfile } from "../src/auth";
import { getIdentity } from "../src/profile";
import { request } from "../src/request";
import { normalizeAvatar } from "../src/game/avatars";
import { loadAvatarPref } from "../src/avatarPrefs";
import AvatarTile from "../src/components/Avatars";
import { BrutalButton, BrutalCard, BrutalInput } from "../src/components/Brutal";
import { colors, monoFont, type } from "../src/theme";

export default function JoinByLink() {
  const params = useLocalSearchParams<{ code?: string; invite?: string }>();
  const code = (params.code ?? "").toString().trim().toUpperCase();
  const invite = (params.invite ?? "").toString().trim();
  const stored = getIdentity();
  const [avatar, setAvatar] = useState(normalizeAvatar(stored?.avatar));
  const [name, setName] = useState(stored?.name ?? "Player");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setReady(true), 150);
    return () => clearTimeout(timer);
  }, []);

  // A player who picked an avatar on Home but has no account yet still gets
  // that badge when they arrive through an invite link.
  useEffect(() => {
    let active = true;
    loadAvatarPref().then((preferred) => {
      if (active && preferred) setAvatar(preferred);
    });
    return () => {
      active = false;
    };
  }, []);

  const join = async () => {
    if (!code) {
      setError("This invite link is missing a room code.");
      return;
    }
    if (!name.trim()) {
      setError("Pick a nickname first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const identity = await ensureIdentity(name.trim(), avatar);
      if (identity.name !== name.trim() || identity.avatar !== avatar) {
        const updated = await request("profile:update", { name: name.trim(), avatar });
        if (!updated.ok) {
          setError(updated.error ?? "Could not save that nickname.");
          return;
        }
        if (updated.profile) rememberProfile(updated.profile);
      }
      const joined = await request("room:join", {
        code,
        invite: invite || undefined,
        name: name.trim(),
        avatar,
        token: identity.token,
      });
      if (!joined.ok || !joined.room || !joined.sessionToken) {
        setError(
          joined.code === "INVALID_INVITE"
            ? "This invite link is incomplete or has expired. Ask the host for a new one."
            : (joined.error ?? "Could not join this room."),
        );
        return;
      }
      setSession({ code: joined.room.code, token: joined.sessionToken, name: name.trim() });
      if (joined.spectator) {
        Alert.alert("Watching", "This game already started, so you joined as a spectator.");
      }
      router.replace("/game");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Check that the game server is running.");
    } finally {
      setBusy(false);
    }
  };

  if (!ready) {
    return (
      <SafeAreaView style={styles.center}>
        <ActivityIndicator color={colors.ink} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.page} edges={["top", "bottom"]}>
      <BrutalCard bodyStyle={styles.card}>
        <Text style={styles.kicker}>ROOM INVITE</Text>
        <Text style={styles.code}>{code || "—"}</Text>
        <View style={styles.noticeRow}>
          <AvatarTile value={avatar} size={44} />
          <Text style={styles.sub}>
            {invite
              ? "You were invited to a private room. Pick a name and jump in."
              : "Enter the room code from your host."}
          </Text>
        </View>
        <Text style={styles.fieldLabel}>NICKNAME</Text>
        <BrutalInput
          value={name}
          onChangeText={setName}
          maxLength={18}
          placeholder="Your nickname"
          accessibilityLabel="Your nickname"
          autoCorrect={false}
        />
        <BrutalButton
          label={busy ? "JOINING…" : "JOIN GAME"}
          onPress={() => void join()}
          disabled={busy}
          icon="arrowRight"
        />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <BrutalButton
          label="BACK TO HOME"
          color={colors.surface}
          compact
          onPress={() => router.replace("/")}
          accessibilityLabel="Back to home"
        />
      </BrutalCard>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg, justifyContent: "center", padding: 18 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg },
  card: { padding: 18, gap: 12 },
  kicker: { ...type.label, letterSpacing: 2 },
  code: { fontSize: 40, fontWeight: "900", letterSpacing: 8, color: colors.ink, fontFamily: monoFont },
  noticeRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  sub: { ...type.body, flex: 1, color: "#3A3A3A" },
  fieldLabel: { ...type.label },
  error: {
    color: colors.ink,
    backgroundColor: colors.pink,
    borderWidth: 2,
    borderColor: colors.ink,
    borderRadius: 8,
    padding: 9,
    fontSize: 11,
    fontWeight: "800",
    lineHeight: 16,
  },
});
