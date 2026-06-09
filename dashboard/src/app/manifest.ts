import type { MetadataRoute } from "next";

// PWA manifest (Phase 1). Next.js serves this at /manifest.webmanifest.
// ADDITIVE: a new metadata route — does not touch any existing page/API route.
// theme/background match the dashboard's deep-void dark theme (#0A0E17) + gold
// accent (#B8860B) from icon.svg. display:standalone makes the installed app
// run chromeless (no browser UI) on mobile home screens.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Jarvis Check-in",
    short_name: "Jarvis",
    description: "Jarvis mobile check-in — predictions, options, decisions, system",
    // Home-screen app opens straight to the mobile check-in (B's primary mobile view),
    // not the desktop dashboard. scope stays "/" so navigation to other pages still
    // works inside the installed app.
    start_url: "/mobile",
    scope: "/",
    display: "standalone",
    orientation: "portrait-primary",
    background_color: "#0A0E17",
    theme_color: "#0A0E17",
    icons: [
      // Scalable SVG (existing asset) — covers all sizes for modern installers.
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      // Maskable + PNG fallbacks are added in a later pass once raster icons exist;
      // SVG-any is sufficient for install on iOS/Android Chrome.
    ],
  };
}
