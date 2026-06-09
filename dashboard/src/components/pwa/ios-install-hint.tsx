"use client";

import { useEffect, useState } from "react";

// iOS PWA install hint (Phase 1). iOS Safari has NO beforeinstallprompt event —
// the only way to install is the manual Share → "Add to Home Screen" flow. So on
// iOS Safari (not already installed/standalone) we show a one-time dismissible hint.
// On Android/desktop Chrome the native install prompt handles it, so this stays hidden.
//
// ADDITIVE: a self-contained client component. Renders nothing unless the exact
// "iOS Safari, not installed, not previously dismissed" condition holds.

const DISMISS_KEY = "pwa-ios-hint-dismissed";

function isIosSafari(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  const isIos = /iphone|ipad|ipod/i.test(ua);
  // exclude in-app browsers (FB/Instagram/Chrome-iOS) where Add-to-Home differs
  const isSafari = /safari/i.test(ua) && !/crios|fxios|edgios/i.test(ua);
  return isIos && isSafari;
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  // iOS exposes navigator.standalone; others use the display-mode media query
  return (
    (window.navigator as unknown as { standalone?: boolean }).standalone === true ||
    window.matchMedia?.("(display-mode: standalone)").matches === true
  );
}

export function IosInstallHint() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!isIosSafari() || isStandalone()) return;
    try {
      if (localStorage.getItem(DISMISS_KEY) === "1") return;
    } catch {
      /* localStorage blocked — just show the hint */
    }
    setShow(true);
  }, []);

  if (!show) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* ignore */
    }
    setShow(false);
  };

  return (
    <div
      role="dialog"
      aria-label="Install cortextOS"
      className="fixed inset-x-3 bottom-3 z-50 mx-auto max-w-md rounded-xl border border-primary/20 bg-background/95 px-4 py-3 shadow-lg backdrop-blur md:hidden"
    >
      <div className="flex items-start gap-3">
        <span className="text-lg leading-none" aria-hidden>⬡</span>
        <div className="flex-1 text-xs leading-relaxed text-foreground">
          Install cortextOS: tap the Share icon{" "}
          <span aria-hidden>􀈂</span> then{" "}
          <span className="font-semibold">Add to Home Screen</span>.
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss install hint"
          className="rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
