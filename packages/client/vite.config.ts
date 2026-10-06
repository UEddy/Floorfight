import { defineConfig } from "vite";

export default defineConfig({
  server: {
    // Listen on all interfaces so the Windows browser and phones on the LAN
    // can reach the dev server running inside WSL.
    host: true,
    port: 5173,
    // sim.ts and protocol.ts live in packages/shared, outside this package.
    // They are imported directly, not copied, so prediction runs the exact
    // code the server runs.
    fs: { allow: [".."] },
    // The repo lives on the Windows drive mounted into WSL, which delivers no
    // file change events. Without polling, edits are silently not picked up.
    watch: { usePolling: true, interval: 300 },
    // The page fetches /api from its own origin, as it does in production
    // where Caddy routes it. In dev the game server is on another port.
    proxy: {
      "/api": process.env.FLOORFIGHT_API ?? "http://127.0.0.1:8080",
    },
  },
});
