import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import type { WebViewNavigation } from "react-native-webview/lib/WebViewTypes";
import { GAME_ORIGIN, GAME_URL } from "./config";
import {
  Refused,
  buildJoinMessage,
  fromGameOrigin,
  parseRequest,
  replyScript,
  type Reply,
  type Request,
} from "./bridge";
import { plan, transactionFor, type Planned } from "./escrow";
import { currentWallet, signAndSend, signMessage } from "./wallet";
import { Confirm } from "./Confirm";

/**
 * The game, in a WebView, with the shutters down.
 *
 * The page is remote content served over the internet. It gets no file
 * access, no other origins, no new windows and no way to navigate off the
 * origin this build was compiled against. Every message it posts is checked
 * for where it came from before it is even parsed.
 */
export function GameWebView() {
  const ref = useRef<WebView>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /** An escrow action waiting for the person to approve it. */
  const [pending, setPending] = useState<{ planned: Planned; id: string } | null>(null);

  const reply = useCallback((r: Reply) => {
    ref.current?.injectJavaScript(replyScript(r));
  }, []);

  const fail = useCallback((id: string, e: unknown) => {
    const error = e instanceof Error ? e.message : "something went wrong";
    reply({ id, ok: false, error });
  }, [reply]);

  /**
   * One request from the page.
   *
   * Parsed strictly, then handled. There are two branches and no default: an
   * unknown request never reaches here because parseRequest refuses it.
   */
  const handle = useCallback(async (req: Request) => {
    if (req.t === "signJoin") {
      // The message is built here, from validated parts, and checked against
      // the template again before it goes near the wallet.
      const message = buildJoinMessage(req);
      const { wallet, signature } = await signMessage(message);
      reply({ id: req.id, ok: true, t: "signJoin", wallet, signature });
      return;
    }

    // escrow: work out what the action is worth before anything is signed,
    // then put it in front of the person. The wallet opens only if they say
    // yes, in onApprove below.
    const now = Math.floor(Date.now() / 1000);
    const planned = await plan(req.action, BigInt(req.matchId), now);
    setPending({ planned, id: req.id });
  }, [reply]);

  const onMessage = useCallback((event: WebViewMessageEvent) => {
    const { data, url } = event.nativeEvent;
    // Where it came from, before what it says. A message from an iframe or
    // from a page this app did not load is not from the game.
    if (!fromGameOrigin(url, GAME_ORIGIN)) {
      console.warn(`[bridge] ignoring a message from ${url}`);
      return;
    }
    let req: Request;
    try {
      req = parseRequest(data);
    } catch (e) {
      // Refused requests are logged and dropped. There is no id to reply to
      // when the id itself was the malformed part.
      console.warn(`[bridge] refused: ${e instanceof Refused ? e.message : String(e)}`);
      return;
    }
    void handle(req).catch((e) => fail(req.id, e));
  }, [handle, fail]);

  const onApprove = useCallback(() => {
    const p = pending;
    if (!p) return;
    setPending(null);
    void signAndSend((player) => transactionFor(p.planned, player))
      .then((signature) => {
        reply({
          id: p.id, ok: true, t: "escrow", action: p.planned.action, signature,
        });
      })
      .catch((e) => fail(p.id, e));
  }, [pending, reply, fail]);

  const onCancel = useCallback(() => {
    const p = pending;
    setPending(null);
    if (p) reply({ id: p.id, ok: false, error: "cancelled" });
  }, [pending, reply]);

  /**
   * Navigation lock.
   *
   * The only thing this WebView is allowed to load is the game. A link, a
   * redirect or a script that tries to go anywhere else is refused, so a
   * compromised page cannot replace itself with something that then asks for
   * signatures from a different origin.
   */
  const allow = useCallback((nav: WebViewNavigation) => {
    if (fromGameOrigin(nav.url, GAME_ORIGIN) || nav.url === "about:blank") return true;
    console.warn(`[webview] blocked navigation to ${nav.url}`);
    return false;
  }, []);

  if (failed) {
    return (
      <View style={styles.center}>
        <Text style={styles.title}>Cannot reach the hall</Text>
        <Text style={styles.body}>{failed}</Text>
        <Text style={styles.body}>{GAME_URL}</Text>
      </View>
    );
  }

  return (
    <View style={styles.fill}>
      <WebView
        ref={ref}
        source={{ uri: GAME_URL }}
        originWhitelist={[GAME_ORIGIN]}
        onShouldStartLoadWithRequest={allow}
        onMessage={onMessage}
        onLoadEnd={() => setLoading(false)}
        onError={({ nativeEvent }) => setFailed(nativeEvent.description ?? "load failed")}
        onHttpError={({ nativeEvent }) => setFailed(`HTTP ${nativeEvent.statusCode}`)}
        // A game, so: keep the GPU path, keep it quiet, and let it have the
        // whole screen.
        style={styles.fill}
        containerStyle={styles.fill}
        androidLayerType="hardware"
        overScrollMode="never"
        bounces={false}
        scrollEnabled={false}
        showsVerticalScrollIndicator={false}
        // Locked down. None of these are needed to run the game, and each one
        // is a way for a page to reach somewhere it should not.
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        allowsBackForwardNavigationGestures={false}
        javaScriptCanOpenWindowsAutomatically={false}
        setSupportMultipleWindows={false}
        mixedContentMode="never"
        thirdPartyCookiesEnabled={false}
        geolocationEnabled={false}
        mediaPlaybackRequiresUserAction={false}
        // The game is landscape and full bleed; no zoom, no text inflation.
        scalesPageToFit={false}
        textZoom={100}
      />
      {loading ? (
        <View style={styles.loading}>
          <ActivityIndicator color="#ffc426" size="large" />
          <Text style={styles.body}>Loading the hall</Text>
        </View>
      ) : null}
      <Confirm
        planned={pending?.planned ?? null}
        wallet={currentWallet()}
        onCancel={onCancel}
        onApprove={onApprove}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: "#1a1c20" },
  center: {
    flex: 1,
    backgroundColor: "#1a1c20",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    gap: 8,
  },
  loading: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "#1a1c20",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  title: { color: "#f4f1ea", fontSize: 20, fontWeight: "700" },
  body: { color: "rgba(244, 241, 234, 0.7)", fontSize: 13, textAlign: "center" },
});
