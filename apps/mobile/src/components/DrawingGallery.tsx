import React, { useRef, useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { captureRef } from "react-native-view-shot";
import * as Sharing from "expo-sharing";
import type { DrawingGalleryItem } from "../game/types";
import DrawingCanvas from "./DrawingCanvas";
import { BrutalButton } from "./Brutal";
import Icon from "./Icons";
import { BORDER_WIDTH, colors, monoFont, SHADOW_OFFSET, radii, type } from "../theme";

const CARD_WIDTH = 262;
const CARD_CANVAS_WIDTH = 243;

function DrawingCardFace({
  item,
  canvasWidth,
}: {
  item: DrawingGalleryItem;
  canvasWidth: number;
}) {
  return (
    <View style={styles.captureFace}>
      <View pointerEvents="none" style={styles.canvasClip}>
        <DrawingCanvas
          strokes={item.actions}
          editable={false}
          width={canvasWidth}
        />
      </View>
      <View style={styles.cardFooter}>
        <Text style={styles.cardBy} numberOfLines={2}>
          {item.word.toUpperCase()} • BY {item.drawerName.toUpperCase()} • SKRIBLE
        </Text>
      </View>
    </View>
  );
}

export default function DrawingGallery({ items }: { items: DrawingGalleryItem[] }) {
  const cardRefs = useRef<Record<string, View | null>>({});
  const previewRef = useRef<View>(null);
  const [preview, setPreview] = useState<DrawingGalleryItem | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { width: windowWidth } = useWindowDimensions();
  const previewWidth = Math.min(windowWidth - 64, 520);
  const previewCanvasWidth = Math.max(160, previewWidth - 30);

  const share = async (key: string, view: View | null) => {
    if (!view) {
      setError("THAT CARD ISN'T READY YET. TRY AGAIN.");
      return;
    }
    setSaving(key);
    setError(null);
    try {
      const uri = await captureRef(view, { format: "png", quality: 1, result: "tmpfile" });
      console.warn("SKRIBLE_GALLERY_CAPTURE", uri);
      if (!(await Sharing.isAvailableAsync())) {
        throw new Error("Sharing is unavailable");
      }
      await Sharing.shareAsync(uri, {
        mimeType: "image/png",
        dialogTitle: "Share Skrible Drawing",
      });
    } catch (error) {
      console.warn(
        "SKRIBLE_GALLERY_SHARE_FAILED",
        error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error),
      );
      setError("COULDN'T SHARE THAT CARD. TRY AGAIN.");
    } finally {
      setSaving(null);
    }
  };

  return (
    <View style={styles.root}>
      <View style={styles.headingRow}>
        <Text style={styles.heading}>ROUND DRAWINGS</Text>
        <Text style={styles.count}>{items.length} CARDS</Text>
      </View>

      {error ? (
        <View style={styles.errorPill}>
          <Icon name="info" size={12} />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      {items.length === 0 ? (
        <Text style={styles.empty}>NO DRAWINGS THIS MATCH.</Text>
      ) : (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.rail}
        >
          {items.map((item) => (
            <View key={item.id} style={styles.cardOuter}>
              <View pointerEvents="none" style={styles.cardShadow} />
              <View
                ref={(node) => {
                  cardRefs.current[item.id] = node;
                }}
                collapsable={false}
                style={styles.captureCard}
              >
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Preview round ${item.roundNumber}, ${item.word} by ${item.drawerName}`}
                  onPress={() => setPreview(item)}
                  style={({ pressed }) => [styles.cardFace, pressed && styles.pressed]}
                >
                  <DrawingCardFace item={item} canvasWidth={CARD_CANVAS_WIDTH} />
                  <View style={styles.cardMeta}>
                    <Text style={styles.roundTag}>ROUND {item.roundNumber}</Text>
                    <Text style={styles.reactionTag}>
                      LIKE {item.likes} / NOPE {item.nopes}
                    </Text>
                  </View>
                </Pressable>
              </View>
              <BrutalButton
                label={saving === item.id ? "SAVING…" : "SAVE / SHARE"}
                icon="share"
                compact
                color={colors.yellow}
                disabled={saving !== null}
                onPress={() => void share(item.id, cardRefs.current[item.id] ?? null)}
              />
            </View>
          ))}
        </ScrollView>
      )}

      <Modal
        visible={preview != null}
        transparent
        animationType="fade"
        onRequestClose={() => setPreview(null)}
      >
        <View style={styles.previewBackdrop}>
          <View style={styles.previewOuter}>
            <View pointerEvents="none" style={styles.previewShadow} />
            <View style={styles.previewFace}>
              <View style={styles.previewHeader}>
                <View>
                  <Text style={styles.previewKicker}>ROUND {preview?.roundNumber ?? 0} DRAWING</Text>
                  <Text style={styles.previewTitle} numberOfLines={1}>
                    {preview?.word.toUpperCase() ?? ""}
                  </Text>
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Close drawing preview"
                  onPress={() => setPreview(null)}
                  style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}
                >
                  <Icon name="close" size={17} />
                </Pressable>
              </View>
              {preview ? (
                <View
                  ref={previewRef}
                  collapsable={false}
                  style={[styles.previewCapture, { width: previewWidth }]}
                >
                  <View pointerEvents="none">
                    <DrawingCanvas
                      strokes={preview.actions}
                      editable={false}
                      width={previewCanvasWidth}
                    />
                  </View>
                  <View style={styles.previewFooter}>
                    <Text style={styles.previewFooterText} numberOfLines={1}>
                      {preview.word.toUpperCase()} • BY {preview.drawerName.toUpperCase()} • SKRIBLE
                    </Text>
                  </View>
                </View>
              ) : null}
              <BrutalButton
                label={saving === "preview" ? "SAVING…" : "SAVE / SHARE"}
                icon="share"
                disabled={saving !== null || !preview}
                onPress={() => void share("preview", previewRef.current)}
              />
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 7 },
  headingRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  heading: { ...type.label, letterSpacing: 1.4 },
  count: { ...type.tiny, fontSize: 8 },
  rail: { gap: 11, paddingRight: 4, paddingBottom: 2 },
  cardOuter: { width: CARD_WIDTH, paddingRight: SHADOW_OFFSET, paddingBottom: SHADOW_OFFSET, gap: 6 },
  cardShadow: {
    position: "absolute",
    left: SHADOW_OFFSET,
    top: SHADOW_OFFSET,
    right: 0,
    bottom: 0,
    backgroundColor: colors.ink,
    borderRadius: radii.md,
  },
  captureCard: {
    width: CARD_WIDTH,
    borderWidth: BORDER_WIDTH,
    borderColor: colors.ink,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
    overflow: "hidden",
  },
  cardFace: {
    backgroundColor: colors.surface,
  },
  pressed: { transform: [{ translateX: 2 }, { translateY: 2 }] },
  captureFace: { backgroundColor: "#FFFFFF" },
  canvasClip: { backgroundColor: "#FFFFFF", overflow: "hidden" },
  cardFooter: {
    borderTopWidth: 2,
    borderTopColor: colors.ink,
    backgroundColor: colors.surface,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  cardBy: { fontSize: 8, lineHeight: 11, fontWeight: "900", letterSpacing: 0.4, color: colors.ink },
  cardMeta: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderTopWidth: 2,
    borderTopColor: colors.ink,
    backgroundColor: colors.bg,
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  roundTag: { fontSize: 8, fontWeight: "900", letterSpacing: 0.6, color: colors.ink },
  reactionTag: { fontSize: 8, fontWeight: "800", letterSpacing: 0.4, color: "#555" },
  errorPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    alignSelf: "flex-start",
    borderWidth: 2,
    borderColor: colors.ink,
    borderRadius: 7,
    backgroundColor: colors.amber,
    paddingHorizontal: 7,
    paddingVertical: 4,
  },
  errorText: { fontSize: 8.5, fontWeight: "900", letterSpacing: 0.4, color: colors.ink },
  empty: { ...type.tiny, fontStyle: "italic" },
  previewBackdrop: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 18,
    backgroundColor: colors.backdrop,
  },
  previewOuter: { width: "100%", maxWidth: 560, paddingRight: 5, paddingBottom: 5 },
  previewShadow: {
    position: "absolute",
    left: 5,
    top: 5,
    right: 0,
    bottom: 0,
    backgroundColor: colors.ink,
    borderRadius: radii.lg,
  },
  previewFace: {
    borderWidth: BORDER_WIDTH,
    borderColor: colors.ink,
    borderRadius: radii.lg,
    backgroundColor: colors.bg,
    padding: 10,
    gap: 9,
  },
  previewHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  previewKicker: { ...type.label, letterSpacing: 1.1 },
  previewTitle: { ...type.title, fontSize: 22, fontFamily: monoFont },
  closeButton: {
    width: 34,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: BORDER_WIDTH,
    borderColor: colors.ink,
    borderRadius: 8,
    backgroundColor: colors.surface,
  },
  previewCapture: {
    borderWidth: BORDER_WIDTH,
    borderColor: colors.ink,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
    overflow: "hidden",
  },
  previewFooter: {
    borderTopWidth: 2,
    borderTopColor: colors.ink,
    backgroundColor: colors.surface,
    paddingHorizontal: 9,
    paddingVertical: 7,
  },
  previewFooterText: { fontSize: 9, fontWeight: "900", letterSpacing: 0.8, color: colors.ink },
});
