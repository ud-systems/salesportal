import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import path from "path";

const UD_THEME = "#0A2342";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: 8080,
    hmr: {
      overlay: false,
    },
    proxy: {
      "/api/db": {
        target: "https://xbmpndatdanjewhwxzxr.supabase.co",
        changeOrigin: true,
        secure: true,
        ws: true,
        rewrite: (path) => path.replace(/^\/api\/db/, ""),
      },
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
      includeAssets: [
        "favicon.png",
        "apple-touch-icon.png",
        "og-image.svg",
        "robots.txt",
        "pwa-192.png",
        "pwa-512.png",
        "pwa-maskable-512.png",
        "pwa-screenshot-wide.png",
        "pwa-screenshot-narrow.png",
      ],
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
            src: "pwa-maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
        screenshots: [
          {
            src: "pwa-screenshot-wide.png",
            sizes: "1280x720",
            type: "image/png",
            form_factor: "wide",
            label: "Unique Distribution CRM on desktop",
          },
          {
            src: "pwa-screenshot-narrow.png",
            sizes: "720x1280",
            type: "image/png",
            form_factor: "narrow",
            label: "Unique Distribution CRM on mobile",
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
        importScripts: ["/workbox-silent.js", "/push-sw-handler.js"],
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/sw\.js$/, /^\/workbox.*\.js$/],
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2}"],
        runtimeCaching: [
          {
            urlPattern: /^\/api\/db\/.*/i,
            handler: "NetworkOnly",
          },
        ],
      },
      // Register a dev service worker so Chrome can fire `beforeinstallprompt` on localhost.
      // Without this, `npm run dev` never looks “installable” and our in-app Install CTA stays inert.
      devOptions: {
        enabled: mode === "development",
        // dev-dist often only has sw.js + workbox-*.js (ignored from precache), so the
        // default glob matches nothing and workbox-build warns; this is the plugin-supported fix.
        suppressWarnings: true,
      },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    dedupe: ["react", "react-dom", "react-is", "react/jsx-runtime", "react/jsx-dev-runtime"],
  },
}));
