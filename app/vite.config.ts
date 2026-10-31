import preact from "@preact/preset-vite";
import { gnosis, gnosisChiado } from "viem/chains";
import { defineConfig, loadEnv } from "vite";
import { VitePWA } from "vite-plugin-pwa";

/** The origins the built app may connect to: the community server and the chain RPC. */
function connectOrigins(mode: string): string {
  const env = loadEnv(mode, process.cwd());
  const chain = Number(env.VITE_CHAIN_ID ?? 10200) === 100 ? gnosis : gnosisChiado;
  const urls = [env.VITE_SERVER_URL ?? "http://localhost:8787", env.VITE_RPC_URL || chain.rpcUrls.default.http[0]];
  return urls.map((u) => new URL(u).origin).join(" ");
}

export default defineConfig(({ mode }) => ({
  // fs: the app reads ../deployments. allowedHosts: phones reach the dev server through
  // `tailscale serve` (https, so passkeys work) at <machine>.<tailnet>.ts.net.
  server: { fs: { allow: [".."] }, allowedHosts: [".ts.net"] },
  plugins: [
    // The dev server injects CSS and the HMR preamble inline, which the production CSP in
    // index.html blocks. Relax it for `vite` only; builds keep the strict policy.
    {
      name: "dev-csp",
      apply: "serve",
      transformIndexHtml: (html) =>
        html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'").replace("style-src 'self'", "style-src 'self' 'unsafe-inline'"),
    },
    // Builds may only talk to the configured server and RPC (app/.env.production).
    {
      name: "build-csp",
      apply: "build",
      transformIndexHtml: (html) =>
        html.replace("connect-src 'self' https: http://localhost:*", `connect-src 'self' ${connectOrigins(mode)}`),
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
}));
