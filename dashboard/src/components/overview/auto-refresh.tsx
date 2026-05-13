'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';

interface AutoRefreshProps {
  intervalMs?: number;
}

export function AutoRefresh({ intervalMs = 30000 }: AutoRefreshProps) {
  const router = useRouter();
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    timerRef.current = setInterval(async () => {
      // Trigger backend sync then refresh page data
      try {
        await fetch('/api/sync', { method: 'GET' });
      } catch {
        // Sync failure is non-fatal — still refresh
      }
      router.refresh();
    }, intervalMs);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [router, intervalMs]);

  return null;
}
