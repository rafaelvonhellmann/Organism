'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

export function usePolling<T>(
  url: string,
  intervalMs: number = 10_000,
): { data: T | null; loading: boolean; error: string | null; refresh: () => void; lastUpdated: Date | null } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const mountedRef = useRef(true);
  const requestSeqRef = useRef(0);

  const fetchData = useCallback(async () => {
    const seq = ++requestSeqRef.current;
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const json = await res.json();
      if (mountedRef.current && seq === requestSeqRef.current) {
        setData(json);
        setError(null);
        setLastUpdated(new Date());
      }
    } catch (err) {
      if (mountedRef.current && seq === requestSeqRef.current) {
        setError(err instanceof Error ? err.message : 'Fetch failed');
      }
    } finally {
      if (mountedRef.current && seq === requestSeqRef.current) setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    mountedRef.current = true;
    setLoading(true);
    setData(null);
    setError(null);
    fetchData();
    const id = setInterval(fetchData, intervalMs);
    return () => {
      mountedRef.current = false;
      clearInterval(id);
    };
  }, [fetchData, intervalMs]);

  return { data, loading, error, refresh: fetchData, lastUpdated };
}
