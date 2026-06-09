"use client";

import { useEffect } from "react";

// Service-worker registration (PWA Phase 1). Registers the hand-rolled, static
// /sw.js (served from /public, Turbopack-safe — no build plugin). Guarded for
// SW support so non-PWA browsers no-op. Renders nothing.
//
// ADDITIVE: a self-contained client component. The SW itself never caches authed
// /api or SSE traffic (see public/sw.js), so this changes no desktop behavior
// beyond enabling offline app-shell + standalone install.

export function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    // Register after load so it never competes with first-paint resources.
    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch((err) => {
        // Non-fatal: the app works fine without the SW; just log for diagnostics.
        console.warn("[pwa] service worker registration failed:", err);
      });
    };
    if (document.readyState === "complete") {
      register();
    } else {
      window.addEventListener("load", register, { once: true });
      return () => window.removeEventListener("load", register);
    }
  }, []);

  return null;
}
