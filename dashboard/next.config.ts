import type { NextConfig } from "next";

// PWA (Phase 1): manifest + install-hint + middleware allowlist are live. The
// service worker is a FAST-FOLLOW — @serwist/next is incompatible with Next 16 +
// Turbopack (webpack-plugin only), so the SW will be hand-rolled (Turbopack-safe,
// no build plugin) and registered via a client component. next.config stays clean.

// Next.js 15.2+ blocks non-localhost origins from /_next/* dev-internal
// resources by default. When the dashboard is accessed over Tailscale, a LAN
// IP, or a reverse proxy, the browser receives the SSR HTML but the client
// bundle cannot finish hydrating because dev-resource requests are rejected —
// useEffect never fires, the CSRF token is never fetched, and the login form
// is stuck.
//
// Set DASHBOARD_ALLOWED_DEV_ORIGINS to a comma-separated list of hostnames or
// IPs to whitelist (e.g. "100.64.95.40,mybox.local,dashboard.example.com").
// Localhost is always allowed. Only reads in development; production builds
// ignore the setting.
// Hardcode the known phone-access origins (LAN + stable Tailscale IP) so dev
// resources load over them — env loading is unreliable at next.config eval time,
// which left the login form unable to hydrate from a non-localhost origin
// ("Load failed" on sign-in). The Tailscale IP is stable; the LAN IP can change
// with DHCP (update here if it does). Merge any env-provided origins too.
const allowedDevOrigins = [
  '192.168.1.219', // Mac Mini LAN IP (same-wifi)
  '100.110.195.26', // Mac Mini Tailscale IP (anywhere)
  ...(process.env.DASHBOARD_ALLOWED_DEV_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
];

const nextConfig: NextConfig = {
  serverExternalPackages: ['better-sqlite3'],
  // Scope Turbopack to THIS app. A package-lock.json at the cortextos/ monorepo
  // root makes Turbopack infer the workspace root as the whole tree and traverse
  // up into orgs/.../state/security/vet-venv (root-owned 0500 from the vet-scanner
  // installs) → `next build` dies with "Permission denied (os error 13)". Pinning
  // the root to the dashboard dir keeps file-tracing inside the app. Runtime
  // fs reads to absolute paths (command-center.ts) are unaffected.
  turbopack: { root: import.meta.dirname },
  ...(allowedDevOrigins.length > 0 && { allowedDevOrigins }),
  async headers() {
    return [
      {
        // Prevent aggressive caching of API routes and pages through the tunnel
        source: '/((?!_next/static).*)',
        headers: [
          { key: 'Cache-Control', value: 'no-store, must-revalidate' },
        ],
      },
    ];
  },
};

export default nextConfig;
