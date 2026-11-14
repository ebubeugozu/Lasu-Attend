import crypto from 'node:crypto';
import type { WebSocket } from 'ws';
import type { AttendanceSession, LiveQRPayload } from '../types/lasu.ts';
import { db, type QRSecretDoc, type QRTokenSlotDoc } from './db.ts';
import { pubsub } from './pubsub.ts';

export const ROTATION_INTERVAL_SECONDS = 90;
export const GRACE_PERIOD_SECONDS = 15;

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

function buildPayload(session: AttendanceSession, secret: QRSecretDoc | null): LiveQRPayload {
  if (!secret || session.status !== 'live') {
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

  const mode: 'checkin' | 'verify' = session.checkpointActive && secret.verify ? 'verify' : 'checkin';
  const slot = mode === 'verify' && secret.verify ? secret.verify : secret.checkin;

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

class QREngine {
  private subscribers = new Map<string, Set<WebSocket>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private unsubscribePubSub: (() => void) | null = null;

  constructor() {
    // Relay all session events received via Redis Pub/Sub or local bus to local WebSocket subscribers
    this.unsubscribePubSub = pubsub.onSessionEvent((sessionId, event) => {
      this.broadcastLocal(sessionId, event);
    });
  }

  private async readSecret(sessionId: string): Promise<QRSecretDoc | null> {
    const cached = await pubsub.getCache<QRSecretDoc>(`qr:${sessionId}`);
    if (cached) return cached;
    const fromDb = await db.getQrSecret(sessionId);
    if (fromDb) {
      await pubsub.setCache(`qr:${sessionId}`, fromDb, 120);
    }
    return fromDb;
  }

  private async writeCache(doc: QRSecretDoc): Promise<void> {
    await pubsub.setCache(`qr:${doc.sessionId}`, doc, 120);
  }

  public startTicker() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.ticking) return;
      this.ticking = true;
      this.tickOnce()
        .catch((err) => {
          console.error('[LASU Attend] QR rotation tick error:', err);
        })
        .finally(() => {
          this.ticking = false;
        });
    }, 1000);
  }

  public stopTicker() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public destroy() {
    this.stopTicker();
    if (this.unsubscribePubSub) {
      this.unsubscribePubSub();
      this.unsubscribePubSub = null;
    }
  }

  private async tickOnce(): Promise<void> {
    const [liveSessions, allSecrets] = await Promise.all([db.listLiveSessions(), db.listAllQrSecrets()]);
    const liveMap = new Map(liveSessions.map((s) => [s.id, s]));

    // Clean up orphaned QR secrets whose sessions are no longer live
    for (const secret of allSecrets) {
      if (!liveMap.has(secret.sessionId)) {
        await db.deleteQrSecret(secret.sessionId);
        await pubsub.delCache(`qr:${secret.sessionId}`);
      }
    }

    const secretMap = new Map(allSecrets.map((sec) => [sec.sessionId, sec]));

    for (const session of liveSessions) {
      const secret = secretMap.get(session.id) || null;
      if (!secret) {
        await this.ensureActiveState(session);
        continue;
      }
      await this.rotateIfDue(session, secret);
    }
  }

  private async rotateIfDue(session: AttendanceSession, current: QRSecretDoc): Promise<QRSecretDoc> {
    const now = Date.now();
    const needsCheckin = now >= current.checkin.expiresAt;
    const needsVerify = Boolean(session.checkpointActive && current.verify && now >= current.verify.expiresAt);
    if (!needsCheckin && !needsVerify) {
      return current;
    }

    const rotationSec = session.rotationIntervalSeconds || ROTATION_INTERVAL_SECONDS;
    const graceSec = session.gracePeriodSeconds || GRACE_PERIOD_SECONDS;

    const lockResult = await pubsub.acquireDistributedLock(`qr-rotate:${session.id}`, 5000, async () => {
      return db.mutateQrSecretAtomic(session.id, (latest) => {
        if (!latest) return null;
        const txNow = Date.now();
        let changed = false;
        const next: QRSecretDoc = {
          ...latest,
          updatedAt: new Date(txNow).toISOString(),
        };

        if (txNow >= latest.checkin.expiresAt) {
          next.checkin = rotateSlotState(latest.checkin, 'LASU', rotationSec, graceSec);
          changed = true;
        }
        if (session.checkpointActive && latest.verify && txNow >= latest.verify.expiresAt) {
          next.verify = rotateSlotState(latest.verify, 'VER', rotationSec, graceSec);
          changed = true;
        }

        return { next, changed };
      });
    });

    if (!lockResult.acquired || !lockResult.result) {
      // Another server instance held the lock and performed the rotation; read fresh state
      const fresh = await db.getQrSecret(session.id);
      if (fresh) await this.writeCache(fresh);
      return fresh || current;
    }

    const { doc, changed } = lockResult.result;
    if (doc) {
      await this.writeCache(doc);
      if (changed) {
        const payload = buildPayload(session, doc);
        await pubsub.publishSessionEvent(session.id, {
          type: 'qr:rotated',
          payload,
        });
      }
      return doc;
    }
    return current;
  }

  public async initSession(
    sessionId: string,
    rotationSeconds = ROTATION_INTERVAL_SECONDS
  ): Promise<LiveQRPayload | null> {
    const { doc } = await db.mutateQrSecretAtomic(sessionId, (existing) => {
      const next: QRSecretDoc = existing
        ? {
            ...existing,
            checkin: createSlotState('LASU', rotationSeconds),
            updatedAt: new Date().toISOString(),
          }
        : {
            sessionId,
            checkin: createSlotState('LASU', rotationSeconds),
            updatedAt: new Date().toISOString(),
          };
      return { next, changed: true };
    });

    if (doc) {
      await this.writeCache(doc);
    }

    const session = await db.getSessionById(sessionId);
    if (!session) return null;
    const payload = buildPayload(session, doc);
    await pubsub.publishSessionEvent(sessionId, {
      type: 'qr:rotated',
      payload,
    });
    return payload;
  }

  public async startCheckpoint(
    sessionId: string,
    rotationSeconds = ROTATION_INTERVAL_SECONDS
  ): Promise<LiveQRPayload | null> {
    const { doc } = await db.mutateQrSecretAtomic(sessionId, (existing) => {
      const next: QRSecretDoc = {
        sessionId,
        checkin: existing?.checkin || createSlotState('LASU', rotationSeconds),
        verify: createSlotState('VER', rotationSeconds),
        updatedAt: new Date().toISOString(),
      };
      return { next, changed: true };
    });

    if (doc) {
      await this.writeCache(doc);
    }

    const session = await db.getSessionById(sessionId);
    if (!session) return null;
    const payload = buildPayload(session, doc);
    await pubsub.publishSessionEvent(sessionId, {
      type: 'qr:rotated',
      payload,
    });
    return payload;
  }

  public async stopCheckpoint(sessionId: string): Promise<LiveQRPayload | null> {
    const { doc } = await db.mutateQrSecretAtomic(sessionId, (existing) => {
      if (!existing) return null;
      const next: QRSecretDoc = {
        sessionId: existing.sessionId,
        checkin: existing.checkin,
        updatedAt: new Date().toISOString(),
      };
      return { next, changed: Boolean(existing.verify) };
    });

    if (doc) {
      await this.writeCache(doc);
    }

    const session = await db.getSessionById(sessionId);
    if (!session) return null;
    const payload = buildPayload(session, doc);
    await pubsub.publishSessionEvent(sessionId, {
      type: 'qr:rotated',
      payload,
    });
    return payload;
  }

  public async closeSession(sessionId: string): Promise<void> {
    await Promise.all([db.deleteQrSecret(sessionId), pubsub.delCache(`qr:${sessionId}`)]);
    const session = await db.getSessionById(sessionId);
    await pubsub.publishSessionEvent(sessionId, {
      type: 'session:closed',
      session,
    });
  }

  public async ensureActiveState(session: AttendanceSession): Promise<QRSecretDoc | null> {
    if (session.status !== 'live') return null;

    let doc = await this.readSecret(session.id);
    if (!doc) {
      const rot = session.rotationIntervalSeconds || ROTATION_INTERVAL_SECONDS;
      const res = await db.mutateQrSecretAtomic(session.id, (existing) => {
        if (existing) {
          if (session.checkpointActive && !existing.verify) {
            return {
              next: {
                ...existing,
                verify: createSlotState('VER', rot),
                updatedAt: new Date().toISOString(),
              },
              changed: true,
            };
          }
          return { next: existing, changed: false };
        }
        const created: QRSecretDoc = {
          sessionId: session.id,
          checkin: createSlotState('LASU', rot),
          ...(session.checkpointActive ? { verify: createSlotState('VER', rot) } : {}),
          updatedAt: new Date().toISOString(),
        };
        return { next: created, changed: true };
      });
      doc = res.doc;
      if (doc) await this.writeCache(doc);
    }

    if (!doc) return null;
    return this.rotateIfDue(session, doc);
  }

  public async getLivePayload(sessionId: string): Promise<LiveQRPayload | null> {
    const session = await db.getSessionById(sessionId);
    if (!session) return null;
    if (session.status !== 'live') {
      return buildPayload(session, null);
    }
    const secret = await this.ensureActiveState(session);
    return buildPayload(session, secret);
  }

  public async validateToken(
    sessionId: string,
    tokenOrCode: string,
    mode: 'checkin' | 'verify'
  ): Promise<{ valid: boolean; reason?: string; code?: string }> {
    const session = await db.getSessionById(sessionId);
    if (!session) {
      return { valid: false, reason: 'Attendance session was not found.', code: 'SESSION_NOT_FOUND' };
    }
    if (session.status !== 'live') {
      return { valid: false, reason: 'This attendance session is closed.', code: 'SESSION_CLOSED' };
    }

    const secret = await this.ensureActiveState(session);
    if (!secret) {
      return { valid: false, reason: 'This attendance session is closed.', code: 'SESSION_CLOSED' };
    }

    if (mode === 'verify' && (!session.checkpointActive || !secret.verify)) {
      return {
        valid: false,
        reason: 'The second attendance verification checkpoint is not currently open.',
        code: 'CHECKPOINT_CLOSED',
      };
    }

    const slot = mode === 'verify' ? secret.verify! : secret.checkin;
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

  public async findSessionByShortCode(
    shortCode: string
  ): Promise<{ sessionId: string; mode: 'checkin' | 'verify' } | null> {
    const upper = shortCode.trim().toUpperCase();
    const now = Date.now();
    const [liveSessions, allSecrets] = await Promise.all([db.listLiveSessions(), db.listAllQrSecrets()]);
    const liveIds = new Set(liveSessions.map((s) => s.id));
    const liveMap = new Map(liveSessions.map((s) => [s.id, s]));

    for (const secret of allSecrets) {
      if (!liveIds.has(secret.sessionId)) continue;
      const ses = liveMap.get(secret.sessionId)!;
      const graceMs = (ses.gracePeriodSeconds || GRACE_PERIOD_SECONDS) * 1000;

      if (
        (secret.checkin.currentShortCode === upper && now <= secret.checkin.expiresAt + graceMs) ||
        (secret.checkin.previousShortCode === upper &&
          secret.checkin.previousGraceUntil &&
          now <= secret.checkin.previousGraceUntil)
      ) {
        return { sessionId: secret.sessionId, mode: 'checkin' };
      }

      if (
        ses.checkpointActive &&
        secret.verify &&
        ((secret.verify.currentShortCode === upper && now <= secret.verify.expiresAt + graceMs) ||
          (secret.verify.previousShortCode === upper &&
            secret.verify.previousGraceUntil &&
            now <= secret.verify.previousGraceUntil))
      ) {
        return { sessionId: secret.sessionId, mode: 'verify' };
      }
    }
    return null;
  }

  public async subscribe(sessionId: string, ws: WebSocket): Promise<void> {
    let set = this.subscribers.get(sessionId);
    if (!set) {
      set = new Set();
      this.subscribers.set(sessionId, set);
    }
    set.add(ws);

    const payload = await this.getLivePayload(sessionId);
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

  private broadcastLocal(sessionId: string, event: unknown) {
    const set = this.subscribers.get(sessionId);
    if (!set || set.size === 0) return;
    const msg = JSON.stringify(event);
    for (const client of set) {
      if (client.readyState === 1) {
        client.send(msg);
      }
    }
  }

  public async broadcast(sessionId: string, event: unknown): Promise<void> {
    await pubsub.publishSessionEvent(sessionId, event);
  }
}

export const qrEngine = new QREngine();
