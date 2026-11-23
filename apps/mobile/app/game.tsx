import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { useNetworkState } from "expo-network";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { setSocketToken, socket } from "../src/socket";
import { clearSession, getSession } from "../src/session";
import type {
  AckResponse,
  ChatMessage,
  MatchRecord,
  PlayerReport,
  Point,
  RoomUpdate,
  Stroke,
  Tool,
  WordCategory,
} from "../src/game/types";
import { mergeChat } from "../src/game/chat";
import { request } from "../src/request";
import {
  appendPoints,
  applyClear,
  applyRedo,
  applyUndo,
  beginStroke,
  boardFromRoom,
  completeStroke,
  emptyBoard,
  shouldAdoptRoomBoard,
  type Board,
} from "../src/drawing/board";
import DrawingCanvas from "../src/components/DrawingCanvas";
import DrawingToolbar from "../src/components/DrawingToolbar";
import PlayerStrip from "../src/components/PlayerStrip";
import ChatPanel from "../src/components/ChatPanel";
import RoomSettings, { type SettingsPatch } from "../src/components/RoomSettings";
import WordListEditor from "../src/components/WordListEditor";
import PlayerPanel from "../src/components/PlayerPanel";
import ErrorBoundary from "../src/components/ErrorBoundary";
import AvatarTile from "../src/components/Avatars";
import Icon from "../src/components/Icons";
import { BrutalButton, BrutalCard, BrutalPill } from "../src/components/Brutal";
import { BORDER_WIDTH, colors, monoFont, radii, type } from "../src/theme";

export default function GameScreen() {
  // A render error must not take down the whole app mid-round; the seat can
  // still be reclaimed from here.
  return (
    <ErrorBoundary
      title="The game screen hit a problem"
      onRejoin={() => router.replace("/game")}
    >
      <GameScreenContent />
    </ErrorBoundary>
  );
}

