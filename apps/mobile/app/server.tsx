import React, { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { router } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  envServerUrl,
  isLoopbackUrl,
  normalizeServerUrl,
  saveServerUrl,
} from "../src/config";
import { applyServerUrl, connectSocket, getSocketUrl, socket } from "../src/socket";
import { clearSession } from "../src/session";
import { forgetIdentity } from "../src/auth";
import Icon from "../src/components/Icons";
import {
  BrutalButton,
  BrutalCard,
  BrutalIconButton,
  BrutalInput,
  BrutalPill,
} from "../src/components/Brutal";
import { colors, monoFont, type } from "../src/theme";

const checkHealth = async (url: string) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const response = await fetch(`${url}/health`, { signal: controller.signal });
    if (!response.ok) throw new Error(`Server replied ${response.status}`);
  } finally {
    clearTimeout(timer);
  }
};

/** Developer-only route. Normal players reach it through Settings after 5 taps. */
export default function ServerScreen() {
  const [value, setValue] = useState(getSocketUrl());
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const normalized = normalizeServerUrl(value);
  const buildDefault = envServerUrl();

  const test = async () => {
    if (!normalized) {
      setError("Enter an address like http://192.168.1.20:3001 or https://game.example.com.");
      return;
    }
    setBusy(true);
    setError(null);
    setStatus("Testing…");
    try {
      await checkHealth(normalized);
      setStatus(`Reachable at ${normalized}`);
    } catch (failure) {
      setStatus(null);
      setError(
        failure instanceof Error && failure.name === "AbortError"
          ? "No answer within 6 seconds. Check the IP, port and Wi-Fi network."
          : "Could not reach that server. Check the address, port and firewall.",
      );
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!normalized) {
      setError("Enter an address like http://192.168.1.20:3001 or https://game.example.com.");
      return;
    }
    setBusy(true);
    setError(null);
    const changed = normalized !== getSocketUrl();
    try {
      // Accounts and room seats belong to the server that issued them.
      if (changed) {
        clearSession();
        forgetIdentity();
        try {
          socket.disconnect();
        } catch {
          // Nothing to close.
        }
      }
      await saveServerUrl(normalized);
      applyServerUrl(normalized);
      try {
        await connectSocket(6000);
      } catch {
        // Saved anyway; the home screen shows the connection state.
      }
      router.back();
    } catch {
      setError("Could not save that address. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.page} edges={["top", "bottom"]}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={styles.topBar}>
          <BrutalIconButton
            icon="chevronLeft"
            accessibilityLabel="Back"
            size={42}
            onPress={() => router.back()}
          />
          <BrutalPill label="Developer" color={colors.amber} />
        </View>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <Text style={styles.kicker}>GAME SERVER</Text>
          <Text style={styles.title}>Where is the game hosted?</Text>
          <Text style={styles.sub}>
            A phone cannot use <Text style={styles.code}>localhost</Text>. Use your computer's LAN
            address (e.g. <Text style={styles.code}>http://192.168.1.20:3001</Text>) while testing,
            or the public https address of a deployed server.
          </Text>

          <BrutalInput
            value={value}
            onChangeText={setValue}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            placeholder="http://192.168.1.20:3001"
            accessibilityLabel="Game server address"
            editable={!busy}
            style={styles.input}
          />

          {normalized && isLoopbackUrl(normalized) ? (
            <View style={styles.warn}>
              <Icon name="info" size={16} />
              <Text style={styles.warnText}>
                Loopback only works on the machine running the server, or the Android emulator at
                10.0.2.2. A real phone needs your LAN IP.
              </Text>
            </View>
          ) : null}

          <BrutalButton
            label="TEST CONNECTION"
            color={colors.cyan}
            icon="refresh"
            onPress={() => void test()}
            disabled={busy}
          />
          <BrutalButton
            label="SAVE & CONNECT"
            icon={busy ? undefined : "arrowRight"}
            onPress={() => void save()}
            disabled={busy}
          />
          {busy ? <ActivityIndicator color={colors.ink} /> : null}

          {status ? (
            <View style={styles.notice}>
              <Icon name="check" size={16} />
              <Text style={styles.noticeText}>{status}</Text>
            </View>
          ) : null}
          {error ? (
            <View style={styles.errorBox}>
              <Icon name="close" size={16} />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          <BrutalCard bodyStyle={styles.tipsBody}>
            <Text style={styles.tipsTitle}>QUICK CHECKLIST</Text>
            <Text style={styles.tip}>• Start the server with Postgres and Redis running.</Text>
            <Text style={styles.tip}>• Phone and computer must be on the same Wi-Fi.</Text>
            <Text style={styles.tip}>
              • Allow port 3001 through the computer's firewall (or expose it with a tunnel).
            </Text>
            <Text style={styles.tip}>
              • Production must use https/wss; Android blocks plain HTTP outside development.
            </Text>
          </BrutalCard>

          {buildDefault ? (
            <BrutalButton
              label="USE BUILD DEFAULT"
              color={colors.surface}
              compact
              onPress={() => setValue(buildDefault)}
              accessibilityLabel="Use build default address"
            />
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 10,
  },
  scroll: { padding: 18, paddingBottom: 40, gap: 12, width: "100%", maxWidth: 560, alignSelf: "center" },
  kicker: { ...type.label, letterSpacing: 2 },
  title: { ...type.title },
  sub: { ...type.body, color: "#3A3A3A" },
  code: { fontFamily: monoFont, fontWeight: "800", color: colors.ink },
  input: { minHeight: 54, fontSize: 14, fontFamily: monoFont },
  warn: {
    flexDirection: "row",
    gap: 8,
    alignItems: "flex-start",
    backgroundColor: colors.amber,
    borderWidth: 2,
    borderColor: colors.ink,
    borderRadius: 8,
    padding: 10,
  },
  warnText: { flex: 1, fontSize: 11, lineHeight: 16, fontWeight: "700", color: colors.ink },
  notice: {
    flexDirection: "row",
    gap: 8,
    alignItems: "center",
    backgroundColor: colors.green,
    borderWidth: 2,
    borderColor: colors.ink,
    borderRadius: 8,
    padding: 10,
  },
  noticeText: { flex: 1, fontSize: 11, fontWeight: "800", color: colors.ink },
  errorBox: {
    flexDirection: "row",
    gap: 8,
    alignItems: "center",
    backgroundColor: colors.pink,
    borderWidth: 2,
    borderColor: colors.ink,
    borderRadius: 8,
    padding: 10,
  },
  errorText: { flex: 1, fontSize: 11, fontWeight: "800", color: colors.ink, lineHeight: 16 },
  tipsBody: { padding: 14, gap: 5 },
  tipsTitle: { ...type.label, marginBottom: 2 },
  tip: { fontSize: 11, lineHeight: 16, fontWeight: "600", color: "#3A3A3A" },
});
