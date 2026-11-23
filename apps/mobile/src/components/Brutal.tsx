import React, { useRef } from "react";
import {
  Animated,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import Icon, { type IconName } from "./Icons";
import { BORDER_WIDTH, PRESS_OFFSET, SHADOW_OFFSET, colors, radii, type } from "../theme";

type BrutalCardProps = {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  bodyStyle?: StyleProp<ViewStyle>;
  color?: string;
  cardRadius?: number;
  shadow?: number;
};

/**
 * Bordered surface with a solid black offset layer drawn behind it. The layer
 * is a real view (not `elevation`), so Android renders a crisp hard shadow
 * instead of a grey blur.
 */
export function BrutalCard({
  children,
  style,
  bodyStyle,
  color = colors.surface,
  cardRadius = radii.lg,
  shadow = SHADOW_OFFSET,
}: BrutalCardProps) {
  return (
    <View style={[{ paddingRight: shadow, paddingBottom: shadow }, style]}>
      <View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFillObject,
          {
            left: shadow,
            top: shadow,
            right: 0,
            bottom: 0,
            backgroundColor: colors.ink,
            borderRadius: cardRadius,
          },
        ]}
      />
      <View
        style={[
          {
            backgroundColor: color,
            borderWidth: BORDER_WIDTH,
            borderColor: colors.ink,
            borderRadius: cardRadius,
            overflow: "hidden",
          },
          bodyStyle,
        ]}
      >
        {children}
      </View>
    </View>
  );
}

type BrutalButtonProps = {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  color?: string;
  textColor?: string;
  icon?: IconName;
  style?: StyleProp<ViewStyle>;
  labelStyle?: StyleProp<TextStyle>;
  accessibilityLabel?: string;
  compact?: boolean;
};

/** Chunky CTA that physically presses into its own hard shadow. */
export function BrutalButton({
  label,
  onPress,
  disabled = false,
  color = colors.yellow,
  textColor = colors.ink,
  icon,
  style,
  labelStyle,
  accessibilityLabel,
  compact = false,
}: BrutalButtonProps) {
  const shift = useRef(new Animated.Value(0)).current;
  const animate = (to: number) =>
    Animated.timing(shift, { toValue: to, duration: 70, useNativeDriver: true }).start();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      onPressIn={() => animate(PRESS_OFFSET)}
      onPressOut={() => animate(0)}
      style={[styles.buttonOuter, disabled && styles.disabled, style]}
    >
      <View pointerEvents="none" style={styles.buttonShadow} />
      <Animated.View
        style={[
          styles.buttonFace,
          { backgroundColor: color, transform: [{ translateX: shift }, { translateY: shift }] },
          compact && styles.buttonFaceCompact,
        ]}
      >
        {icon ? <Icon name={icon} size={compact ? 18 : 20} color={textColor} /> : null}
        <Text style={[styles.buttonLabel, { color: textColor }, labelStyle]} numberOfLines={1}>
          {label}
        </Text>
      </Animated.View>
    </Pressable>
  );
}

type BrutalIconButtonProps = {
  icon: IconName;
  onPress: () => void;
  accessibilityLabel: string;
  size?: number;
  color?: string;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
};

/** Square bordered icon button used in headers and toolbars. */
export function BrutalIconButton({
  icon,
  onPress,
  accessibilityLabel,
  size = 46,
  color = colors.surface,
  disabled = false,
  style,
}: BrutalIconButtonProps) {
  const shift = useRef(new Animated.Value(0)).current;
  const animate = (to: number) =>
    Animated.timing(shift, { toValue: to, duration: 70, useNativeDriver: true }).start();
  const faceRadius = Math.round(size * 0.26);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      onPressIn={() => animate(PRESS_OFFSET)}
      onPressOut={() => animate(0)}
      style={[{ width: size + SHADOW_OFFSET, height: size + SHADOW_OFFSET }, disabled && styles.disabled, style]}
    >
      <View
        pointerEvents="none"
        style={[
          styles.buttonShadow,
          { borderRadius: faceRadius + 1, left: SHADOW_OFFSET - 1, top: SHADOW_OFFSET - 1 },
        ]}
      />
      <Animated.View
        style={[
          styles.iconFace,
          {
            width: size,
            height: size,
            borderRadius: faceRadius,
            backgroundColor: color,
            transform: [{ translateX: shift }, { translateY: shift }],
          },
        ]}
      >
        <Icon name={icon} size={Math.round(size * 0.48)} />
      </Animated.View>
    </Pressable>
  );
}

