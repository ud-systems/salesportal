import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import { VitePWA } from "vite-plugin-pwa";
import path from "path";

const UD_THEME = "#0A2342";

// https://vitejs.dev/config/
export default defineConfig({
  server: {
    host: "::",
    port: 8080,
    hmr: {
      overlay: false,
    },
  },
  // Recharts peer-depends on react-is; forcing pre-bundle avoids dev "Failed to resolve import react-is"
  // when optimizing `.vite/deps/recharts.js`.
  optimizeDeps: {
    include: ["react-is", "recharts"],
  },
  plugins: [
    react(),
    VitePWA({
      registerType: "prompt",
      injectRegister: null,
      includeAssets: ["favicon.png", "apple-touch-icon.png", "og-image.svg", "robots.txt", "pwa-192.png", "pwa-512.png"],
      manifest: {
        id: "/",
        name: "Unique Distribution CRM",
        short_name: "UD CRM",
        description:
          "Sales, inventory, orders, and team operations for Unique Distribution — install for quick access like an app.",
        theme_color: UD_THEME,
        background_color: UD_THEME,
        display: "standalone",
        display_override: ["standalone", "minimal-ui", "browser"],
        orientation: "any",
        scope: "/",
        start_url: "/",
        lang: "en",
        categories: ["business", "productivity"],
        icons: [
          {
            src: "pwa-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "pwa-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "pwa-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
        shortcuts: [
          {
            name: "Dashboard",
            short_name: "Dashboard",
            description: "Open the main dashboard",
            url: "/dashboard",
            icons: [{ src: "pwa-192.png", sizes: "192x192", type: "image/png" }],
          },
          {
            name: "Orders",
            short_name: "Orders",
            description: "View orders",
            url: "/orders",
            icons: [{ src: "pwa-192.png", sizes: "192x192", type: "image/png" }],
          },
        ],
      },
      workbox: {
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/sw\.js$/, /^\/workbox.*\.js$/],
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2}"],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/[\w-]+\.supabase\.co\/.*/i,
            handler: "NetworkOnly",
          },
          {
            urlPattern: /^https:\/\/[\w-]+\.supabase\.in\/.*/i,
            handler: "NetworkOnly",
          },
        ],
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    dedupe: ["react", "react-dom", "react-is", "react/jsx-runtime", "react/jsx-dev-runtime"],
  },
});
