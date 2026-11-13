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

    const applyPayload = (next: LiveQRPayload) => {
      if (!active) return;
      clockOffsetRef.current = next.serverTime - Date.now();
      setPayload(next);
      setError(null);
    };

    const fetchInitial = async () => {
      try {
        const res = await apiFetch<LiveQRPayload>(`/api/sessions/${sessionId}/qr`);
        applyPayload(res);
      } catch (err) {
        if (active) {
          setError(err instanceof Error ? err.message : 'Could not load QR session.');
        }
      }
    };

    fetchInitial();

    const connectWs = () => {
      if (!active) return;
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${proto}//${window.location.host}/ws?sessionId=${encodeURIComponent(sessionId)}`;
      ws = new WebSocket(url);

      ws.onopen = () => {
        if (active) setWsConnected(true);
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
          } else if (msg.type === 'attendance:checkin') {
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
        reconnectTimer = setTimeout(connectWs, 2500);
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
