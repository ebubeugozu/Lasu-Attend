import crypto from 'node:crypto';
import type { WebSocket } from 'ws';
import type { LiveQRPayload } from '../types/lasu.ts';
import { db, type QRSecretDoc, type QRTokenSlotDoc } from './db.ts';

export const ROTATION_INTERVAL_SECONDS = 90;
export const GRACE_PERIOD_SECONDS = 15;

interface SessionQRState {
  sessionId: string;
  checkin: QRTokenSlotDoc;
  verify?: QRTokenSlotDoc;
}

const CHARS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

function generateShortCode(prefix: string): string {
  const bytes = crypto.randomBytes(6);
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += CHARS[bytes[i] % CHARS.length];
  }
  return `${prefix}-${code.slice(0, 3)}${code.slice(3, 6)}`;
}

function generateCryptoToken(): string {
  return crypto.randomBytes(18).toString('base64url');
}

function createSlotState(prefix: string, rotationSeconds: number): QRTokenSlotDoc {
  const now = Date.now();
  return {
    currentToken: generateCryptoToken(),
    currentShortCode: generateShortCode(prefix),
    issuedAt: now,
    expiresAt: now + rotationSeconds * 1000,
  };
}

function rotateSlotState(
  slot: QRTokenSlotDoc,
  prefix: string,
  rotationSeconds: number,
  graceSeconds: number
): QRTokenSlotDoc {
  const now = Date.now();
  return {
    currentToken: generateCryptoToken(),
    currentShortCode: generateShortCode(prefix),
    issuedAt: now,
    expiresAt: now + rotationSeconds * 1000,
    previousToken: slot.currentToken,
    previousShortCode: slot.currentShortCode,
    previousGraceUntil: now + graceSeconds * 1000,
  };
}

class QREngine {
  private sessions = new Map<string, SessionQRState>();
  private subscribers = new Map<string, Set<WebSocket>>();
  private timer: ReturnType<typeof setInterval> | null = null;

  public hydrateFromDb() {
    for (const [sessionId, doc] of db.qrSecrets.entries()) {
      const ses = db.state.sessions.find((s) => s.id === sessionId);
      if (ses && ses.status === 'live') {
        this.sessions.set(sessionId, {
          sessionId: doc.sessionId,
          checkin: doc.checkin,
          verify: doc.verify,
        });
      }
    }
  }

  private persistSecret(state: SessionQRState) {
    const doc: QRSecretDoc = {
      sessionId: state.sessionId,
      checkin: state.checkin,
      verify: state.verify,
      updatedAt: new Date().toISOString(),
    };
    db.saveQrSecret(doc).catch((err) => {
      console.error('Failed to persist QR token secret:', err);
    });
  }

  public startTicker() {
    if (this.timer) return;
    this.hydrateFromDb();
    this.timer = setInterval(() => {
      const now = Date.now();
      for (const [sessionId, state] of this.sessions.entries()) {
        const session = db.state.sessions.find((s) => s.id === sessionId);
        if (!session || session.status !== 'live') {
          this.sessions.delete(sessionId);
          db.deleteQrSecret(sessionId).catch(() => {});
          continue;
        }

        const rotationSec = session.rotationIntervalSeconds || ROTATION_INTERVAL_SECONDS;
        const graceSec = session.gracePeriodSeconds || GRACE_PERIOD_SECONDS;
        let rotated = false;

        if (now >= state.checkin.expiresAt) {
          state.checkin = rotateSlotState(state.checkin, 'LASU', rotationSec, graceSec);
          rotated = true;
        }

        if (session.checkpointActive && state.verify && now >= state.verify.expiresAt) {
          state.verify = rotateSlotState(state.verify, 'VER', rotationSec, graceSec);
          rotated = true;
        }

        if (rotated) {
          this.persistSecret(state);
          this.broadcast(sessionId, {
            type: 'qr:rotated',
            payload: this.getLivePayload(sessionId),
          });
        }
      }
    }, 1000);
  }