export function BrutalInput({ style, ...props }: TextInputProps) {
  return (
    <TextInput
      placeholderTextColor={colors.muted}
      selectionColor={colors.ink}
      {...props}
      style={[styles.input, style]}
    />
  );
}

export function BrutalPill({
  label,
  color = colors.surface,
  textColor = colors.ink,
  style,
}: {
  label: string;
  color?: string;
  textColor?: string;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.pill, { backgroundColor: color }, style]}>
      <Text style={[styles.pillText, { color: textColor }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

/** Bottom sheet with the same ink border and offset shadow as the rest. */
export function BrutalSheet({
  visible,
  onClose,
  title,
  children,
  footer,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheetOuter}>
          <View pointerEvents="none" style={styles.sheetShadow} />
          <View style={styles.sheet}>
            <View style={styles.sheetHeader}>
              <Text style={type.title}>{title}</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close"
                hitSlop={10}
                onPress={onClose}
                style={styles.sheetClose}
              >
                <Icon name="close" size={18} />
              </Pressable>
            </View>
            <ScrollView
              style={styles.sheetScroll}
              contentContainerStyle={styles.sheetContent}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              {children}
            </ScrollView>
            {footer ? <View style={styles.sheetFooter}>{footer}</View> : null}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  disabled: { opacity: 0.45 },
  buttonOuter: { paddingRight: SHADOW_OFFSET, paddingBottom: SHADOW_OFFSET },
  buttonShadow: {
    position: "absolute",
    left: SHADOW_OFFSET,
    top: SHADOW_OFFSET,
    right: 0,
    bottom: 0,
    backgroundColor: colors.ink,
    borderRadius: radii.md,
  },
  buttonFace: {
    minHeight: 52,
    paddingHorizontal: 16,
    borderRadius: radii.md,
    borderWidth: BORDER_WIDTH,
    borderColor: colors.ink,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  buttonFaceCompact: { minHeight: 44, paddingHorizontal: 12 },
  buttonLabel: { fontSize: 15, fontWeight: "900", letterSpacing: 0.2 },
  iconFace: {
    borderWidth: BORDER_WIDTH,
    borderColor: colors.ink,
    alignItems: "center",
    justifyContent: "center",
  },
  input: {
    minHeight: 50,
    borderWidth: BORDER_WIDTH,
    borderColor: colors.ink,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
    fontWeight: "700",
    color: colors.ink,
  },
  pill: {
    borderWidth: 2,
    borderColor: colors.ink,
    borderRadius: radii.xs,
    paddingHorizontal: 7,
    paddingVertical: 2,
    alignSelf: "flex-start",
  },
  pillText: { fontSize: 9, fontWeight: "900", letterSpacing: 1, textTransform: "uppercase" },
  backdrop: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: colors.backdrop,
    padding: 14,
  },
  sheetOuter: { paddingRight: SHADOW_OFFSET, paddingBottom: SHADOW_OFFSET },
  sheetShadow: {
    position: "absolute",
    left: SHADOW_OFFSET,
    top: SHADOW_OFFSET,
    right: 0,
    bottom: 0,
    backgroundColor: colors.ink,
    borderRadius: radii.xl,
  },
  sheet: {
    backgroundColor: colors.bg,
    borderWidth: BORDER_WIDTH,
    borderColor: colors.ink,
    borderRadius: radii.xl,
    maxHeight: "92%",
    overflow: "hidden",
  },
  sheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: BORDER_WIDTH,
    borderBottomColor: colors.ink,
    backgroundColor: colors.surface,
  },
  sheetClose: {
    width: 34,
    height: 34,
    borderWidth: 2,
    borderColor: colors.ink,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.bg,
  },
  sheetScroll: { flexShrink: 1 },
  sheetContent: { padding: 16, gap: 14 },
  sheetFooter: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 16,
    borderTopWidth: BORDER_WIDTH,
    borderTopColor: colors.ink,
    backgroundColor: colors.surface,
  },
});