function GameScreenContent() {
  const [room, setRoom] = useState<RoomUpdate | null>(null);
  const [board, setBoard] = useState<Board>(emptyBoard);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [options, setOptions] = useState<string[]>([]);
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState("#000000");
  const [size, setSize] = useState(10);
  const [online, setOnline] = useState(socket.connected);
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState<string | null>(null);
  const [clock, setClock] = useState(Date.now());
  const [match, setMatch] = useState<MatchRecord | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [wordsOpen, setWordsOpen] = useState(false);
  const [wordCategories, setWordCategories] = useState<WordCategory[]>([]);
  const [mutedIds, setMutedIds] = useState<string[]>([]);
  const [reports, setReports] = useState<PlayerReport[]>([]);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [canvasBox, setCanvasBox] = useState({ width: 0, height: 0 });
  const [attempt, setAttempt] = useState(0);
  /** Monotonic per-stroke chunk number so retransmits are ignored server-side. */
  const chunkSeqRef = useRef(0);
  const pendingSendRef = useRef<{ id: string; points: Point[] } | null>(null);
  const sendTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leftRef = useRef(false);
  /** Server clock minus device clock, so the countdown ignores device skew. */
  const clockOffsetRef = useRef(0);
  const network = useNetworkState();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const landscape = windowWidth > windowHeight;

  const applyRoom = useCallback((next: RoomUpdate, forceBoard = false) => {
    if (typeof next.serverNow === "number") {
      clockOffsetRef.current = next.serverNow - Date.now();
    }
    // A snapshot can arrive while the seat is still being restored with some
    // collections omitted. Normalise once here so every screen below (lobby,
    // settings, chat, player panel) can index them without crashing.
    const safe: RoomUpdate = {
      ...next,
      players: next.players ?? [],
      spectators: next.spectators ?? [],
      strokes: next.strokes ?? [],
      chat: next.chat ?? [],
      guessedIds: next.guessedIds ?? [],
      customCategories: next.customCategories ?? [],
      customWordCount: next.customWordCount ?? 0,
    };
    setRoom(safe);
    setBoard((previous) =>
      forceBoard || shouldAdoptRoomBoard(previous, safe) ? boardFromRoom(safe) : previous,
    );
    if (safe.chat.length) {
      setMessages((previous) => mergeChat(previous, safe.chat));
    }
    if (safe.status === "choosing" && safe.isDrawer && safe.wordChoices?.length) {
      setOptions(safe.wordChoices);
    } else if (safe.status !== "choosing") {
      setOptions([]);
    }
  }, []);

  const sync = useCallback(() => {
    socket.emit("room:sync", {}, (response: AckResponse) => {
      if (response?.ok && response.room) applyRoom(response.room, true);
    });
  }, [applyRoom]);

  /**
   * Authoritative recovery path: works after a transport drop, a killed app or
   * a server restart, because it rebinds the seat by token instead of relying
   * on the old socket id.
   */
  const resync = useCallback(() => {
    const session = getSession();
    if (!session) {
      router.replace("/");
      return;
    }
    request("room:resync", { code: session.code, token: session.token }).then((response) => {
      setLoading(false);
      if (response.ok && response.room) {
        applyRoom(response.room, true);
        setBanner(null);
        return;
      }
      if (
        response.code === "INVALID_SESSION" ||
        response.code === "ROOM_NOT_FOUND" ||
        response.code === "NOT_IN_ROOM" ||
        response.code === "BANNED"
      ) {
        clearSession();
        setBanner(response.error ?? "This room is no longer available.");
        router.replace("/");
        return;
      }
      setBanner(response.error ?? "Could not rejoin yet. Retrying…");
    });
  }, [applyRoom]);

  const report = useCallback(
    (message: string | undefined) => {
      setBanner(message ?? "Drawing sync failed. Resyncing…");
      sync();
    },
    [sync],
  );

  const flushPendingSend = useCallback(() => {
    if (sendTimerRef.current) {
      clearTimeout(sendTimerRef.current);
      sendTimerRef.current = null;
    }
    const pending = pendingSendRef.current;
    pendingSendRef.current = null;
    if (!pending || pending.points.length === 0) return;
    // Never buffer stroke traffic across a reconnect; the resume snapshot wins.
    if (!socket.connected) return;
    for (let index = 0; index < pending.points.length; index += 64) {
      const points = pending.points.slice(index, index + 64);
      chunkSeqRef.current += 1;
      socket.emit(
        "draw:stroke:points",
        { id: pending.id, points, seq: chunkSeqRef.current },
        (response: AckResponse) => {
          if (response && !response.ok) report(response.error);
        },
      );
    }
  }, [report]);

  useEffect(() => {
    const session = getSession();
    if (!session) {
      router.replace("/");
      return;
    }

    let cancelled = false;
    let resuming = false;

    const requestResume = () => {
      if (resuming) return;
      resuming = true;
      socket.emit(
        "room:resync",
        { code: session.code, token: session.token },
        (response: AckResponse) => {
          resuming = false;
          if (cancelled) return;
          setLoading(false);
          if (!response?.ok || !response.room) {
            setBanner(response?.error ?? "This room is no longer available.");
            clearSession();
            router.replace("/");
            return;
          }
          applyRoom(response.room, true);
        },
      );
    };

    const onConnect = () => {
      setOnline(true);
      setBanner(null);
      setAttempt(0);
      requestResume();
    };
    const onDisconnect = () => {
      setOnline(false);
      setBanner("Connection lost. Reconnecting…");
    };
    const onReconnectAttempt = (count: number) => {
      setOnline(false);
      setAttempt(count);
      setBanner("Reconnecting…");
    };
    const onSessionReplaced = (payload: { error?: string }) => {
      leftRef.current = true;
      clearSession();
      Alert.alert(
        "Seat resumed elsewhere",
        payload?.error ?? "This room was opened from another connection.",
      );
      router.replace("/");
    };
    const onConnectError = (error: Error) => {
      setLoading(false);
      // Seat resume does not require an account token; drop a stale handshake
      // token and reconnect anonymously so the room can still be reclaimed.
      if (error?.message === "AUTH_INVALID") {
        setSocketToken(null);
        socket.connect();
        return;
      }
      setOnline(false);
      setBanner("Can't reach the game server. Retrying…");
    };
    const onRoomUpdate = (next: RoomUpdate) => applyRoom(next);
    const onStrokeBegin = (event: Omit<Stroke, "points" | "complete">) =>
      setBoard((previous) => beginStroke(previous, event));
    const onStrokePoints = (event: { id: string; points: Point[] }) =>
      setBoard((previous) => appendPoints(previous, event.id, event.points));
    const onStrokeEnd = (event: { id: string }) =>
      setBoard((previous) => completeStroke(previous, event.id));
    const onUndo = (event: { strokeId: string; undoDepth: number; redoDepth: number }) =>
      setBoard((previous) => applyUndo(previous, event));
    const onRedo = (event: { stroke: Stroke; undoDepth: number; redoDepth: number }) =>
      setBoard((previous) => applyRedo(previous, event));
    const onClear = (event: { undoDepth: number; redoDepth: number }) =>
      setBoard((previous) => applyClear(previous, event));
    const onOptions = (words: string[]) => setOptions(words);
    const onChat = (message: ChatMessage) =>
      setMessages((previous) => mergeChat(previous, [message]));
    const onMatchEnded = (record: MatchRecord) => setMatch(record);
    const onKicked = (payload: { error?: string }) => {
      clearSession();
      setBanner(null);
      Alert.alert("Removed from room", payload?.error ?? "The host removed you from the room.");
      router.replace("/");
    };
    const onMuted = (payload: { muted: boolean }) => {
      setBanner(payload.muted ? "You are muted by the host." : null);
    };

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("connect_error", onConnectError);
    socket.on("reconnect_attempt", onReconnectAttempt);
    socket.on("session:replaced", onSessionReplaced);
    socket.on("room:update", onRoomUpdate);
    socket.on("draw:stroke:begin", onStrokeBegin);
    socket.on("draw:stroke:points", onStrokePoints);
    socket.on("draw:stroke:end", onStrokeEnd);
    socket.on("draw:undo", onUndo);
    socket.on("draw:redo", onRedo);
    socket.on("draw:clear", onClear);
    socket.on("word:options", onOptions);
    socket.on("chat:message", onChat);
    socket.on("match:ended", onMatchEnded);
    socket.on("room:kicked", onKicked);
    socket.on("moderation:muted", onMuted);

    setOnline(socket.connected);
    if (socket.connected) requestResume();
    else socket.connect();

    return () => {
      cancelled = true;
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("connect_error", onConnectError);
      socket.off("reconnect_attempt", onReconnectAttempt);
      socket.off("session:replaced", onSessionReplaced);
      socket.off("room:update", onRoomUpdate);
      socket.off("draw:stroke:begin", onStrokeBegin);
      socket.off("draw:stroke:points", onStrokePoints);
      socket.off("draw:stroke:end", onStrokeEnd);
      socket.off("draw:undo", onUndo);
      socket.off("draw:redo", onRedo);
      socket.off("draw:clear", onClear);
      socket.off("word:options", onOptions);
      socket.off("chat:message", onChat);
      socket.off("match:ended", onMatchEnded);
      socket.off("room:kicked", onKicked);
      socket.off("moderation:muted", onMuted);
      if (sendTimerRef.current) clearTimeout(sendTimerRef.current);
    };
  }, [applyRoom]);

  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);

  // The keyboard squeezes the game area on Android; drop the player strip so
  // the guess input and the canvas both stay visible.
  useEffect(() => {
    const shown = Keyboard.addListener("keyboardDidShow", () => setKeyboardOpen(true));
    const hidden = Keyboard.addListener("keyboardDidHide", () => setKeyboardOpen(false));
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);

  // Returning from the background is the common mobile failure mode: the OS
  // froze the socket. Reconnect or resync instead of leaving a stale board.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        // Coming back from background is the common mobile failure mode: the OS
        // may have frozen the socket without telling us. Verify with a full
        // resync rather than trusting a stale "connected" flag.
        if (socket.connected) resync();
        else socket.connect();
      } else {
        flushPendingSend();
      }
    });
    return () => subscription.remove();
  }, [flushPendingSend, resync]);

  useEffect(() => {
    if (network.isConnected === false) {
      setOnline(false);
      setBanner("You're offline. Drawing stays local until the connection returns.");
    } else if (network.isConnected) {
      if (socket.connected) resync();
      else socket.connect();
    }
  }, [network.isConnected, resync]);

  // Restored sessions can land on an already-finished game; fetch the record.
  useEffect(() => {
    if (!room || room.status !== "ended" || !room.matchId || match?.id === room.matchId) return;
    request("match:get", { matchId: room.matchId }).then((response) => {
      if (response.ok && response.match) setMatch(response.match);
    });
  }, [room, match?.id]);

  const handleBegin = useCallback(
    (id: string, point: Point) => {
      chunkSeqRef.current = 0;
      const strokeColor = tool === "eraser" ? "#FFFFFF" : color;
      const strokeWidth =
        tool === "eraser" ? Math.min(40, Math.round(size * 2.2)) : Math.max(1, Math.round(size));
      setBoard((previous) =>
        beginStroke(previous, {
          id,
          seq: previous.strokes.length,
          color: strokeColor,
          width: strokeWidth,
          tool,
          point,
        }),
      );
      // While offline, keep drawing locally only; the board is re-adopted from
      // the server when the resume succeeds.
      if (!socket.connected) return;
      socket.emit(
        "draw:stroke:begin",
        { id, color: strokeColor, width: strokeWidth, tool },
        (response: AckResponse) => {
          if (response && !response.ok) report(response.error);
        },
      );
    },
    [color, report, size, tool],
  );

  const handlePoints = useCallback(
    (id: string, points: Point[]) => {
      setBoard((previous) => appendPoints(previous, id, points));
      if (!socket.connected) return;
      if (!pendingSendRef.current || pendingSendRef.current.id !== id) {
        pendingSendRef.current = { id, points: [] };
      }
      pendingSendRef.current.points.push(...points);
      if (pendingSendRef.current.points.length >= 512) {
        // Never let a 120Hz stroke stream grow an unbounded send buffer.
        flushPendingSend();
        return;
      }
      if (!sendTimerRef.current) {
        sendTimerRef.current = setTimeout(flushPendingSend, 24);
      }
    },
    [flushPendingSend],
  );

  const handleEnd = useCallback(
    (id: string) => {
      setBoard((previous) => completeStroke(previous, id));
      flushPendingSend();
      if (!socket.connected) return;
      socket.emit("draw:stroke:end", { id }, (response: AckResponse) => {
        if (response && !response.ok) report(response.error);
      });
    },
    [flushPendingSend, report],
  );

  const requestUndo = () => {
    socket.emit("draw:undo", {}, (response: AckResponse) => {
      if (response && !response.ok) setBanner(response.error ?? "Nothing to undo");
    });
  };

  const requestRedo = () => {
    socket.emit("draw:redo", {}, (response: AckResponse) => {
      if (response && !response.ok) setBanner(response.error ?? "Nothing to redo");
    });
  };

  const confirmClear = () => {
    Alert.alert(
      "Clear the canvas?",
      "Every player's view will be cleared immediately. This cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Clear",
          style: "destructive",
          onPress: () =>
            socket.emit("draw:clear", {}, (response: AckResponse) => {
              if (response && !response.ok) setBanner(response.error ?? "Couldn't clear the canvas");
            }),
        },
      ],
    );
  };

  const sendChat = (text: string) => {
    if (!socket.connected) {
      setBanner("You're offline. Reconnecting…");
      return;
    }
    socket.emit("chat:guess", { text }, (response: AckResponse) => {
      if (!response) return;
      if (!response.ok) {
        setBanner(
          response.code === "RATE_LIMITED" ? "Slow down a little…" : (response.error ?? "Message not sent"),
        );
      }
    });
  };

  const configure = (patch: SettingsPatch) => {
    socket.emit("room:configure", patch, (response: AckResponse) => {
      if (response && !response.ok) setBanner(response.error ?? "Couldn't update settings");
    });
  };

  const shareInvite = async () => {
    const response = await request("room:invite");
    if (!response.ok || !response.deepLink) {
      setBanner(response.error ?? "Couldn't create an invite link");
      return;
    }
    await Share.share({
      message: `Join my Skrible room ${room?.code ?? ""}: ${response.deepLink}`,
      url: response.deepLink,
    });
  };

  const openWordEditor = async () => {
    const response = await request("words:get");
    if (!response.ok) {
      setBanner(response.error ?? "Couldn't load the word lists");
      return;
    }
    setWordCategories(response.categories ?? []);
    setWordsOpen(true);
  };

  const saveWords = async (categories: WordCategory[]) => {
    const response = await request("words:set", { categories });
    if (!response.ok) return response.error ?? "Couldn't save those words.";
    setWordCategories(response.categories ?? categories);
    return null;
  };

  const openPlayers = async () => {
    setPanelOpen(true);
    if (room?.hostId !== socket.id) return;
    const response = await request("moderation:state");
    if (response.ok) {
      setMutedIds(response.mutedProfileIds ?? []);
      setReports(response.reports ?? []);
    }
  };

  const kickPlayer = async (targetId: string, ban: boolean) => {
    const response = await request("moderation:kick", { targetId, ban });
    return response.ok ? null : (response.error ?? "Couldn't remove that player.");
  };

  const mutePlayer = async (targetId: string, muted: boolean) => {
    const response = await request("moderation:mute", { targetId, muted });
    if (!response.ok) return response.error ?? "Couldn't update the mute.";
    const target = room
      ? [...room.players, ...room.spectators].find((seat) => seat.id === targetId)
      : undefined;
    if (target) {
      setMutedIds((current) =>
        muted ? Array.from(new Set([...current, target.profileId])) : current.filter((id) => id !== target.profileId),
      );
    }
    return null;
  };

  const reportPlayer = async (targetId: string, reason: string) => {
    const response = await request("moderation:report", { targetId, reason });
    return response.ok ? null : (response.error ?? "Couldn't send the report.");
  };

  const leave = () => {
    Alert.alert("Leave the room?", "You'll lose your spot and your score for this game.", [
      { text: "Stay", style: "cancel" },
      {
        text: "Leave",
        style: "destructive",
        onPress: () => {
          if (leftRef.current) return;
          leftRef.current = true;
          const finish = () => {
            clearSession();
            socket.disconnect();
            router.replace("/");
          };
          if (!socket.connected) {
            finish();
            return;
          }
          socket.timeout(1500).emit("room:leave", {}, () => finish());
          setTimeout(finish, 1600);
        },
      },
    ]);
  };

  const startGame = () => {
    socket.emit("game:start", {}, (response: AckResponse) => {
      if (response && !response.ok) Alert.alert("Can't start yet", response.error ?? "");
    });
  };

  const chooseWord = (word: string) => {
    socket.emit("word:choose", { word }, (response: AckResponse) => {
      if (response && !response.ok) Alert.alert("Couldn't choose that word", response.error ?? "");
    });
    setOptions([]);
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.loading} edges={["top", "bottom"]}>
        <ActivityIndicator color={colors.ink} />
        <Text style={styles.loadingText}>JOINING THE ROOM…</Text>
      </SafeAreaView>
    );
  }

  if (!room) {
    return (
      <SafeAreaView style={styles.loading} edges={["top", "bottom"]}>
        <Text style={styles.loadingText}>{banner ?? "ROOM UNAVAILABLE"}</Text>
        <BrutalButton label="BACK TO HOME" onPress={() => router.replace("/")} />
      </SafeAreaView>
    );
  }

  const isDrawer = room.isDrawer;
  const isHost = room.hostId === socket.id;
  const isSpectator = room.isSpectator;
  const canDraw = isDrawer && room.status === "drawing" && online && room.secretWord != null;
  const serverNow = clock + clockOffsetRef.current;
  const secondsLeft = room.endsAt ? Math.max(0, Math.ceil((room.endsAt - serverNow) / 1000)) : null;
  const chooseLeft = room.chooseEndsAt
    ? Math.max(0, Math.ceil((room.chooseEndsAt - serverNow) / 1000))
    : null;
  // One shared 4:3 canvas: normalized stroke coordinates must map to the same
  // shape on every screen, so this is never stretched to fill. The 9pt reserve
  // covers the 2.5pt border on both sides plus the 4pt offset shadow.
  const canvasWidth = Math.max(
    0,
    Math.min(canvasBox.width - 9, (canvasBox.height - 9) * (4 / 3)),
  );
  const ranking = [...room.players].sort((a, b) => b.score - a.score);
  const iGuessed = room.guessedIds?.includes(socket.id ?? "") ?? false;
  const wordChoices = room.wordChoices?.length ? room.wordChoices : options;
  const chatDisabled = !online || room.status === "ended" || iGuessed || room.youAreMuted;
  const chatPlaceholder = room.youAreMuted
    ? "You are muted by the host"
    : isSpectator
      ? "Chat with players…"
      : room.status === "drawing" && !isDrawer && !iGuessed
        ? "Type your guess…"
        : "Chat with players…";
  const myProfileId = room.players.find((player) => player.id === socket.id)?.profileId;
  const finalPlayers =
    match?.players ??
    ranking.map((player, index) => ({
      profileId: player.profileId,
      name: player.name,
      avatar: player.avatar,
      score: player.score,
      rank: index + 1,
      won: index === 0,
      guesses: 0,
      correctGuesses: 0,
    }));
  const myResult = match?.players.find((player) => player.profileId === myProfileId);

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <SafeAreaView style={styles.page} edges={["top", "bottom"]}>
        <View style={styles.topBar}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Leave room"
            onPress={leave}
            style={({ pressed }) => [styles.leaveButton, pressed && styles.pressed]}
          >
            <Icon name="chevronLeft" size={18} />
            <Text style={styles.leaveText}>LEAVE</Text>
          </Pressable>
          <View style={styles.codeTag}>
            <Text style={styles.codeText}>{room.code}</Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Players and moderation"
            onPress={openPlayers}
            style={({ pressed }) => [styles.playersButton, pressed && styles.pressed]}
          >
            <Icon name="users" size={17} />
            <Text style={styles.playersCount}>{room.players.length + room.spectators.length}</Text>
          </Pressable>
          <View style={styles.roundTag}>
            <Text style={styles.roundText}>
              {room.status === "lobby" || room.status === "ended"
                ? `R${room.round}/${room.maxRounds}`
                : secondsLeft != null
                  ? `${secondsLeft}s`
                  : "—"}
            </Text>
          </View>
        </View>

        {isSpectator ? (
          <View style={styles.spectatorBanner}>
            <Icon name="eye" size={16} />
            <Text style={styles.spectatorText}>
              You&apos;re watching. Guessing and drawing are off, but chat is open.
            </Text>
          </View>
        ) : null}

        {banner ? (
          <View style={styles.banner}>
            <Icon name="info" size={16} />
            <Text style={styles.bannerText} accessibilityLiveRegion="polite">
              {banner}
              {!online && attempt > 1 ? ` (attempt ${attempt})` : ""}
            </Text>
            {online ? (
              <Pressable onPress={resync} accessibilityRole="button" accessibilityLabel="Resync">
                <Text style={styles.bannerAction}>RETRY</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        <View style={styles.body}>
          {keyboardOpen ? null : (
            <PlayerStrip
              players={room.players}
              drawerId={room.drawerId}
              hostId={room.hostId}
              meId={socket.id}
              guessedIds={room.guessedIds}
              spectatorCount={room.spectators.length}
            />
          )}

          {room.status === "drawing" ? (
            <View style={[styles.drawingWrap, landscape && styles.drawingWrapLandscape]}>
              <View style={styles.drawingColumn}>
                <View style={styles.wordRow}>
                  <View style={styles.wordBox}>
                    <Text
                      style={styles.word}
                      accessibilityLabel={isDrawer ? "Your word" : "Hidden word"}
                    >
                      {isDrawer ? room.secretWord : room.maskedWord}
                    </Text>
                  </View>
                  <View style={styles.wordMetaRow}>
                    <View style={styles.statusPill}>
                      <Icon
                        name={isDrawer ? "brush" : isSpectator ? "eye" : iGuessed ? "check" : "info"}
                        size={13}
                      />
                      <Text style={styles.statusText} numberOfLines={1}>
                        {isSpectator
                          ? "WATCHING"
                          : isDrawer
                            ? "YOU'RE DRAWING"
                            : iGuessed
                              ? "YOU GUESSED IT"
                              : `${(room.drawerName ?? "SOMEONE").toUpperCase()} IS DRAWING`}
                      </Text>
                    </View>
                    {secondsLeft != null ? (
                      <View style={styles.countdown}>
                        <Text style={styles.countdownText}>{secondsLeft}s</Text>
                      </View>
                    ) : null}
                  </View>
                </View>

                <View
                  style={styles.canvasBox}
                  onLayout={(event) =>
                    setCanvasBox({
                      width: event.nativeEvent.layout.width,
                      height: event.nativeEvent.layout.height,
                    })
                  }
                >
                  {canvasWidth > 0 ? (
                    <View style={styles.canvasFrame}>
                      <View pointerEvents="none" style={styles.canvasShadow} />
                      <View style={styles.canvasFace}>
                        <DrawingCanvas
                          strokes={board.strokes}
                          editable={canDraw}
                          hint={!isDrawer ? "Watch the drawing" : undefined}
                          width={canvasWidth}
                          onBegin={handleBegin}
                          onPoints={handlePoints}
                          onEnd={handleEnd}
                        />
                      </View>
                    </View>
                  ) : null}
                </View>

                {isDrawer ? (
                  <DrawingToolbar
                    tool={tool}
                    color={color}
                    size={size}
                    canUndo={board.undoDepth > 0}
                    canRedo={board.redoDepth > 0}
                    disabled={!online}
                    onToolChange={setTool}
                    onColorChange={(next) => {
                      setColor(next);
                      setTool("pen");
                    }}
                    onSizeChange={setSize}
                    onUndo={requestUndo}
                    onRedo={requestRedo}
                    onClear={confirmClear}
                  />
                ) : (
                  <Text style={styles.note}>
                    {isSpectator
                      ? "Spectators can chat but never score. Enjoy the show."
                      : iGuessed
                        ? "You're on the board — watch the rest of the round."
                        : "Type your guess below. The server checks every guess."}
                  </Text>
                )}
              </View>

              <ChatPanel
                style={landscape ? styles.chatSide : styles.chatBottom}
                messages={messages}
                meId={socket.id}
                disabled={chatDisabled}
                placeholder={chatPlaceholder}
                guessed={iGuessed}
                onSend={sendChat}
              />
            </View>
          ) : (
            <>
              <ScrollView
                style={styles.flex}
                contentContainerStyle={styles.stage}
                keyboardShouldPersistTaps="handled"
              >
                {room.status === "lobby" ? (
                  <BrutalCard bodyStyle={styles.lobbyBody}>
                    <View style={styles.lobbyHeader}>
                      <View style={styles.lobbyCodeCopy}>
                        <Text style={styles.kicker}>ROOM CODE</Text>
                        <Text style={styles.lobbyCode}>{room.code}</Text>
                      </View>
                      <BrutalPill
                        label={(room.visibility ?? "private").toUpperCase()}
                        color={room.visibility === "public" ? colors.green : colors.gray}
                      />
                    </View>
                    <Text style={styles.sub}>
                      {room.requireInvite
                        ? "Invite-only: share the link, not just the code."
                        : "Share the code or invite link with friends."}
                    </Text>
                    {isHost ? (
                      <BrutalButton
                        label="SHARE INVITE LINK"
                        icon="share"
                        color={colors.cyan}
                        compact
                        onPress={() => void shareInvite()}
                      />
                    ) : null}

                    <Text style={styles.sectionLabel}>
                      PLAYERS · {room.players.length}/{room.maxPlayers}
                    </Text>
                    {room.players.map((player) => (
                      <View key={player.id} style={styles.playerRow}>
                        <AvatarTile value={player.avatar} size={38} hasCrown={player.id === room.hostId} />
                        <View style={styles.playerCopy}>
                          <View style={styles.playerNameRow}>
                            <Text style={styles.playerName} numberOfLines={1}>
                              {player.name}
                            </Text>
                          </View>
                          <Text style={styles.playerMeta}>
                            {player.id === socket.id ? "YOU · " : ""}
                            {player.connected ? "READY" : "OFFLINE"}
                          </Text>
                        </View>
                      </View>
                    ))}

                    <BrutalButton
                      label="PLAYERS & MODERATION"
                      icon="users"
                      color={colors.surface}
                      compact
                      onPress={() => void openPlayers()}
                    />

                    <RoomSettings
                      room={room}
                      isHost={isHost}
                      onConfigure={configure}
                      onOpenWords={openWordEditor}
                    />

                    {isHost ? (
                      <BrutalButton
                        label={room.players.length < 2 ? "NEED 2+ PLAYERS" : "START GAME"}
                        icon="play"
                        onPress={startGame}
                        disabled={room.players.length < 2}
                      />
                    ) : (
                      <Text style={styles.note}>Waiting for the host to start the game…</Text>
                    )}
                  </BrutalCard>
                ) : room.status === "ended" ? (
                  <BrutalCard bodyStyle={styles.lobbyBody}>
                    <View style={styles.endedHeader}>
                      <View style={styles.trophyBadge}>
                        <Icon name="trophy" size={26} />
                      </View>
                      <Text style={styles.endedTitle}>GAME OVER</Text>
                    </View>
                    <Text style={styles.sub}>
                      {match
                        ? `${match.players.length} players · ${match.rounds} round${match.rounds === 1 ? "" : "s"} · ${new Date(match.at).toLocaleTimeString()}`
                        : "Recording the final results…"}
                    </Text>
                    {finalPlayers.map((player, index) => (
                      <View key={`${player.profileId ?? player.name}-${index}`} style={styles.resultRow}>
                        <View style={styles.rankBox}>
                          <Text style={styles.rankText}>{player.rank}</Text>
                        </View>
                        <AvatarTile value={player.avatar} size={36} hasCrown={player.rank === 1} />
                        <Text style={styles.resultName} numberOfLines={1}>
                          {player.name}
                          {player.profileId === myProfileId ? " (you)" : ""}
                        </Text>
                        <Text style={styles.score}>{player.score}</Text>
                      </View>
                    ))}
                    {myResult ? (
                      <Text style={styles.resultNote}>
                        You finished #{myResult.rank} with {myResult.score} points and{" "}
                        {myResult.correctGuesses} correct guess
                        {myResult.correctGuesses === 1 ? "" : "es"}.
                      </Text>
                    ) : null}
                    <BrutalButton
                      label="PROFILE, STATS & HISTORY"
                      icon="trophy"
                      color={colors.surface}
                      compact
                      onPress={() => router.push("/profile")}
                    />
                    <BrutalButton label="LEAVE ROOM" onPress={leave} />
                  </BrutalCard>
                ) : room.status === "choosing" ? (
                  <BrutalCard bodyStyle={styles.lobbyBody}>
                    {isDrawer ? (
                      <>
                        <View style={styles.choosingHeader}>
                          <Text style={styles.heading}>PICK YOUR WORD</Text>
                          {chooseLeft != null ? (
                            <View style={styles.countdown}>
                              <Text style={styles.countdownText}>{chooseLeft}s</Text>
                            </View>
                          ) : null}
                        </View>
                        <Text style={styles.sub}>
                          Three options. They start drawing automatically if you don&apos;t pick.
                        </Text>
                        <View style={styles.choiceList}>
                          {wordChoices.length ? (
                            wordChoices.map((word) => (
                              <BrutalButton
                                key={word}
                                label={word.toUpperCase()}
                                accessibilityLabel={`Choose ${word}`}
                                onPress={() => chooseWord(word)}
                              />
                            ))
                          ) : (
                            <Text style={styles.note}>Waiting for word options…</Text>
                          )}
                        </View>
                      </>
                    ) : (
                      <>
                        <Text style={styles.heading}>
                          {(room.drawerName ?? "THE DRAWER").toUpperCase()} IS CHOOSING
                        </Text>
                        <Text style={styles.sub}>
                          {room.drawerName ?? "The drawer"} has three options. Word starts in{" "}
                          {chooseLeft ?? secondsLeft ?? "?"}s.
                        </Text>
                        <Text style={styles.note}>Get your guesses ready below.</Text>
                      </>
                    )}
                  </BrutalCard>
                ) : null}
              </ScrollView>

              {room.status !== "ended" ? (
                <ChatPanel
                  style={styles.chatBottom}
                  messages={messages}
                  meId={socket.id}
                  disabled={chatDisabled}
                  placeholder={chatPlaceholder}
                  guessed={iGuessed}
                  onSend={sendChat}
                />
              ) : null}
            </>
          )}
        </View>

        <WordListEditor
          visible={wordsOpen}
          initial={wordCategories}
          onClose={() => setWordsOpen(false)}
          onSave={saveWords}
        />
        <PlayerPanel
          visible={panelOpen}
          room={room}
          meId={socket.id}
          isHost={isHost}
          mutedProfileIds={mutedIds}
          reports={reports}
          onClose={() => setPanelOpen(false)}
          onKick={kickPlayer}
          onMute={mutePlayer}
          onReport={reportPlayer}
        />
      </SafeAreaView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  page: { flex: 1, backgroundColor: colors.bg },
  loading: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 14,
    backgroundColor: colors.bg,
    padding: 24,
  },
  loadingText: { ...type.label, letterSpacing: 2, textAlign: "center" },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  leaveButton: {
    minHeight: 38,
    paddingHorizontal: 8,
    borderWidth: BORDER_WIDTH,
    borderColor: colors.ink,
    borderRadius: 9,
    backgroundColor: colors.surface,
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },
  leaveText: { fontSize: 9.5, fontWeight: "900", letterSpacing: 0.8, color: colors.ink },
  pressed: { transform: [{ translateX: 2 }, { translateY: 2 }] },
  codeTag: {
    flex: 1,
    alignItems: "center",
    backgroundColor: colors.yellow,
    borderRadius: 9,
    paddingVertical: 8,
    borderWidth: BORDER_WIDTH,
    borderColor: colors.ink,
  },
  codeText: { fontWeight: "900", letterSpacing: 3, color: colors.ink, fontSize: 14, fontFamily: monoFont },
  playersButton: {
    minHeight: 38,
    paddingHorizontal: 8,
    borderRadius: 9,
    borderWidth: BORDER_WIDTH,
    borderColor: colors.ink,
    backgroundColor: colors.surface,
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
  },
  playersCount: { fontSize: 12, fontWeight: "900", color: colors.ink },
  roundTag: {
    minWidth: 52,
    alignItems: "center",
    backgroundColor: colors.ink,
    borderRadius: 9,
    paddingVertical: 9,
    paddingHorizontal: 7,
  },
  roundText: { color: colors.surface, fontWeight: "900", fontSize: 12, fontFamily: monoFont },
  banner: {
    marginHorizontal: 12,
    marginBottom: 7,
    padding: 9,
    borderRadius: 9,
    borderWidth: BORDER_WIDTH,
    borderColor: colors.ink,
    backgroundColor: colors.amber,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  bannerText: { flex: 1, color: colors.ink, fontSize: 11, fontWeight: "700", lineHeight: 15 },
  bannerAction: { color: colors.ink, fontWeight: "900", fontSize: 10, letterSpacing: 0.8, textDecorationLine: "underline" },
  spectatorBanner: {
    marginHorizontal: 12,
    marginBottom: 7,
    padding: 9,
    borderRadius: 9,
    borderWidth: BORDER_WIDTH,
    borderColor: colors.ink,
    backgroundColor: colors.cyan,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  spectatorText: { flex: 1, color: colors.ink, fontSize: 11, fontWeight: "800", lineHeight: 15 },
  body: { flex: 1, paddingHorizontal: 12, gap: 8, paddingBottom: 6 },
  stage: { gap: 10, paddingBottom: 10 },
  // Drawing phase: no outer scroll view, so a drag can never be stolen by one.
  drawingWrap: { flex: 1, gap: 7, minHeight: 0 },
  drawingWrapLandscape: { flexDirection: "row" },
  drawingColumn: { flex: 1, gap: 7, minHeight: 0 },
  wordRow: { gap: 5 },
  wordBox: {
    borderWidth: BORDER_WIDTH,
    borderColor: colors.ink,
    borderRadius: radii.sm,
    backgroundColor: colors.surface,
    paddingVertical: 6,
    paddingHorizontal: 10,
    alignItems: "center",
  },
  word: {
    fontSize: 20,
    fontWeight: "900",
    letterSpacing: 5,
    color: colors.ink,
    textTransform: "uppercase",
    fontFamily: monoFont,
  },
  wordMetaRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  statusPill: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderWidth: 2,
    borderColor: colors.ink,
    borderRadius: 7,
    backgroundColor: colors.bg,
    paddingHorizontal: 7,
    paddingVertical: 4,
  },
  statusText: { fontSize: 8.5, fontWeight: "900", letterSpacing: 0.8, color: colors.ink },
  countdown: {
    minWidth: 54,
    alignItems: "center",
    borderWidth: BORDER_WIDTH,
    borderColor: colors.ink,
    borderRadius: 7,
    backgroundColor: colors.ink,
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  countdownText: { fontSize: 13, fontWeight: "900", color: colors.surface, fontFamily: monoFont },
  canvasBox: { flex: 1, minHeight: 56, alignItems: "center", justifyContent: "center" },
  canvasFrame: { paddingRight: 4, paddingBottom: 4 },
  canvasShadow: {
    position: "absolute",
    left: 4,
    top: 4,
    right: 0,
    bottom: 0,
    backgroundColor: colors.ink,
    borderRadius: 12,
  },
  canvasFace: {
    borderWidth: BORDER_WIDTH,
    borderColor: colors.ink,
    borderRadius: 12,
    backgroundColor: colors.surface,
    overflow: "hidden",
  },
  chatBottom: { height: 176, flexShrink: 0 },
  chatSide: { width: 280, height: "100%" },
  note: { ...type.body, fontSize: 11.5, color: "#555", lineHeight: 16 },
  lobbyBody: { padding: 14, gap: 10 },
  lobbyHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  lobbyCodeCopy: { flex: 1 },
  kicker: { ...type.label, letterSpacing: 1.6 },
  lobbyCode: { fontSize: 34, fontWeight: "900", letterSpacing: 6, color: colors.ink, fontFamily: monoFont },
  heading: { ...type.heading, fontSize: 18 },
  sub: { ...type.body, color: "#3A3A3A" },
  sectionLabel: { ...type.label, marginTop: 2 },
  playerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    borderWidth: 2,
    borderColor: colors.ink,
    borderRadius: 9,
    backgroundColor: colors.bg,
    padding: 8,
  },
  playerCopy: { flex: 1 },
  playerNameRow: { flexDirection: "row", alignItems: "center", gap: 5 },
  playerName: { fontSize: 13, fontWeight: "900", color: colors.ink, flexShrink: 1 },
  playerMeta: { fontSize: 8.5, fontWeight: "800", letterSpacing: 0.8, color: "#555", marginTop: 2 },
  endedHeader: { flexDirection: "row", alignItems: "center", gap: 10 },
  trophyBadge: {
    width: 48,
    height: 48,
    borderWidth: BORDER_WIDTH,
    borderColor: colors.ink,
    borderRadius: 12,
    backgroundColor: colors.yellow,
    alignItems: "center",
    justifyContent: "center",
  },
  endedTitle: { ...type.title, fontSize: 24 },
  resultRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    borderTopWidth: 2,
    borderTopColor: colors.ink,
    paddingTop: 8,
  },
  rankBox: {
    width: 28,
    height: 28,
    borderRadius: 7,
    borderWidth: 2,
    borderColor: colors.ink,
    backgroundColor: colors.bg,
    alignItems: "center",
    justifyContent: "center",
  },
  rankText: { fontSize: 12, fontWeight: "900", color: colors.ink, fontFamily: monoFont },
  resultName: { flex: 1, fontSize: 13, fontWeight: "900", color: colors.ink },
  score: { fontSize: 14, fontWeight: "900", color: colors.ink, fontFamily: monoFont },
  resultNote: {
    fontSize: 11,
    fontWeight: "700",
    color: colors.ink,
    lineHeight: 16,
    backgroundColor: colors.lime,
    borderWidth: 2,
    borderColor: colors.ink,
    borderRadius: 8,
    padding: 9,
  },
  choosingHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  choiceList: { gap: 9, marginTop: 2 },
});
