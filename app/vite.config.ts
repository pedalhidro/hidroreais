import preact from "@preact/preset-vite";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  server: { fs: { allow: [".."] } }, // the app reads ../deployments
  plugins: [
    // The dev server injects CSS and the HMR preamble inline, which the production CSP in
    // index.html blocks. Relax it for `vite` only; builds keep the strict policy.
    {
      name: "dev-csp",
      apply: "serve",
      transformIndexHtml: (html) =>
        html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'").replace("style-src 'self'", "style-src 'self' 'unsafe-inline'"),
    },
    preact(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      registerType: "autoUpdate",
      injectRegister: false,
      devOptions: { enabled: true, type: "module" },
      injectManifest: { globPatterns: ["**/*.{js,css,html,svg,png,woff2}"], maximumFileSizeToCacheInBytes: 4_000_000 },
      manifest: {
        name: "Hidroreais",
        short_name: "Hidroreais",
        description: "Pague e receba dos amigos pelo celular, sem taxas.",
        lang: "pt-BR",
        start_url: "/",
        display: "standalone",
        background_color: "#f6f8fc",
        theme_color: "#2343a8",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
    }),
  ],
});
