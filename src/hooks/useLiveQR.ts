import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import type { LiveQRPayload } from '../types/lasu';
import { apiFetch } from '../lib/api';

export interface LiveQRState {
  payload: LiveQRPayload | null;
  qrDataUrl: string;
  checkInUrl: string;
  secondsRemaining: number;
  wsConnected: boolean;
  error: string | null;
}

function buildWebSocketUrl(sessionId: string): string {
  const configuredBase = (import.meta.env.VITE_WS_URL as string | undefined)?.trim();
  if (configuredBase) {
    const cleanBase = configuredBase.replace(/\/+$/, '');
    const wsBase = cleanBase.startsWith('https://')
      ? cleanBase.replace(/^https:\/\//, 'wss://')
      : cleanBase.startsWith('http://')
        ? cleanBase.replace(/^http:\/\//, 'ws://')
        : cleanBase;
    return `${wsBase}/ws?sessionId=${encodeURIComponent(sessionId)}`;
  }
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws?sessionId=${encodeURIComponent(sessionId)}`;
}

export function useLiveQR(sessionId: string | null, enabled = true): LiveQRState {
  const [payload, setPayload] = useState<LiveQRPayload | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [secondsRemaining, setSecondsRemaining] = useState(0);
  const [wsConnected, setWsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clockOffsetRef = useRef(0);

  useEffect(() => {
    if (!sessionId || !enabled) return;
    let active = true;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempt = 0;
    let hasConnectedOnce = false;

    const applyPayload = (next: LiveQRPayload) => {
      if (!active) return;
      clockOffsetRef.current = next.serverTime - Date.now();
      setPayload(next);
      setError(null);
    };

    const fetchLatestPayload = async () => {
      try {
        const res = await apiFetch<LiveQRPayload>(`/api/sessions/${sessionId}/qr`);
        applyPayload(res);
      } catch (err) {
        if (active) {
          setError(err instanceof Error ? err.message : 'Could not load QR session.');
        }
      }
    };

    fetchLatestPayload();

    const connectWs = () => {
      if (!active) return;
      const url = buildWebSocketUrl(sessionId);
      try {
        ws = new WebSocket(url);
      } catch {
        reconnectAttempt += 1;
        const delayMs = Math.min(10000, 1000 * 2 ** Math.min(reconnectAttempt, 4));
        reconnectTimer = setTimeout(connectWs, delayMs);
        return;
      }

      ws.onopen = () => {
        if (!active) return;
        const isReconnect = hasConnectedOnce;
        hasConnectedOnce = true;
        reconnectAttempt = 0;
        setWsConnected(true);
        try {
          ws?.send(JSON.stringify({ type: 'subscribe', sessionId }));
        } catch {
          // ignore send errors on immediate close
        }
        if (isReconnect) {
          void fetchLatestPayload();
        }
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as {
            type: string;
            payload?: LiveQRPayload;
            presentCount?: number;
            lateCount?: number;
            verifiedCount?: number;
            totalEnrolled?: number;
          };
          if ((msg.type === 'qr:sync' || msg.type === 'qr:rotated') && msg.payload) {
            applyPayload(msg.payload);
          } else if (msg.type === 'attendance:checkin' || msg.type === 'attendance:corrected') {
            setPayload((prev) =>
              prev
                ? {
                    ...prev,
                    checkedInCount: (msg.presentCount ?? 0) + (msg.lateCount ?? 0),
                    verifiedCount: msg.verifiedCount ?? prev.verifiedCount,
                  }
                : prev
            );
          } else if (msg.type === 'attendance:verified') {
            setPayload((prev) =>
              prev ? { ...prev, verifiedCount: msg.verifiedCount ?? prev.verifiedCount } : prev
            );
          } else if (msg.type === 'session:closed') {
            setPayload((prev) => (prev ? { ...prev, status: 'completed' } : prev));
          }
        } catch {
          // ignore malformed messages
        }
      };

      ws.onclose = () => {
        if (!active) return;
        setWsConnected(false);
        reconnectAttempt += 1;
        const delayMs = Math.min(10000, 1000 * 2 ** Math.min(reconnectAttempt, 4));
        reconnectTimer = setTimeout(connectWs, delayMs);
      };
    };

    connectWs();

    return () => {
      active = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) ws.close();
    };
  }, [sessionId, enabled]);

  const checkInUrl =
    payload && payload.token
      ? `${window.location.origin}/checkin?s=${encodeURIComponent(payload.sessionId)}&t=${encodeURIComponent(
          payload.token
        )}&mode=${payload.mode}`
      : '';

  useEffect(() => {
    if (!checkInUrl) {
      setQrDataUrl('');
      return;
    }
    QRCode.toDataURL(checkInUrl, {
      width: 440,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: {
        dark: '#0D1828',
        light: '#FFFFFF',
      },
    })
      .then((url) => setQrDataUrl(url))
      .catch(() => {});
  }, [checkInUrl]);

  useEffect(() => {
    if (!payload || payload.status !== 'live') {
      setSecondsRemaining(0);
      return;
    }
    const updateTick = () => {
      const serverNow = Date.now() + clockOffsetRef.current;
      const rem = Math.max(0, Math.ceil((payload.expiresAt - serverNow) / 1000));
      setSecondsRemaining(rem);
    };
    updateTick();
    const id = setInterval(updateTick, 500);
    return () => clearInterval(id);
  }, [payload]);

  return {
    payload,
    qrDataUrl,
    checkInUrl,
    secondsRemaining,
    wsConnected,
    error,
  };
}
