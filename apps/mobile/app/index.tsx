import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { router, useFocusEffect } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  connectSocket,
  getSocketUrl,
  setSocketToken,
  socket,
} from "../src/socket";
import { clearSession, getSession, hydrateSession, setSession, type Session } from "../src/session";
import { ensureIdentity, rememberProfile } from "../src/auth";
import { getIdentity } from "../src/profile";
import { request } from "../src/request";
import { normalizeAvatar } from "../src/game/avatars";
import { loadAvatarPref, saveAvatarPref } from "../src/avatarPrefs";
import type { AckResponse, PublicRoomSummary } from "../src/game/types";
import { Avatar } from "../src/components/Avatars";
import AvatarRack from "../src/components/AvatarRack";
import SkribleLogo from "../src/components/SkribleLogo";
import Icon from "../src/components/Icons";
import {
  BrutalButton,
  BrutalCard,
  BrutalIconButton,
  BrutalInput,
  BrutalPill,
  BrutalSheet,
} from "../src/components/Brutal";
import { BORDER_WIDTH, colors, monoFont, radii, type } from "../src/theme";

const APP_VERSION = "1.0.0";

export default function Home() {
  const stored = getIdentity();
  const [name, setName] = useState(stored?.name ?? "Player");
  const [avatar, setAvatar] = useState(normalizeAvatar(stored?.avatar));
  const [code, setCode] = useState("");
  const [invite, setInvite] = useState("");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [searching, setSearching] = useState(false);
  const [resumable, setResumable] = useState<Session | null>(getSession());
  const [queue, setQueue] = useState<{ position: number; size: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState(socket.connected);
  const [rooms, setRooms] = useState<PublicRoomSummary[]>([]);
  const [roomsError, setRoomsError] = useState<string | null>(null);
  const [roomsOpen, setRoomsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [devUnlocked, setDevUnlocked] = useState(false);
  const busyRef = useRef(false);
  const versionTaps = useRef(0);
  const sessionChecked = useRef(false);
  const { width: windowWidth } = useWindowDimensions();
  const contentWidth = Math.min(windowWidth, 560) - 36;
  const halfCard = Math.floor((contentWidth - 14) / 2);

  const showError = (message: string | undefined) => setError(message ?? "Something went wrong.");

  const refreshRooms = useCallback(async () => {
    if (!socket.connected) return;
    const response = await request("rooms:list");
    if (response.ok) {
      setRooms(response.rooms ?? []);
      setRoomsError(null);
    } else {
      setRoomsError(response.error ?? null);
    }
  }, []);

  // Launch goes straight to the build server address; the user never has to
  // configure anything. Server settings stay behind the hidden developer row.
  useFocusEffect(
    useCallback(() => {
      let active = true;
      connectSocket()
        .catch(async (failure: unknown) => {
          if (failure instanceof Error && failure.message === "AUTH_INVALID") {
            setSocketToken(null);
            return connectSocket();
          }
          throw failure;
        })
        .then(() => {
          if (active) setOnline(true);
          if (active) void refreshRooms();
        })
        .catch(() => {
          if (active) setOnline(false);
        });
      return () => {
        active = false;
      };
    }, [refreshRooms]),
  );

  useFocusEffect(
    useCallback(() => {
      let active = true;
      loadAvatarPref().then((preferred) => {
        if (!active || !preferred) return;
        setAvatar(preferred);
      });
      return () => {
        active = false;
      };
    }, []),
  );

  useEffect(() => {
    const onConnect = () => setOnline(true);
    const onDisconnect = () => setOnline(false);
    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
    };
  }, []);

  /** Restores the saved account or creates a persistent guest, then applies edits. */
  const prepareProfile = async (): Promise<{ name: string; token: string } | null> => {
    const trimmed = name.trim();
    if (!trimmed) {
      showError("Pick a nickname first.");
      return null;
    }
    try {
      await connectSocket();
    } catch {
      showError("Can't reach the game server. Tap retry in the banner.");
      return null;
    }
    const identity = await ensureIdentity(trimmed, avatar);

    // The account keeps its stored name/avatar, so apply edits explicitly.
    if (identity.name !== trimmed || identity.avatar !== avatar) {
      const updated = await request("profile:update", { name: trimmed, avatar });
      if (!updated.ok) {
        showError(updated.error);
        return null;
      }
      if (updated.profile) {
        rememberProfile(updated.profile);
        return { name: updated.profile.name, token: identity.token };
      }
    }
    return { name: identity.name, token: identity.token };
  };

  useEffect(() => {
    let active = true;
    hydrateSession()
      .then((session) => {
        if (active) setResumable(session);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  // A saved seat goes stale once its room is collected. Confirm it with the
  // server once per launch so the banner never offers a Resume that cannot work.
  // Only definitive rejections clear it; a network blip must not lose the seat.
  useEffect(() => {
    if (!resumable || sessionChecked.current || !socket.connected) return;
    sessionChecked.current = true;
    request("room:resync", { code: resumable.code, token: resumable.token }).then((response) => {
      if (response.ok) return;
      if (response.code === "NOT_IN_ROOM" || response.code === "INVALID_SESSION") {
        clearSession();
        setResumable(null);
      }
    });
  }, [resumable, online]);

  const resumeRoom = async () => {
    if (!resumable || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      try {
        await connectSocket();
      } catch (failure) {
        // A stale token must not block reclaiming a seat; resume is token-free.
        if (!(failure instanceof Error) || failure.message !== "AUTH_INVALID") throw failure;
        setSocketToken(null);
        await connectSocket();
      }
      router.replace("/game");
    } catch {
      showError("Can't reach the game server. Try again.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const enterRoom = async (response: AckResponse) => {
    if (!response.ok || !response.room || !response.sessionToken) {
      if (response.code === "INVALID_INVITE") {
        showError("This room requires its invite link. Ask the host to share it.");
      } else {
        showError(response.error);
      }
      return;
    }
    setSession({
      code: response.room.code,
      token: response.sessionToken,
      name: response.profile?.name ?? name.trim(),
    });
    if (response.profile) rememberProfile(response.profile);
    if (response.spectator) {
      Alert.alert("Watching", "This game is already running, so you joined as a spectator.");
    }
    router.replace("/game");
  };

  useEffect(() => {
    const onQueued = (payload: { position: number; size: number }) => {
      setQueue(payload);
      setSearching(true);
    };
    const onMatched = (payload: any) => {
      setSearching(false);
      setQueue(null);
      const me = payload.room?.players?.find((player: any) => player.id === socket.id);
      const sessionToken = payload.sessionToken as string | undefined;
      if (!payload.roomCode || !sessionToken) {
        showError("Matchmaking returned an incomplete match.");
        return;
      }
      setSession({
        code: payload.roomCode,
        token: sessionToken,
        name: me?.name ?? name.trim(),
      });
      if (payload.profile) rememberProfile(payload.profile);
      router.replace("/game");
    };
    const onTimeout = (payload: { error?: string }) => {
      setSearching(false);
      setQueue(null);
      showError(payload.error);
    };
    const onMatchError = (payload: { error?: string }) => {
      setSearching(false);
      setQueue(null);
      showError(payload.error);
    };
    const onDisconnect = () => {
      if (!searching) return;
      setSearching(false);
      setQueue(null);
      showError("Connection lost while searching. Try again.");
    };
    socket.on("mm:queued", onQueued);
    socket.on("mm:matched", onMatched);
    socket.on("mm:timeout", onTimeout);
    socket.on("mm:error", onMatchError);
    socket.on("disconnect", onDisconnect);
    return () => {
      socket.off("mm:queued", onQueued);
      socket.off("mm:matched", onMatched);
      socket.off("mm:timeout", onTimeout);
      socket.off("mm:error", onMatchError);
      socket.off("disconnect", onDisconnect);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searching, name]);

  const quickPlay = async () => {
    if (busyRef.current || searching) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const profile = await prepareProfile();
      if (!profile) return;
      const response = await request("mm:enqueue", {
        name: profile.name,
        avatar,
        token: profile.token,
      });
      if (!response.ok) {
        showError(response.error);
        return;
      }
      setSearching(true);
      if (response.position != null && response.size != null) {
        setQueue({ position: response.position, size: response.size });
      }
    } catch (failure) {
      showError(failure instanceof Error ? failure.message : "Check that the game server is running.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const cancelSearch = async () => {
    const response = await request("mm:cancel");
    setSearching(false);
    setQueue(null);
    if (!response.ok) showError(response.error);
  };

  const create = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const profile = await prepareProfile();
      if (!profile) return;
      await enterRoom(await request("room:create", { name: profile.name, avatar, token: profile.token }));
    } catch (failure) {
      showError(failure instanceof Error ? failure.message : "Check that the game server is running.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const join = async (overrideCode?: string) => {
    if (busyRef.current) return;
    const trimmedCode = (overrideCode ?? code).trim().toUpperCase();
    if (trimmedCode.length !== 5) {
      showError("Room codes are 5 characters.");
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const profile = await prepareProfile();
      if (!profile) return;
      await enterRoom(
        await request("room:join", {
          code: trimmedCode,
          name: profile.name,
          avatar,
          token: profile.token,
          ...(invite.trim() ? { invite: invite.trim() } : {}),
        }),
      );
    } catch (failure) {
      showError(failure instanceof Error ? failure.message : "Check that the game server is running.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const changeAvatar = (next: string) => {
    setAvatar(next);
    void saveAvatarPref(next);
  };

  const tapVersion = () => {
    versionTaps.current += 1;
    if (versionTaps.current >= 5 && !devUnlocked) {
      setDevUnlocked(true);
    }
  };

  const disabled = busy || searching;
  const searchingLabel = queue ? `SEARCHING · ${queue.size} IN QUEUE` : "SEARCHING FOR PLAYERS";

  return (
    <SafeAreaView style={s.page} edges={["top", "bottom"]}>
      <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">
        <View style={s.topBar}>
          <BrutalIconButton
            icon="settings"
            accessibilityLabel="Settings"
            onPress={() => setSettingsOpen(true)}
          />
          <View style={s.topActions}>
            <View
              accessibilityRole="image"
              accessibilityLabel="Your avatar"
              style={s.avatarButton}
            >
              <Avatar value={avatar} size={34} />
            </View>
            <BrutalIconButton
              icon="info"
              accessibilityLabel="How to play"
              color={colors.cyan}
              onPress={() => setGuideOpen(true)}
            />
          </View>
        </View>

        <View style={s.logoRow}>
          <SkribleLogo width={Math.min(contentWidth, 400)} />
        </View>

        <BrutalCard bodyStyle={s.creatorBody}>
          <AvatarRack value={avatar} onChange={changeAvatar} />
          <View style={s.nameBlock}>
            <Text style={s.fieldLabel}>NICKNAME</Text>
            <BrutalInput
              value={name}
              onChangeText={setName}
              maxLength={18}
              placeholder="Your nickname"
              accessibilityLabel="Your nickname"
              autoCorrect={false}
              onEndEditing={() => setName(name.trim() || "Player")}
            />
          </View>
        </BrutalCard>

        {!online ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Retry server connection"
            onPress={() => {
              setError(null);
              connectSocket()
                .then(() => {
                  setOnline(true);
                  void refreshRooms();
                })
                .catch(() => setOnline(false));
            }}
          >
            <BrutalCard color={colors.amber} bodyStyle={s.bannerBody}>
              <Icon name="refresh" size={18} />
              <View style={s.bannerCopy}>
                <Text style={s.bannerTitle}>GAME SERVER OFFLINE</Text>
                <Text style={s.bannerText}>Tap to retry. Check your connection.</Text>
              </View>
            </BrutalCard>
          </Pressable>
        ) : null}

        {resumable ? (
          <BrutalCard color={colors.lime} bodyStyle={s.resumeBody}>
            <View style={s.resumeIcon}>
              <Icon name="play" size={18} />
            </View>
            <View style={s.resumeCopy}>
              <Text style={s.resumeTitle}>ROOM {resumable.code}</Text>
              <Text style={s.resumeMeta}>Your seat is still warm.</Text>
            </View>
            <BrutalButton
              label="Resume"
              compact
              color={colors.surface}
              onPress={resumeRoom}
              disabled={busy}
              style={s.resumeButton}
            />
          </BrutalCard>
        ) : null}

        {error ? (
          <Pressable onPress={() => setError(null)} accessibilityRole="button" accessibilityLabel="Dismiss error">
            <BrutalCard color={colors.pink} bodyStyle={s.bannerBody}>
              <Icon name="close" size={18} />
              <Text style={[s.bannerText, s.errorText]}>{error}</Text>
            </BrutalCard>
          </Pressable>
        ) : null}

        <View style={s.codeRow}>
          <BrutalInput
            style={s.codeInput}
            value={code}
            onChangeText={(value) => setCode(value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
            maxLength={5}
            autoCapitalize="characters"
            autoCorrect={false}
            placeholder="ROOM CODE"
            accessibilityLabel="Room code"
            editable={!searching}
            returnKeyType="go"
            onSubmitEditing={() => void join()}
          />
          <BrutalButton
            label="GO"
            accessibilityLabel="Join room"
            onPress={() => void join()}
            disabled={disabled || code.length !== 5}
            style={s.goButton}
          />
        </View>

        <Pressable
          onPress={() => setInviteOpen((open) => !open)}
          accessibilityRole="button"
          accessibilityLabel="Toggle invite token field"
          hitSlop={6}
        >
          <Text style={s.inviteToggle}>
            {inviteOpen ? "HIDE INVITE TOKEN" : "GOT AN INVITE TOKEN?"}
          </Text>
        </Pressable>
        {inviteOpen ? (
          <BrutalInput
            value={invite}
            onChangeText={setInvite}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="Paste invite token"
            accessibilityLabel="Invite token"
            editable={!searching}
          />
        ) : null}

        {searching ? (
          <BrutalCard color={colors.amber} bodyStyle={s.queueBody}>
            <ActivityIndicator color={colors.ink} />
            <View style={s.queueCopy}>
              <Text style={s.queueTitle}>{searchingLabel}</Text>
              <Text style={s.queueText}>The match starts as soon as the room fills up.</Text>
            </View>
            <BrutalButton label="CANCEL" compact color={colors.surface} onPress={cancelSearch} />
          </BrutalCard>
        ) : null}

        <View style={s.sectionHeading}>
          <View style={s.sectionLine} />
          <Text style={s.sectionLabel}>PICK A MODE</Text>
          <View style={s.sectionLine} />
        </View>

        <View style={s.grid}>
          <FolderCard
            width={halfCard}
            tab={colors.pink}
            icon="users"
            title="Create Room"
            meta="You host · 2–8 players"
            disabled={disabled}
            onPress={create}
          />
          <FolderCard
            width={halfCard}
            tab={colors.green}
            icon="bolt"
            title="Quick Play"
            meta="Find a room fast"
            disabled={disabled}
            onPress={quickPlay}
          />
          <FolderCard
            width={contentWidth}
            wide
            tab={colors.lavender}
            icon="globe"
            title="Public Rooms"
            meta={
              rooms.length
                ? `${rooms.length} open room${rooms.length === 1 ? "" : "s"} · tap to browse`
                : "No open rooms right now"
            }
            disabled={disabled}
            onPress={() => {
              setRoomsOpen((open) => !open);
              void refreshRooms();
            }}
          />
        </View>

        {roomsOpen ? (
          <BrutalCard bodyStyle={s.roomsBody}>
            <View style={s.roomsHeader}>
              <Text style={s.roomsTitle}>PUBLIC ROOMS</Text>
              <Pressable
                onPress={() => void refreshRooms()}
                accessibilityRole="button"
                accessibilityLabel="Refresh public rooms"
                style={({ pressed }) => [s.refreshButton, pressed && s.pressed]}
              >
                <Icon name="refresh" size={14} />
                <Text style={s.refreshText}>REFRESH</Text>
              </Pressable>
            </View>
            {rooms.length === 0 ? (
              <Text style={s.roomsEmpty}>
                Nobody is public right now. Create a room and flip it to public.
              </Text>
            ) : (
              rooms.map((summary) => {
                const full = summary.players >= summary.maxPlayers;
                return (
                  <Pressable
                    key={summary.code}
                    disabled={full || disabled}
                    onPress={() => void join(summary.code)}
                    accessibilityRole="button"
                    accessibilityLabel={`Join public room ${summary.code}`}
                    style={({ pressed }) => [
                      s.roomRow,
                      (full || disabled) && s.disabled,
                      pressed && s.pressed,
                    ]}
                  >
                    <Text style={s.roomCode}>{summary.code}</Text>
                    <View style={s.roomCopy}>
                      <Text style={s.roomHost} numberOfLines={1}>
                        {summary.hostName}'s room
                      </Text>
                      <Text style={s.roomMeta}>
                        {summary.players}/{summary.maxPlayers} players · {summary.round}/
                        {summary.maxRounds} rounds · {summary.drawSeconds}s
                      </Text>
                    </View>
                    <BrutalPill label={full ? "FULL" : "JOIN"} color={full ? colors.gray : colors.yellow} />
                  </Pressable>
                );
              })
            )}
            {roomsError ? <Text style={s.errorText}>{roomsError}</Text> : null}
          </BrutalCard>
        ) : null}

      </ScrollView>

      <BrutalSheet
        visible={guideOpen}
        onClose={() => setGuideOpen(false)}
        title="How to play"
        footer={<BrutalButton label="GOT IT" onPress={() => setGuideOpen(false)} color={colors.green} />}
      >
        {[
          { icon: "plus" as const, title: "Make or join a room", text: "Create a room, quick play, or punch in a 5-letter code." },
          { icon: "brush" as const, title: "One player draws", text: "Everyone else types guesses. Faster guesses score more." },
          { icon: "trophy" as const, title: "Most points wins", text: "Rounds alternate drawers until the scoreboard settles it." },
        ].map((step, index) => (
          <View key={step.title} style={s.stepRow}>
            <View style={s.stepNumber}>
              <Text style={s.stepNumberText}>{index + 1}</Text>
            </View>
            <View style={s.stepCopy}>
              <Text style={s.stepTitle}>{step.title}</Text>
              <Text style={s.stepText}>{step.text}</Text>
            </View>
            <Icon name={step.icon} size={22} />
          </View>
        ))}
      </BrutalSheet>

      <BrutalSheet visible={settingsOpen} onClose={() => setSettingsOpen(false)} title="Settings">
        <Pressable
          onPress={() => {
            setSettingsOpen(false);
            router.push("/profile");
          }}
          accessibilityRole="button"
          accessibilityLabel="Open profile"
          style={({ pressed }) => [s.settingRow, pressed && s.pressed]}
        >
          <Icon name="users" size={20} />
          <View style={s.settingCopy}>
            <Text style={s.settingTitle}>Profile & leaderboard</Text>
            <Text style={s.settingMeta}>Stats, match history, global ranks</Text>
          </View>
          <Icon name="arrowRight" size={18} />
        </Pressable>
        <Pressable
          onPress={() => {
            setSettingsOpen(false);
            setGuideOpen(true);
          }}
          accessibilityRole="button"
          accessibilityLabel="Open how to play"
          style={({ pressed }) => [s.settingRow, pressed && s.pressed]}
        >
          <Icon name="info" size={20} />
          <View style={s.settingCopy}>
            <Text style={s.settingTitle}>How to play</Text>
            <Text style={s.settingMeta}>Three steps to chaos</Text>
          </View>
          <Icon name="arrowRight" size={18} />
        </Pressable>

        {devUnlocked ? (
          <Pressable
            onPress={() => {
              setSettingsOpen(false);
              router.push("/server");
            }}
            accessibilityRole="button"
            accessibilityLabel="Developer server connection"
            style={({ pressed }) => [s.settingRow, s.devRow, pressed && s.pressed]}
          >
            <Icon name="lock" size={20} />
            <View style={s.settingCopy}>
              <Text style={s.settingTitle}>Server connection</Text>
              <Text style={s.settingMeta}>{getSocketUrl()}</Text>
            </View>
            <Icon name="arrowRight" size={18} />
          </Pressable>
        ) : null}

        <Pressable onPress={tapVersion} accessibilityRole="button" accessibilityLabel="App version">
          <Text style={s.version}>SKRIBLE {APP_VERSION} · MADE FOR DRAWING FAST</Text>
        </Pressable>
      </BrutalSheet>
    </SafeAreaView>
  );
}

function FolderCard({
  width,
  tab,
  icon,
  title,
  meta,
  disabled,
  onPress,
  wide = false,
}: {
  width: number;
  tab: string;
  icon: "users" | "bolt" | "globe";
  title: string;
  meta: string;
  disabled: boolean;
  onPress: () => void;
  wide?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [{ width }, disabled && s.disabled, pressed && s.pressed]}
    >
      <BrutalCard bodyStyle={s.folderBody} cardRadius={radii.md}>
        <View style={[s.folderTab, { backgroundColor: tab }]} />
        <View style={[s.folderContent, wide && s.folderContentWide]}>
          <View style={[s.folderBadge, { backgroundColor: tab }]}>
            <Icon name={icon} size={wide ? 24 : 22} />
          </View>
          <View style={s.folderCopy}>
            <Text style={s.folderTitle}>{title}</Text>
            <Text style={s.folderMeta}>{meta}</Text>
          </View>
          {wide ? <Icon name="arrowRight" size={22} /> : null}
        </View>
      </BrutalCard>
    </Pressable>
  );
}

const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  scroll: {
    padding: 18,
    paddingBottom: 36,
    gap: 14,
    width: "100%",
    maxWidth: 560,
    alignSelf: "center",
  },
  topBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  logoRow: { alignItems: "center", paddingTop: 2, paddingBottom: 2 },
  topActions: { flexDirection: "row", alignItems: "center", gap: 8 },
  avatarButton: {
    width: 50,
    height: 50,
    borderWidth: BORDER_WIDTH,
    borderColor: colors.ink,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  pressed: { transform: [{ translateX: 2 }, { translateY: 2 }], opacity: 0.92 },
  disabled: { opacity: 0.45 },
  creatorBody: { padding: 12, gap: 10 },
  nameBlock: { gap: 6 },
  bannerBody: { flexDirection: "row", alignItems: "center", gap: 10, padding: 12 },
  bannerCopy: { flex: 1, gap: 2 },
  bannerTitle: { ...type.label },
  bannerText: { fontSize: 11, lineHeight: 16, fontWeight: "700", color: colors.ink },
  errorText: { color: colors.ink, fontWeight: "800", fontSize: 12, lineHeight: 17 },
  resumeBody: { flexDirection: "row", alignItems: "center", gap: 10, padding: 12 },
  resumeIcon: {
    width: 34,
    height: 34,
    borderWidth: 2,
    borderColor: colors.ink,
    borderRadius: 9,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  resumeCopy: { flex: 1 },
  resumeTitle: { ...type.label, fontSize: 11, letterSpacing: 1.2 },
  resumeMeta: { fontSize: 11, fontWeight: "700", color: "#2E2E2E", marginTop: 2 },
  resumeButton: { alignSelf: "center" },
  codeRow: { flexDirection: "row", alignItems: "stretch", gap: 10 },
  codeInput: {
    flex: 1,
    minHeight: 52,
    fontSize: 20,
    fontWeight: "900",
    letterSpacing: 4,
    fontFamily: monoFont,
  },
  goButton: { width: 68, justifyContent: "center" },
  inviteToggle: { ...type.tiny, letterSpacing: 1.2, textDecorationLine: "underline", textAlign: "center" },
  queueBody: { flexDirection: "row", alignItems: "center", gap: 10, padding: 12 },
  queueCopy: { flex: 1 },
  queueTitle: { ...type.label, fontSize: 11, letterSpacing: 1 },
  queueText: { fontSize: 10.5, fontWeight: "700", color: "#333", marginTop: 2 },
  sectionHeading: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 6 },
  sectionLine: { flex: 1, height: BORDER_WIDTH, backgroundColor: colors.ink },
  sectionLabel: { ...type.label, letterSpacing: 2 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 14 },
  folderBody: { padding: 0 },
  folderTab: { height: 10, borderBottomWidth: BORDER_WIDTH, borderBottomColor: colors.ink },
  folderContent: { padding: 11, gap: 9 },
  folderContentWide: { flexDirection: "row", alignItems: "center", gap: 12 },
  folderBadge: {
    width: 42,
    height: 42,
    borderWidth: BORDER_WIDTH,
    borderColor: colors.ink,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  folderCopy: { flex: 1, gap: 2 },
  folderTitle: { fontSize: 15, lineHeight: 18, fontWeight: "900", color: colors.ink, letterSpacing: -0.3 },
  folderMeta: { fontSize: 10, lineHeight: 13, fontWeight: "700", color: "#3C3C3C" },
  roomsBody: { padding: 0 },
  roomsHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderBottomWidth: BORDER_WIDTH,
    borderBottomColor: colors.ink,
    backgroundColor: colors.lavender,
  },
  roomsTitle: { ...type.label, fontSize: 11, letterSpacing: 1.4 },
  refreshButton: { flexDirection: "row", alignItems: "center", gap: 4 },
  refreshText: { fontSize: 9, fontWeight: "900", letterSpacing: 1 },
  roomsEmpty: { ...type.body, padding: 14, color: "#555" },
  roomRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 2,
    borderBottomColor: colors.ink,
  },
  roomCode: { fontSize: 15, fontWeight: "900", letterSpacing: 2, color: colors.ink, fontFamily: monoFont },
  roomCopy: { flex: 1 },
  roomHost: { fontSize: 12, fontWeight: "900", color: colors.ink },
  roomMeta: { fontSize: 10, fontWeight: "600", color: "#4A4A4A", marginTop: 1 },
  fieldLabel: { ...type.label },
  stepRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderWidth: BORDER_WIDTH,
    borderColor: colors.ink,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
    padding: 10,
  },
  stepNumber: {
    width: 30,
    height: 30,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: colors.ink,
    backgroundColor: colors.yellow,
    alignItems: "center",
    justifyContent: "center",
  },
  stepNumberText: { fontSize: 14, fontWeight: "900", color: colors.ink },
  stepCopy: { flex: 1 },
  stepTitle: { fontSize: 13, fontWeight: "900", color: colors.ink },
  stepText: { fontSize: 11, lineHeight: 15, fontWeight: "600", color: "#3A3A3A", marginTop: 1 },
  settingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderWidth: BORDER_WIDTH,
    borderColor: colors.ink,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
    padding: 12,
  },
  devRow: { backgroundColor: colors.amber },
  settingCopy: { flex: 1 },
  settingTitle: { fontSize: 13, fontWeight: "900", color: colors.ink },
  settingMeta: { fontSize: 10, fontWeight: "600", color: "#444", marginTop: 2 },
  version: { ...type.tiny, textAlign: "center", letterSpacing: 0.8, paddingVertical: 6 },
});
