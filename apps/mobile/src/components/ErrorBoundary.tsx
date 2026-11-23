import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import Icon from "./Icons";
import { BORDER_WIDTH, colors, radii, type } from "../theme";

type Props = {
  children: React.ReactNode;
  title?: string;
  /** Provided on the game screen so a render error can try the room again. */
  onRejoin?: () => void;
};

type State = { error: Error | null };

/**
 * Last line of defence on Android: a render error must never take the process
 * down or leave a frozen canvas with no way out.
 */
export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Keep the report local and token-free.
    console.error("[skrible] render error", error.message, info.componentStack);
  }

  private goHome = () => {
    this.setState({ error: null });
    router.replace("/");
  };

  private rejoin = () => {
    this.setState({ error: null });
    this.props.onRejoin?.();
  };

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <View style={styles.page}>
        <View style={styles.outer}>
          <View pointerEvents="none" style={styles.shadow} />
          <View style={styles.card}>
            <View style={styles.iconBadge}>
              <Icon name="bolt" size={26} />
            </View>
            <Text style={styles.title}>{this.props.title ?? "Something went wrong"}</Text>
            <Text style={styles.body}>
              The screen hit an unexpected error. Your room seat is held for a short while, so
              rejoining usually puts you straight back in.
            </Text>
            {this.props.onRejoin ? (
              <Pressable
                style={({ pressed }) => [styles.primary, pressed && styles.pressed]}
                onPress={this.rejoin}
                accessibilityRole="button"
                accessibilityLabel="Rejoin the room"
              >
                <Icon name="refresh" size={16} />
                <Text style={styles.primaryText}>REJOIN ROOM</Text>
              </Pressable>
            ) : null}
            <Pressable
              style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
              onPress={this.goHome}
              accessibilityRole="button"
              accessibilityLabel="Return to home"
            >
              <Text style={styles.secondaryText}>RETURN TO HOME</Text>
            </Pressable>
          </View>
        </View>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.bg,
    padding: 20,
  },
  outer: { width: "100%", maxWidth: 420, paddingRight: 4, paddingBottom: 4 },
  shadow: {
    position: "absolute",
    left: 4,
    top: 4,
    right: 0,
    bottom: 0,
    backgroundColor: colors.ink,
    borderRadius: radii.lg,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: BORDER_WIDTH,
    borderColor: colors.ink,
    padding: 18,
    gap: 11,
  },
  iconBadge: {
    width: 46,
    height: 46,
    borderRadius: 12,
    borderWidth: BORDER_WIDTH,
    borderColor: colors.ink,
    backgroundColor: colors.pink,
    alignItems: "center",
    justifyContent: "center",
  },
  title: { ...type.heading },
  body: { ...type.body, color: "#3A3A3A" },
  primary: {
    minHeight: 48,
    borderRadius: radii.md,
    borderWidth: BORDER_WIDTH,
    borderColor: colors.ink,
    backgroundColor: colors.yellow,
    flexDirection: "row",
    gap: 6,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryText: { color: colors.ink, fontWeight: "900", fontSize: 12, letterSpacing: 0.8 },
  secondary: {
    minHeight: 44,
    borderRadius: radii.md,
    borderWidth: BORDER_WIDTH,
    borderColor: colors.ink,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
  },
  secondaryText: { color: colors.ink, fontWeight: "900", fontSize: 11, letterSpacing: 0.8 },
  pressed: { transform: [{ translateX: 2 }, { translateY: 2 }] },
});
