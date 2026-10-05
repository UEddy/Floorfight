import "./src/polyfills";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView, StyleSheet } from "react-native";
import { GameWebView } from "./src/GameWebView";

/**
 * The whole app: a status bar that stays out of the way and the game.
 *
 * Everything else lives in src. The native side exists to hold a wallet and a
 * WebView, and the less of it there is, the smaller the part of this that can
 * be wrong in a way that costs somebody SOL.
 */
export default function App() {
  return (
    <SafeAreaView style={styles.fill}>
      <StatusBar hidden />
      <GameWebView />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: "#1a1c20" },
});
