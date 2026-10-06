import type { ExpoConfig } from "expo/config";
import { withAndroidManifest, type ConfigPlugin } from "expo/config-plugins";

/**
 * Landscape, either way round.
 *
 * `orientation: "landscape"` becomes android:screenOrientation="landscape",
 * which is one fixed direction: a player holding the phone the other way up
 * sees the game upside down until they turn it. sensorLandscape is still
 * only landscape, never portrait, but follows the phone between the two.
 */
const withSensorLandscape: ConfigPlugin = (c) =>
  withAndroidManifest(c, (mod) => {
    const app = mod.modResults.manifest.application?.[0];
    for (const activity of app?.activity ?? []) {
      if (activity.$["android:name"] === ".MainActivity") {
        activity.$["android:screenOrientation"] = "sensorLandscape";
      }
    }
    return mod;
  });

/**
 * Expo config.
 *
 * Android only, on purpose: Mobile Wallet Adapter is an Android protocol and
 * there is no iOS story for it. A build that pretended otherwise would fail
 * at the first wallet call.
 *
 * `eas init` writes the project id into extra.eas.projectId. It is not here
 * because it does not exist until an Expo account has created the project.
 */
const base: ExpoConfig = {
  name: "Floorfight",
  slug: "floorfight",
  version: "0.1.0",
  orientation: "landscape",
  platforms: ["android"],
  userInterfaceStyle: "dark",
  backgroundColor: "#1a1c20",
  // The game draws its own HUD edge to edge, so the shell stays out of the
  // way entirely.
  androidStatusBar: { hidden: true, translucent: true },
  // The navigation bar is left alone. Hiding it takes expo-navigation-bar at
  // runtime rather than a config key, and a game that eats the back gesture
  // without asking is worse than one with a nav bar.
  android: {
    package: "org.floorfight.app",
    versionCode: 1,
    // No INTERNET permission line is needed: Expo adds it. Nothing else is
    // asked for, which is worth keeping true. The game needs the network and
    // a wallet app, and no camera, location, storage or contacts.
    permissions: [],
  },
  plugins: [
    // A development build rather than Expo Go, because MWA is native code.
    "expo-dev-client",
  ],
  experiments: {
    typedRoutes: false,
  },
};

export default withSensorLandscape(base);