  public initSession(sessionId: string, rotationSeconds = ROTATION_INTERVAL_SECONDS) {
    const state: SessionQRState = {
      sessionId,
      checkin: createSlotState('LASU', rotationSeconds),
    };
    this.sessions.set(sessionId, state);
    this.persistSecret(state);
    this.broadcast(sessionId, {
      type: 'qr:rotated',
      payload: this.getLivePayload(sessionId),
    });
    return this.getLivePayload(sessionId);
  }

  public startCheckpoint(sessionId: string, rotationSeconds = ROTATION_INTERVAL_SECONDS) {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = {
        sessionId,
        checkin: createSlotState('LASU', rotationSeconds),
      };
      this.sessions.set(sessionId, state);
    }
    state.verify = createSlotState('VER', rotationSeconds);
    this.persistSecret(state);
    this.broadcast(sessionId, {
      type: 'qr:rotated',
      payload: this.getLivePayload(sessionId),
    });
    return this.getLivePayload(sessionId);
  }

  public stopCheckpoint(sessionId: string) {
    const state = this.sessions.get(sessionId);
    if (state) {
      delete state.verify;
      this.persistSecret(state);
      this.broadcast(sessionId, {
        type: 'qr:rotated',
        payload: this.getLivePayload(sessionId),
      });
    }
  }

  public closeSession(sessionId: string) {
    this.sessions.delete(sessionId);
    db.deleteQrSecret(sessionId).catch(() => {});
    const session = db.state.sessions.find((s) => s.id === sessionId);
    this.broadcast(sessionId, {
      type: 'session:closed',
      session,
    });
  }

  public ensureActiveState(sessionId: string): SessionQRState | null {
    const session = db.state.sessions.find((s) => s.id === sessionId);
    if (!session || session.status !== 'live') return null;
    let state = this.sessions.get(sessionId);
    if (!state) {
      const persisted = db.qrSecrets.get(sessionId);
      if (persisted) {
        state = {
          sessionId,
          checkin: persisted.checkin,
          verify: persisted.verify,
        };
      } else {
        state = {
          sessionId,
          checkin: createSlotState('LASU', session.rotationIntervalSeconds || ROTATION_INTERVAL_SECONDS),
        };
        if (session.checkpointActive) {
          state.verify = createSlotState('VER', session.rotationIntervalSeconds || ROTATION_INTERVAL_SECONDS);
        }
        this.persistSecret(state);
      }
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  public getLivePayload(sessionId: string): LiveQRPayload | null {
    const session = db.state.sessions.find((s) => s.id === sessionId);
    if (!session) return null;
    const state = this.ensureActiveState(sessionId);
    if (!state) {
      return {
        sessionId: session.id,
        courseCode: session.courseCode,
        courseTitle: session.courseTitle,
        lectureTitle: session.lectureTitle,
        venue: session.venue,
        lecturerName: session.lecturerName,
        status: session.status,
        mode: session.checkpointActive ? 'verify' : 'checkin',
        token: '',
        shortCode: '',
        issuedAt: Date.now(),
        expiresAt: Date.now(),
        graceSeconds: session.gracePeriodSeconds,
        rotationIntervalSeconds: session.rotationIntervalSeconds,
        serverTime: Date.now(),
        checkedInCount: session.presentCount + session.lateCount,
        verifiedCount: session.verifiedCount,
        totalEnrolled: session.totalEnrolled,
      };
    }

    const mode: 'checkin' | 'verify' = session.checkpointActive && state.verify ? 'verify' : 'checkin';
    const slot = mode === 'verify' && state.verify ? state.verify : state.checkin;

    return {
      sessionId: session.id,
      courseCode: session.courseCode,
      courseTitle: session.courseTitle,
      lectureTitle: session.lectureTitle,
      venue: session.venue,
      lecturerName: session.lecturerName,
      status: session.status,
      mode,
      token: slot.currentToken,
      shortCode: slot.currentShortCode,
      issuedAt: slot.issuedAt,
      expiresAt: slot.expiresAt,
      graceSeconds: session.gracePeriodSeconds,
      rotationIntervalSeconds: session.rotationIntervalSeconds,
      serverTime: Date.now(),
      checkedInCount: session.presentCount + session.lateCount,
      verifiedCount: session.verifiedCount,
      totalEnrolled: session.totalEnrolled,
    };
  }

  public validateToken(
    sessionId: string,
    tokenOrCode: string,
    mode: 'checkin' | 'verify'
  ): { valid: boolean; reason?: string; code?: string } {
    const session = db.state.sessions.find((s) => s.id === sessionId);
    if (!session) {
      return { valid: false, reason: 'Attendance session was not found.', code: 'SESSION_NOT_FOUND' };
    }
    if (session.status !== 'live') {
      return { valid: false, reason: 'This attendance session is closed.', code: 'SESSION_CLOSED' };
    }
    const state = this.ensureActiveState(sessionId);
    if (!state) {
      return { valid: false, reason: 'This attendance session is closed.', code: 'SESSION_CLOSED' };
    }

    if (mode === 'verify' && (!session.checkpointActive || !state.verify)) {
      return {
        valid: false,
        reason: 'The second attendance verification checkpoint is not currently open.',
        code: 'CHECKPOINT_CLOSED',
      };
    }

    const slot = mode === 'verify' ? state.verify! : state.checkin;
    const normalized = tokenOrCode.trim();
    const upper = normalized.toUpperCase();
    const now = Date.now();

    if (
      (normalized === slot.currentToken || upper === slot.currentShortCode) &&
      now <= slot.expiresAt + (session.gracePeriodSeconds || GRACE_PERIOD_SECONDS) * 1000
    ) {
      return { valid: true };
    }

    if (
      slot.previousToken &&
      slot.previousGraceUntil &&
      now <= slot.previousGraceUntil &&
      (normalized === slot.previousToken || upper === slot.previousShortCode)
    ) {
      return { valid: true };
    }

    return {
      valid: false,
      reason: 'This QR code has expired or is invalid. Please scan the latest code on the screen.',
      code: 'EXPIRED_QR',
    };
  }

  public findSessionByShortCode(shortCode: string): { sessionId: string; mode: 'checkin' | 'verify' } | null {
    const upper = shortCode.trim().toUpperCase();
    const now = Date.now();
    for (const [sessionId, state] of this.sessions.entries()) {
      if (
        state.checkin.currentShortCode === upper ||
        (state.checkin.previousShortCode === upper &&
          state.checkin.previousGraceUntil &&
          now <= state.checkin.previousGraceUntil)
      ) {
        return { sessionId, mode: 'checkin' };
      }
      if (
        state.verify &&
        (state.verify.currentShortCode === upper ||
          (state.verify.previousShortCode === upper &&
            state.verify.previousGraceUntil &&
            now <= state.verify.previousGraceUntil))
      ) {
        return { sessionId, mode: 'verify' };
      }
    }
    return null;
  }

  public subscribe(sessionId: string, ws: WebSocket) {
    let set = this.subscribers.get(sessionId);
    if (!set) {
      set = new Set();
      this.subscribers.set(sessionId, set);
    }
    set.add(ws);

    const payload = this.getLivePayload(sessionId);
    if (payload && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'qr:sync', payload }));
    }
  }

  public unsubscribe(ws: WebSocket) {
    for (const [sessionId, set] of this.subscribers.entries()) {
      if (set.has(ws)) {
        set.delete(ws);
        if (set.size === 0) {
          this.subscribers.delete(sessionId);
        }
      }
    }
  }

  public broadcast(sessionId: string, event: unknown) {
    const set = this.subscribers.get(sessionId);
    if (!set || set.size === 0) return;
    const msg = JSON.stringify(event);
    for (const client of set) {
      if (client.readyState === 1) {
        client.send(msg);
      }
    }
  }
}

export const qrEngine = new QREngine();
