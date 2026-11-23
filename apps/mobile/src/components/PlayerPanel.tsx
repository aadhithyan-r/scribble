import React, { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { PlayerReport, RoomUpdate } from "../game/types";
import AvatarTile from "./Avatars";
import Icon from "./Icons";
import { BrutalButton, BrutalInput, BrutalPill, BrutalSheet } from "./Brutal";
import { BORDER_WIDTH, colors, radii, type } from "../theme";

type Props = {
  visible: boolean;
  room: RoomUpdate;
  meId?: string;
  isHost: boolean;
  mutedProfileIds: string[];
  reports: PlayerReport[];
  onClose: () => void;
  onKick: (targetId: string, ban: boolean) => Promise<string | null>;
  onMute: (targetId: string, muted: boolean) => Promise<string | null>;
  onReport: (targetId: string, reason: string) => Promise<string | null>;
};

type Seat = {
  id: string;
  profileId: string;
  name: string;
  avatar: string;
  spectator: boolean;
  score: number;
};

export default function PlayerPanel({
  visible,
  room,
  meId,
  isHost,
  mutedProfileIds,
  reports,
  onClose,
  onKick,
  onMute,
  onReport,
}: Props) {
  const [reportTarget, setReportTarget] = useState<Seat | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const roster = room.players ?? [];
  const spectators = room.spectators ?? [];
  const mutedList = mutedProfileIds ?? [];
  const reportList = reports ?? [];

  const seats: Seat[] = [
    ...roster.map((player) => ({
      id: player.id,
      profileId: player.profileId,
      name: player.name,
      avatar: player.avatar,
      spectator: false,
      score: player.score,
    })),
    ...spectators.map((spectator) => ({
      id: spectator.id,
      profileId: spectator.profileId,
      name: spectator.name,
      avatar: spectator.avatar,
      spectator: true,
      score: 0,
    })),
  ];

  const run = async (action: () => Promise<string | null>, success: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const message = await action();
    setBusy(false);
    if (message) setError(message);
    else setNotice(success);
  };

  const sendReport = async () => {
    if (!reportTarget) return;
    const target = reportTarget;
    await run(async () => {
      const message = await onReport(target.id, reason.trim());
      if (!message) {
        setReportTarget(null);
        setReason("");
      }
      return message;
    }, "Report sent to the host. Thanks for keeping the room safe.");
  };

  return (
    <BrutalSheet
      visible={visible}
      onClose={onClose}
      title="Players"
      footer={<BrutalButton label="DONE" color={colors.surface} onPress={onClose} />}
    >
      {seats.map((seat) => {
        const isMe = seat.id === meId;
        const isHostSeat = seat.id === room.hostId;
        const muted = mutedList.includes(seat.profileId);
        return (
          <View key={seat.id} style={styles.seat}>
            <AvatarTile value={seat.avatar} size={40} hasCrown={isHostSeat} />
            <View style={styles.seatCopy}>
              <Text style={styles.name} numberOfLines={1}>
                {seat.name}
                {isMe ? " (you)" : ""}
              </Text>
              <View style={styles.badges}>
                {isHostSeat ? <BrutalPill label="Host" color={colors.yellow} /> : null}
                {seat.spectator ? <BrutalPill label="Spectator" color={colors.cyan} /> : null}
                {muted ? <BrutalPill label="Muted" color={colors.pink} /> : null}
                <Text style={styles.meta}>
                  {seat.spectator ? "watching" : `${seat.score} pts`}
                  {seat.id === room.drawerId ? " · drawing" : ""}
                </Text>
              </View>
              {!isMe ? (
                <View style={styles.buttons}>
                  {isHost ? (
                    <>
                      <SmallAction
                        label={muted ? "UNMUTE" : "MUTE"}
                        icon={muted ? "mute" : "mute"}
                        disabled={busy}
                        onPress={() =>
                          run(
                            () => onMute(seat.id, !muted),
                            muted ? "Player unmuted." : "Player muted.",
                          )
                        }
                        accessibilityLabel={muted ? `Unmute ${seat.name}` : `Mute ${seat.name}`}
                      />
                      <SmallAction
                        label="KICK"
                        icon="close"
                        disabled={busy}
                        onPress={() => run(() => onKick(seat.id, false), "Player removed.")}
                        accessibilityLabel={`Kick ${seat.name}`}
                      />
                      <SmallAction
                        label="BAN"
                        icon="lock"
                        danger
                        disabled={busy}
                        onPress={() => run(() => onKick(seat.id, true), "Player banned from this room.")}
                        accessibilityLabel={`Ban ${seat.name}`}
                      />
                    </>
                  ) : null}
                  <SmallAction
                    label="REPORT"
                    icon="info"
                    disabled={busy}
                    onPress={() => {
                      setReportTarget(seat);
                      setReason("");
                      setError(null);
                      setNotice(null);
                    }}
                    accessibilityLabel={`Report ${seat.name}`}
                  />
                </View>
              ) : null}
            </View>
          </View>
        );
      })}

      {isHost && reportList.length > 0 ? (
        <View style={styles.reportList}>
          <Text style={styles.reportHeading}>REPORTS ({reportList.length})</Text>
          {reportList.slice(0, 5).map((report) => (
            <Text key={report.id} style={styles.reportLine}>
              {report.targetName}: {report.reason}
            </Text>
          ))}
        </View>
      ) : null}

      {reportTarget ? (
        <View style={styles.reportBox}>
          <Text style={styles.reportHeading}>REPORT {reportTarget.name.toUpperCase()}</Text>
          <BrutalInput
            value={reason}
            onChangeText={setReason}
            placeholder="What happened? (5–200 characters)"
            maxLength={200}
            multiline
            accessibilityLabel="Report reason"
            style={styles.reasonInput}
          />
          <View style={styles.reportActions}>
            <BrutalButton
              label="CANCEL"
              color={colors.surface}
              compact
              onPress={() => setReportTarget(null)}
              style={styles.reportButton}
            />
            <BrutalButton
              label="SEND"
              compact
              onPress={() => void sendReport()}
              disabled={busy || reason.trim().length < 5}
              style={styles.reportButton}
            />
          </View>
        </View>
      ) : null}

      {error ? <Text style={styles.error}>{error}</Text> : null}
      {notice ? <Text style={styles.notice}>{notice}</Text> : null}
      <Text style={styles.footnote}>
        Reports go to the host. Kicks and bans remove the player from this room.
      </Text>
    </BrutalSheet>
  );
}

function SmallAction({
  label,
  icon,
  onPress,
  disabled,
  accessibilityLabel,
  danger = false,
}: {
  label: string;
  icon: "mute" | "close" | "lock" | "info";
  onPress: () => void;
  disabled: boolean;
  accessibilityLabel: string;
  danger?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.smallButton,
        danger && styles.dangerButton,
        disabled && styles.disabled,
        pressed && styles.pressed,
      ]}
    >
      <Icon name={icon} size={12} />
      <Text style={styles.smallText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  seat: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    borderWidth: BORDER_WIDTH,
    borderColor: colors.ink,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
    padding: 10,
  },
  seatCopy: { flex: 1, gap: 4 },
  name: { fontSize: 13, fontWeight: "900", color: colors.ink },
  badges: { flexDirection: "row", alignItems: "center", gap: 5, flexWrap: "wrap" },
  meta: { fontSize: 9.5, fontWeight: "600", color: "#555" },
  buttons: { flexDirection: "row", flexWrap: "wrap", gap: 5, marginTop: 2 },
  smallButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    borderWidth: 2,
    borderColor: colors.ink,
    borderRadius: 6,
    backgroundColor: colors.bg,
    paddingHorizontal: 6,
    paddingVertical: 4,
  },
  dangerButton: { backgroundColor: colors.pink },
  smallText: { fontSize: 8.5, fontWeight: "900", letterSpacing: 0.5, color: colors.ink },
  disabled: { opacity: 0.45 },
  pressed: { transform: [{ translateX: 1 }, { translateY: 1 }] },
  reportList: {
    borderWidth: 2,
    borderColor: colors.ink,
    borderRadius: radii.sm,
    backgroundColor: colors.amber,
    padding: 9,
    gap: 3,
  },
  reportHeading: { ...type.label, fontSize: 9, letterSpacing: 1 },
  reportLine: { fontSize: 10.5, fontWeight: "600", color: colors.ink, lineHeight: 15 },
  reportBox: {
    borderWidth: BORDER_WIDTH,
    borderColor: colors.ink,
    borderRadius: radii.md,
    backgroundColor: colors.cyan,
    padding: 10,
    gap: 8,
  },
  reasonInput: { minHeight: 68, textAlignVertical: "top", fontSize: 12 },
  reportActions: { flexDirection: "row", gap: 8 },
  reportButton: { flex: 1 },
  error: {
    borderWidth: 2,
    borderColor: colors.ink,
    borderRadius: 8,
    backgroundColor: colors.pink,
    color: colors.ink,
    padding: 8,
    fontSize: 11,
    fontWeight: "800",
  },
  notice: {
    borderWidth: 2,
    borderColor: colors.ink,
    borderRadius: 8,
    backgroundColor: colors.green,
    color: colors.ink,
    padding: 8,
    fontSize: 11,
    fontWeight: "800",
  },
  footnote: { ...type.tiny, fontSize: 9, lineHeight: 13 },
});
