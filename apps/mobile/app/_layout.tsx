import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as SplashScreen from "expo-splash-screen";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { hydrateIdentity } from "../src/auth";
import { hydrateSession } from "../src/session";
import { envServerUrl, loadStoredServerUrl } from "../src/config";
import { applyServerUrl } from "../src/socket";
import ErrorBoundary from "../src/components/ErrorBoundary";
import { colors } from "../src/theme";

// Keep the native splash up until saved credentials and a room seat have been
// read, so the first route never renders as an empty guest by accident.
void SplashScreen.preventAutoHideAsync().catch(() => undefined);

export default function Layout() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let active = true;
    // The server address must be applied before any screen creates a socket,
    // otherwise the first connection would use the build-time default.
    (async () => {
      const stored = await loadStoredServerUrl();
      const url = stored ?? envServerUrl();
      if (url) applyServerUrl(url);
    })().finally(() => {
      Promise.allSettled([hydrateIdentity(), hydrateSession()]).finally(() => {
        if (!active) return;
        setReady(true);
        void SplashScreen.hideAsync().catch(() => undefined);
      });
    });
    return () => {
      active = false;
    };
  }, []);

  if (!ready) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={colors.ink} />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <ErrorBoundary title="Skrible hit a problem">
        <Stack
          screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}
        />
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg },
});
