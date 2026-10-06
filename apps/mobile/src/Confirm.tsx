import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { LAMPORTS_PER_SOL } from "./config";
import type { Planned } from "./escrow";

/**
 * What the person is being asked to approve, before the wallet opens.
 *
 * Every number on this sheet was read off the chain by escrow.ts. The page
 * does not get to write any of it, which is the only reason showing it is
 * worth anything: a stake the page could choose is not a disclosure, it is a
 * suggestion.
 */
export function Confirm(props: {
  planned: Planned | null;
  wallet: string | null;
  onCancel: () => void;
  onApprove: () => void;
}) {
  const p = props.planned;
  if (!p) return null;

  const sol = (Number(p.lamports) / LAMPORTS_PER_SOL).toFixed(4);
  const title = p.action === "create"
    ? "Create a match"
    : p.action === "join"
      ? "Join this match"
      : p.action === "claim" ? "Claim your payout" : "Refund your stake";
  const line = p.direction === "pay"
    ? `You will stake ${sol} SOL`
    : `You will receive up to ${sol} SOL`;

  return (
    <Modal transparent animationType="fade" visible onRequestClose={props.onCancel}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.amount}>{line}</Text>
          <Text style={styles.detail}>{p.detail}</Text>
          <Text style={styles.meta}>Match {String(p.matchId)}</Text>
          <Text style={styles.meta}>
            {props.wallet ? `Wallet ${short(props.wallet)}` : "Your wallet will be asked next"}
          </Text>
          <Text style={styles.note}>
            Network fees are on top. Your wallet will show the transaction before
            anything is signed.
          </Text>
          <View style={styles.row}>
            <Pressable style={[styles.button, styles.cancel]} onPress={props.onCancel}>
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
            <Pressable style={[styles.button, styles.approve]} onPress={props.onApprove}>
              <Text style={styles.approveText}>
                {p.direction === "pay" ? "Open wallet" : "Continue"}
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function short(address: string): string {
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(10, 11, 13, 0.82)",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  card: {
    width: "100%",
    maxWidth: 420,
    backgroundColor: "#1f2227",
    borderRadius: 12,
    padding: 20,
  },
  title: { color: "#f4f1ea", fontSize: 20, fontWeight: "700", marginBottom: 10 },
  amount: { color: "#ffc426", fontSize: 24, fontWeight: "700", marginBottom: 6 },
  detail: { color: "#f4f1ea", fontSize: 14, marginBottom: 12 },
  meta: { color: "rgba(244, 241, 234, 0.6)", fontSize: 12, fontFamily: "monospace" },
  note: {
    color: "rgba(244, 241, 234, 0.6)",
    fontSize: 12,
    marginTop: 12,
    lineHeight: 17,
  },
  row: { flexDirection: "row", gap: 10, marginTop: 18 },
  button: { flex: 1, borderRadius: 8, paddingVertical: 12, alignItems: "center" },
  cancel: { backgroundColor: "#2b2f36" },
  approve: { backgroundColor: "#ffc426" },
  cancelText: { color: "#f4f1ea", fontSize: 15, fontWeight: "600" },
  approveText: { color: "#1a1c20", fontSize: 15, fontWeight: "700" },
});
