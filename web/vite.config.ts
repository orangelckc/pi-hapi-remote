import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["manifest.webmanifest", "icons/*.png"],
      manifest: false,
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,woff2,webmanifest}"],
        navigateFallback: "index.html",
        // 不配置 runtimeCaching：Snapshot/Events/Commands/Control 请求
        // 为跨域直连，Service Worker 不拦截、不缓存。
        runtimeCaching: [],
        navigateFallbackDenylist: [/^\/v1\//],
      },
    }),
  ],
  build: {
    outDir: "dist",
  },
  server: {
    port: 5173,
  },
});
