import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { Timestamp } from 'firebase-admin/firestore';
import type {
  AppNotification,
  AttendanceRecord,
  AttendanceSession,
  AttendanceStatus,
  AuditLog,
  CheckpointEvent,
  Course,
  Department,
  Enrolment,
  FailedAttempt,
  Institution,
  InstitutionSettings,
  PlatformUser,
  StudentRecord,
} from '../types/lasu.ts';
import { firebaseAdminStatus, firestoreDb, probeFirestoreAdmin } from './firebaseAdmin.ts';
import { createDefaultInstitutionSettings, createDemoSeedState, type StoreState } from './seedDemoData.ts';

export const DEMO_MODE_ENABLED = process.env.ENABLE_DEMO_MODE !== 'false';
export const IS_PRODUCTION = process.env.NODE_ENV === 'production';

export interface QRTokenSlotDoc {
  currentToken: string;
  currentShortCode: string;
  issuedAt: number;
  expiresAt: number;
  previousToken?: string;
  previousShortCode?: string;
  previousGraceUntil?: number;
}

export interface QRSecretDoc {
  sessionId: string;
  checkin: QRTokenSlotDoc;
  verify?: QRTokenSlotDoc;
  updatedAt: string;
}

function toTimestamp(iso?: string): Timestamp {
  if (!iso) return Timestamp.now();
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? Timestamp.now() : Timestamp.fromDate(d);
}

function fromTimestamp(val: unknown, fallback?: string): string {
  if (!val) return fallback || new Date().toISOString();
  if (val instanceof Timestamp) return val.toDate().toISOString();
  if (typeof val === 'object' && val !== null && 'toDate' in val && typeof (val as { toDate: () => Date }).toDate === 'function') {
    return (val as { toDate: () => Date }).toDate().toISOString();
  }
  if (typeof val === 'string') return val;
  return fallback || new Date().toISOString();
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as T;
}

const TIMESTAMP_FIELDS = new Set(['createdAt', 'updatedAt', 'enrolledAt', 'verifiedAt']);

function toFirestoreDoc<T extends object>(item: T): Record<string, unknown> {
  const clean = stripUndefined({ ...(item as Record<string, unknown>) });
  for (const key of TIMESTAMP_FIELDS) {
    if (key in clean && typeof clean[key] === 'string') {
      clean[key] = toTimestamp(clean[key] as string);
    }
  }
  return clean;
}

function fromFirestoreDoc<T>(raw: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...raw };
  for (const key of TIMESTAMP_FIELDS) {
    if (key in out) {
      out[key] = fromTimestamp(out[key]);
    }
  }
  return out as T;
}

class DatabaseManager {
  public state: StoreState;
  public failedAttempts: FailedAttempt[] = [];
  public qrSecrets = new Map<string, QRSecretDoc>();
  private locks = new Map<string, Promise<void>>();
  private initialized = false;

  constructor() {
    this.state = {
      institutions: [],
      institutionSettings: createDefaultInstitutionSettings(),
      departments: [],
      users: [],
      students: [],
      courses: [],
      enrolments: [],
      sessions: [],
      records: [],
      auditLogs: [],
      notifications: [],
    };
  }

  public isFirestoreActive(): boolean {
    return firebaseAdminStatus.firestoreAdminConnected;
  }

  public isAvailable(): boolean {
    return firebaseAdminStatus.storageMode !== 'unconfigured_error';
  }

  public async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    const connected = await probeFirestoreAdmin();
    if (connected) {
      firebaseAdminStatus.storageMode = 'firestore_admin';
      await this.hydrateFromFirestore();
      if (this.state.institutions.length === 0 && DEMO_MODE_ENABLED) {
        await this.seedFirestoreDemo();
      }
      console.log(
        `[LASU Attend] Cloud Firestore Admin connected (${firebaseAdminStatus.projectId}/${firebaseAdminStatus.firestoreDatabaseId}).`
      );
      return;
    }

    if (IS_PRODUCTION || !DEMO_MODE_ENABLED) {
      firebaseAdminStatus.storageMode = 'unconfigured_error';
      console.error(
        `[LASU Attend] CRITICAL: Cloud Firestore Admin SDK unavailable (${firebaseAdminStatus.lastError}). Production requests will return HTTP 503 until FIREBASE_SERVICE_ACCOUNT_JSON is configured.`
      );
    } else {
      firebaseAdminStatus.storageMode = 'dev_sandbox_memory';
      this.state = createDemoSeedState();
      console.warn(
        `[LASU Attend] Running in explicit Dev/Demo in-memory sandbox mode (Firestore Admin probe failed: ${firebaseAdminStatus.lastError}). Set FIREBASE_SERVICE_ACCOUNT_JSON for persistent Cloud Firestore.`
      );
    }
  }

  private async commitChunkedWrites(
    ops: Array<{ ref: FirebaseFirestore.DocumentReference; data: Record<string, unknown> }>
  ): Promise<void> {
    const CHUNK = 400;
    for (let i = 0; i < ops.length; i += CHUNK) {
      const slice = ops.slice(i, i + CHUNK);
      const batch = firestoreDb.batch();
      for (const op of slice) {
        batch.set(op.ref, op.data);
      }
      await batch.commit();
    }
  }

  private async hydrateFromFirestore(): Promise<void> {
    const [
      instSnap,
      settingsSnap,
      deptSnap,
      userSnap,
      studentSnap,
      courseSnap,
      enrolSnap,
      sessionSnap,
      recordSnap,
      auditSnap,
      notifSnap,
      qrSnap,
    ] = await Promise.all([
      firestoreDb.collection('institutions').get(),
      firestoreDb.collection('institutionSettings').doc('default').get(),
      firestoreDb.collection('departments').get(),
      firestoreDb.collection('users').get(),
      firestoreDb.collection('students').get(),
      firestoreDb.collection('courses').get(),
      firestoreDb.collection('enrolments').get(),
      firestoreDb.collection('attendanceSessions').get(),
      firestoreDb.collection('attendanceRecords').get(),
      firestoreDb.collection('auditLogs').orderBy('createdAt', 'desc').limit(1000).get(),
      firestoreDb.collection('notifications').orderBy('createdAt', 'desc').limit(1000).get(),
      firestoreDb.collection('qrTokenSecrets').get(),
    ]);

    this.state = {
      institutions: instSnap.docs.map((d) => fromFirestoreDoc<Institution>(d.data())),
      institutionSettings: settingsSnap.exists
        ? fromFirestoreDoc<InstitutionSettings>(settingsSnap.data()!)
        : createDefaultInstitutionSettings(),
      departments: deptSnap.docs.map((d) => fromFirestoreDoc<Department>(d.data())),
      users: userSnap.docs.map((d) => fromFirestoreDoc<PlatformUser>(d.data())),
      students: studentSnap.docs.map((d) => fromFirestoreDoc<StudentRecord>(d.data())),
      courses: courseSnap.docs.map((d) => fromFirestoreDoc<Course>(d.data())),
      enrolments: enrolSnap.docs.map((d) => fromFirestoreDoc<Enrolment>(d.data())),
      sessions: sessionSnap.docs.map((d) => fromFirestoreDoc<AttendanceSession>(d.data())),
      records: recordSnap.docs.map((d) => fromFirestoreDoc<AttendanceRecord>(d.data())),
      auditLogs: auditSnap.docs.map((d) => fromFirestoreDoc<AuditLog>(d.data())),
      notifications: notifSnap.docs.map((d) => fromFirestoreDoc<AppNotification>(d.data())),
    };

    this.qrSecrets.clear();
    for (const d of qrSnap.docs) {
      this.qrSecrets.set(d.id, d.data() as QRSecretDoc);
    }
  }

  public async seedFirestoreDemo(): Promise<void> {
    const seed = createDemoSeedState();
    this.state = seed;
    this.failedAttempts = [];

    if (!this.isFirestoreActive()) return;

    const ops: Array<{ ref: FirebaseFirestore.DocumentReference; data: Record<string, unknown> }> = [];
    for (const item of seed.institutions) ops.push({ ref: firestoreDb.collection('institutions').doc(item.id), data: toFirestoreDoc(item) });
    ops.push({ ref: firestoreDb.collection('institutionSettings').doc(seed.institutionSettings.id), data: toFirestoreDoc(seed.institutionSettings) });
    for (const item of seed.departments) ops.push({ ref: firestoreDb.collection('departments').doc(item.id), data: toFirestoreDoc(item) });
    for (const item of seed.users) ops.push({ ref: firestoreDb.collection('users').doc(item.uid), data: toFirestoreDoc(item) });
    for (const item of seed.students) ops.push({ ref: firestoreDb.collection('students').doc(item.id), data: toFirestoreDoc(item) });
    for (const item of seed.courses) ops.push({ ref: firestoreDb.collection('courses').doc(item.id), data: toFirestoreDoc(item) });
    for (const item of seed.enrolments) ops.push({ ref: firestoreDb.collection('enrolments').doc(item.id), data: toFirestoreDoc(item) });
    for (const item of seed.sessions) ops.push({ ref: firestoreDb.collection('attendanceSessions').doc(item.id), data: toFirestoreDoc(item) });
    for (const item of seed.records) ops.push({ ref: firestoreDb.collection('attendanceRecords').doc(item.id), data: toFirestoreDoc(item) });
    for (const item of seed.auditLogs) ops.push({ ref: firestoreDb.collection('auditLogs').doc(item.id), data: toFirestoreDoc(item) });
    for (const item of seed.notifications) ops.push({ ref: firestoreDb.collection('notifications').doc(item.id), data: toFirestoreDoc(item) });

    await this.commitChunkedWrites(ops);
  }

  public async withLock<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(key, previous.then(() => current));

    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(key) === current) {
        this.locks.delete(key);
      }
    }
  }

  // --- Atomic / Persistent Write Operations ---

  public async saveUser(user: PlatformUser): Promise<void> {
    const idx = this.state.users.findIndex((u) => u.uid === user.uid);
    if (idx >= 0) this.state.users[idx] = user;
    else this.state.users.push(user);

    if (this.isFirestoreActive()) {
      await firestoreDb.collection('users').doc(user.uid).set(toFirestoreDoc(user));
    }
  }

  public async saveDepartment(dept: Department): Promise<void> {
    const idx = this.state.departments.findIndex((d) => d.id === dept.id);
    if (idx >= 0) this.state.departments[idx] = dept;
    else this.state.departments.push(dept);

    if (this.isFirestoreActive()) {
      await firestoreDb.collection('departments').doc(dept.id).set(toFirestoreDoc(dept));
    }
  }

  public async saveInstitutionSettings(settings: InstitutionSettings): Promise<void> {
    this.state.institutionSettings = settings;
    if (this.isFirestoreActive()) {
      await firestoreDb.collection('institutionSettings').doc(settings.id).set(toFirestoreDoc(settings));
    }
  }

  public async saveCourse(course: Course): Promise<void> {
    const idx = this.state.courses.findIndex((c) => c.id === course.id);
    if (idx >= 0) this.state.courses[idx] = course;
    else this.state.courses.push(course);

    if (this.isFirestoreActive()) {
      await firestoreDb.collection('courses').doc(course.id).set(toFirestoreDoc(course));
    }
  }

  public async enrolStudentsBatch(course: Course, newEnrolments: Enrolment[]): Promise<void> {
    this.state.enrolments.push(...newEnrolments);
    const idx = this.state.courses.findIndex((c) => c.id === course.id);
    if (idx >= 0) this.state.courses[idx] = course;

    if (this.isFirestoreActive()) {
      const ops = newEnrolments.map((enr) => ({
        ref: firestoreDb.collection('enrolments').doc(enr.id),
        data: toFirestoreDoc(enr),
      }));
      ops.push({
        ref: firestoreDb.collection('courses').doc(course.id),
        data: toFirestoreDoc(course),
      });
      await this.commitChunkedWrites(ops);
    }
  }

  public async importStudentsBatch(students: StudentRecord[]): Promise<void> {
    this.state.students.unshift(...students);
    if (this.isFirestoreActive() && students.length > 0) {
      const ops = students.map((st) => ({
        ref: firestoreDb.collection('students').doc(st.id),
        data: toFirestoreDoc(st),
      }));
      await this.commitChunkedWrites(ops);
    }
  }

  public async activateStudentAtomic(params: {
    student: StudentRecord;
    user: PlatformUser;
    linkedEnrolments: Enrolment[];
    linkedRecords: AttendanceRecord[];
  }): Promise<void> {
    const { student, user, linkedEnrolments, linkedRecords } = params;

    if (this.isFirestoreActive()) {
      await firestoreDb.runTransaction(async (tx) => {
        const sRef = firestoreDb.collection('students').doc(student.id);
        const sSnap = await tx.get(sRef);
        if (sSnap.exists) {
          const cur = sSnap.data() as StudentRecord;
          if (cur.claimedUid && cur.claimedUid !== user.uid) {
            throw new Error('ALREADY_CLAIMED_BY_ANOTHER');
          }
        }
        tx.set(sRef, toFirestoreDoc(student));
        tx.set(firestoreDb.collection('users').doc(user.uid), toFirestoreDoc(user));
      });

      const batchOps: Array<{ ref: FirebaseFirestore.DocumentReference; data: Record<string, unknown> }> = [];
      for (const e of linkedEnrolments) {
        batchOps.push({ ref: firestoreDb.collection('enrolments').doc(e.id), data: toFirestoreDoc(e) });
      }
      for (const r of linkedRecords) {
        batchOps.push({ ref: firestoreDb.collection('attendanceRecords').doc(r.id), data: toFirestoreDoc(r) });
      }
      if (batchOps.length > 0) await this.commitChunkedWrites(batchOps);
    }

    const sIdx = this.state.students.findIndex((s) => s.id === student.id);
    if (sIdx >= 0) this.state.students[sIdx] = student;
    const uIdx = this.state.users.findIndex((u) => u.uid === user.uid);
    if (uIdx >= 0) this.state.users[uIdx] = user;
    else this.state.users.push(user);
  }

  public async saveSession(session: AttendanceSession): Promise<void> {
    const idx = this.state.sessions.findIndex((s) => s.id === session.id);
    if (idx >= 0) this.state.sessions[idx] = session;
    else this.state.sessions.unshift(session);

    if (this.isFirestoreActive()) {
      await firestoreDb.collection('attendanceSessions').doc(session.id).set(toFirestoreDoc(session));
    }
  }

  /**
   * Server-authoritative atomic student check-in.
   * Uses real Firestore runTransaction() when Firestore Admin is connected,
   * or serialized per-session lock in explicit Dev Sandbox mode.
   */
  public async atomicCheckIn(params: {
    sessionId: string;
    student: StudentRecord;
    actorUid: string;
  }): Promise<
    | { ok: true; record: AttendanceRecord; session: AttendanceSession }
    | { ok: false; status: number; code: string; error: string; existing?: AttendanceRecord }
  > {
    const { sessionId, student, actorUid } = params;

    if (this.isFirestoreActive()) {
      const sesRef = firestoreDb.collection('attendanceSessions').doc(sessionId);
      const recId = `rec_${sessionId}_${student.id}`;
      const recRef = firestoreDb.collection('attendanceRecords').doc(recId);

      const txResult = await firestoreDb.runTransaction(async (tx) => {
        const sesSnap = await tx.get(sesRef);
        if (!sesSnap.exists) {
          return { ok: false as const, status: 404, code: 'SESSION_NOT_FOUND', error: 'Attendance session was not found.' };
        }
        const session = fromFirestoreDoc<AttendanceSession>(sesSnap.data()!);
        if (session.status !== 'live') {
          return { ok: false as const, status: 400, code: 'SESSION_CLOSED', error: 'This attendance session is closed.' };
        }

        const enrRef = firestoreDb.collection('enrolments').doc(`enr_${session.courseId}_${student.id}`);
        const enrSnap = await tx.get(enrRef);
        if (!enrSnap.exists || (enrSnap.data() as Enrolment).status !== 'enrolled') {
          return {
            ok: false as const,
            status: 403,
            code: 'NOT_ENROLLED',
            error: `You are not enrolled in ${session.courseCode}. Contact your department if this is incorrect.`,
          };
        }

        const recSnap = await tx.get(recRef);
        if (recSnap.exists) {
          const existing = fromFirestoreDoc<AttendanceRecord>(recSnap.data()!);
          return {
            ok: false as const,
            status: 409,
            code: 'ALREADY_CHECKED_IN',
            error: 'You have already checked in for this lecture session.',
            existing,
          };
        }

        const now = Date.now();
        const nowIso = new Date(now).toISOString();
        const openedAtMs = session.openedAt ? new Date(session.openedAt).getTime() : now;
        const lateMs = (session.lateThresholdMinutes || 15) * 60_000;
        const attendanceStatus: AttendanceStatus = now - openedAtMs > lateMs ? 'late' : 'present';

        const record: AttendanceRecord = {
          id: recId,
          sessionId: session.id,
          courseId: session.courseId,
          lecturerUid: session.lecturerUid,
          studentId: student.id,
          studentUid: actorUid,
          matricNumber: student.matricNumber,
          studentName: student.fullName,
          status: attendanceStatus,
          checkInTime: nowIso,
          checkpointStatus: 'none',
          createdAt: nowIso,
          updatedAt: nowIso,
        };

        const updatedSession: AttendanceSession = {
          ...session,
          presentCount: session.presentCount + (attendanceStatus === 'present' ? 1 : 0),
          lateCount: session.lateCount + (attendanceStatus === 'late' ? 1 : 0),
          updatedAt: nowIso,
        };

        tx.set(recRef, toFirestoreDoc(record));
        tx.set(sesRef, toFirestoreDoc(updatedSession));

        return { ok: true as const, record, session: updatedSession };
      });

      if (txResult.ok) {
        this.upsertCachedRecord(txResult.record);
        this.upsertCachedSession(txResult.session);
      }
      return txResult;
    }

    // Explicit Dev Sandbox memory lock fallback
    return this.withLock(`session:${sessionId}`, () => {
      const session = this.state.sessions.find((s) => s.id === sessionId);
      if (!session) {
        return { ok: false as const, status: 404, code: 'SESSION_NOT_FOUND', error: 'Attendance session was not found.' };
      }
      if (session.status !== 'live') {
        return { ok: false as const, status: 400, code: 'SESSION_CLOSED', error: 'This attendance session is closed.' };
      }

      const enrolled = this.state.enrolments.some(
        (e) => e.courseId === session.courseId && e.studentId === student.id && e.status === 'enrolled'
      );
      if (!enrolled) {
        return {
          ok: false as const,
          status: 403,
          code: 'NOT_ENROLLED',
          error: `You are not enrolled in ${session.courseCode}. Contact your department if this is incorrect.`,
        };
      }

      const existing = this.state.records.find((r) => r.sessionId === session.id && r.studentId === student.id);
      if (existing) {
        return {
          ok: false as const,
          status: 409,
          code: 'ALREADY_CHECKED_IN',
          error: 'You have already checked in for this lecture session.',
          existing,
        };
      }

      const now = Date.now();
      const nowIso = new Date(now).toISOString();
      const openedAtMs = session.openedAt ? new Date(session.openedAt).getTime() : now;
      const lateMs = (session.lateThresholdMinutes || 15) * 60_000;
      const attendanceStatus: AttendanceStatus = now - openedAtMs > lateMs ? 'late' : 'present';

      const record: AttendanceRecord = {
        id: `rec_${session.id}_${student.id}`,
        sessionId: session.id,
        courseId: session.courseId,
        lecturerUid: session.lecturerUid,
        studentId: student.id,
        studentUid: actorUid,
        matricNumber: student.matricNumber,
        studentName: student.fullName,
        status: attendanceStatus,
        checkInTime: nowIso,
        checkpointStatus: 'none',
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      this.state.records.push(record);
      if (attendanceStatus === 'present') session.presentCount++;
      else session.lateCount++;
      session.updatedAt = nowIso;

      return { ok: true as const, record, session };
    });
  }

  public async atomicVerifyCheckpoint(params: {
    sessionId: string;
    studentId: string;
    actorUid: string;
    matricNumber: string;
  }): Promise<
    | { ok: true; record: AttendanceRecord; session: AttendanceSession }
    | { ok: false; status: number; code: string; error: string; existing?: AttendanceRecord }
  > {
    const { sessionId, studentId, actorUid, matricNumber } = params;

    if (this.isFirestoreActive()) {
      const sesRef = firestoreDb.collection('attendanceSessions').doc(sessionId);
      const recId = `rec_${sessionId}_${studentId}`;
      const recRef = firestoreDb.collection('attendanceRecords').doc(recId);
      const evId = `chk_${sessionId}_${studentId}`;
      const evRef = firestoreDb.collection('checkpointEvents').doc(evId);

      const txResult = await firestoreDb.runTransaction(async (tx) => {
        const sesSnap = await tx.get(sesRef);
        if (!sesSnap.exists) {
          return { ok: false as const, status: 400, code: 'SESSION_CLOSED', error: 'This attendance session is closed.' };
        }
        const session = fromFirestoreDoc<AttendanceSession>(sesSnap.data()!);
        if (session.status !== 'live') {
          return { ok: false as const, status: 400, code: 'SESSION_CLOSED', error: 'This attendance session is closed.' };
        }

        const recSnap = await tx.get(recRef);
        if (!recSnap.exists) {
          return {
            ok: false as const,
            status: 400,
            code: 'NO_INITIAL_CHECKIN',
            error: 'Initial check-in was not recorded for this session. Complete initial check-in first.',
          };
        }
        const existing = fromFirestoreDoc<AttendanceRecord>(recSnap.data()!);
        if (existing.checkpointStatus === 'completed') {
          return {
            ok: false as const,
            status: 409,
            code: 'ALREADY_VERIFIED',
            error: 'Second attendance checkpoint already completed for this session.',
            existing,
          };
        }

        const nowIso = new Date().toISOString();
        const updatedRecord: AttendanceRecord = {
          ...existing,
          checkpointStatus: 'completed',
          checkpointTime: nowIso,
          updatedAt: nowIso,
        };
        const updatedSession: AttendanceSession = {
          ...session,
          verifiedCount: session.verifiedCount + 1,
          updatedAt: nowIso,
        };
        const ev: CheckpointEvent = {
          id: evId,
          sessionId: session.id,
          courseId: session.courseId,
          lecturerUid: session.lecturerUid,
          studentId,
          studentUid: actorUid,
          matricNumber,
          verifiedAt: nowIso,
        };

        tx.set(recRef, toFirestoreDoc(updatedRecord));
        tx.set(sesRef, toFirestoreDoc(updatedSession));
        tx.set(evRef, toFirestoreDoc(ev));

        return { ok: true as const, record: updatedRecord, session: updatedSession };
      });

      if (txResult.ok) {
        this.upsertCachedRecord(txResult.record);
        this.upsertCachedSession(txResult.session);
      }
      return txResult;
    }

    return this.withLock(`session:${sessionId}`, () => {
      const session = this.state.sessions.find((s) => s.id === sessionId);
      if (!session || session.status !== 'live') {
        return { ok: false as const, status: 400, code: 'SESSION_CLOSED', error: 'This attendance session is closed.' };
      }
      const existing = this.state.records.find((r) => r.sessionId === session.id && r.studentId === studentId);
      if (!existing) {
        return {
          ok: false as const,
          status: 400,
          code: 'NO_INITIAL_CHECKIN',
          error: 'Initial check-in was not recorded for this session. Complete initial check-in first.',
        };
      }
      if (existing.checkpointStatus === 'completed') {
        return {
          ok: false as const,
          status: 409,
          code: 'ALREADY_VERIFIED',
          error: 'Second attendance checkpoint already completed for this session.',
          existing,
        };
      }

      const nowIso = new Date().toISOString();
      existing.checkpointStatus = 'completed';
      existing.checkpointTime = nowIso;
      existing.updatedAt = nowIso;
      session.verifiedCount++;
      session.updatedAt = nowIso;
      return { ok: true as const, record: existing, session };
    });
  }

  public async atomicCorrectAttendance(params: {
    sessionId: string;
    student: StudentRecord;
    newStatus: AttendanceStatus;
    reason: string;
    actor: PlatformUser;
  }): Promise<{ record: AttendanceRecord; session: AttendanceSession; oldStatus: string } | null> {
    const { sessionId, student, newStatus, reason, actor } = params;

    return this.withLock(`session:${sessionId}`, async () => {
      const session = this.state.sessions.find((s) => s.id === sessionId);
      if (!session) return null;

      const nowIso = new Date().toISOString();
      let rec = this.state.records.find((r) => r.sessionId === sessionId && r.studentId === student.id);
      const oldStatus = rec?.status || (session.status === 'completed' ? 'absent' : 'not_checked_in');

      if (!rec) {
        rec = {
          id: `rec_${sessionId}_${student.id}`,
          sessionId,
          courseId: session.courseId,
          lecturerUid: session.lecturerUid,
          studentId: student.id,
          studentUid: student.claimedUid,
          matricNumber: student.matricNumber,
          studentName: student.fullName,
          status: newStatus,
          checkInTime: newStatus === 'present' || newStatus === 'late' ? nowIso : undefined,
          checkpointStatus: 'none',
          correctedByUid: actor.uid,
          correctedByName: actor.displayName,
          correctionReason: reason.trim(),
          correctedAt: nowIso,
          createdAt: nowIso,
          updatedAt: nowIso,
        };
        this.state.records.push(rec);
      } else {
        rec.status = newStatus;
        if ((newStatus === 'present' || newStatus === 'late') && !rec.checkInTime) {
          rec.checkInTime = nowIso;
        }
        rec.correctedByUid = actor.uid;
        rec.correctedByName = actor.displayName;
        rec.correctionReason = reason.trim();
        rec.correctedAt = nowIso;
        rec.updatedAt = nowIso;
      }

      const sessionRecords = this.state.records.filter((r) => r.sessionId === sessionId);
      session.presentCount = sessionRecords.filter((r) => r.status === 'present').length;
      session.lateCount = sessionRecords.filter((r) => r.status === 'late').length;
      session.absentCount = sessionRecords.filter((r) => r.status === 'absent').length;
      session.updatedAt = nowIso;

      if (this.isFirestoreActive()) {
        const recRef = firestoreDb.collection('attendanceRecords').doc(rec.id);
        const sesRef = firestoreDb.collection('attendanceSessions').doc(session.id);
        await firestoreDb.runTransaction(async (tx) => {
          tx.set(recRef, toFirestoreDoc(rec!));
          tx.set(sesRef, toFirestoreDoc(session));
        });
      }

      return { record: rec, session, oldStatus };
    });
  }

  public async closeSessionAtomic(sessionId: string): Promise<AttendanceSession | null> {
    return this.withLock(`session:${sessionId}`, async () => {
      const session = this.state.sessions.find((s) => s.id === sessionId);
      if (!session) return null;
      if (session.status === 'completed') return session;

      const nowIso = new Date().toISOString();
      const hadCheckpoint = Boolean(session.checkpointStartedAt);
      const courseEnrolments = this.state.enrolments.filter(
        (e) => e.courseId === session.courseId && e.status === 'enrolled'
      );
      const existingByStudent = new Map(
        this.state.records.filter((r) => r.sessionId === session.id).map((r) => [r.studentId, r])
      );
      const studentMap = new Map(this.state.students.map((s) => [s.id, s]));

      let presentCount = 0;
      let lateCount = 0;
      let absentCount = 0;
      let verifiedCount = 0;
      const dirtyRecords: AttendanceRecord[] = [];

      for (const enr of courseEnrolments) {
        const existing = existingByStudent.get(enr.studentId);
        if (existing) {
          if (existing.status === 'present') presentCount++;
          else if (existing.status === 'late') lateCount++;
          else if (existing.status === 'absent') absentCount++;

          if (hadCheckpoint && existing.checkpointStatus === 'none') {
            existing.checkpointStatus = 'missed';
            existing.updatedAt = nowIso;
            dirtyRecords.push(existing);
          }
          if (existing.checkpointStatus === 'completed') verifiedCount++;
        } else {
          const st = studentMap.get(enr.studentId);
          if (!st) continue;
          const absentRecord: AttendanceRecord = {
            id: `rec_${session.id}_${st.id}`,
            sessionId: session.id,
            courseId: session.courseId,
            lecturerUid: session.lecturerUid,
            studentId: st.id,
            studentUid: st.claimedUid,
            matricNumber: st.matricNumber,
            studentName: st.fullName,
            status: 'absent',
            checkpointStatus: hadCheckpoint ? 'missed' : 'none',
            createdAt: nowIso,
            updatedAt: nowIso,
          };
          this.state.records.push(absentRecord);
          dirtyRecords.push(absentRecord);
          absentCount++;
        }
      }

      session.status = 'completed';
      session.checkpointActive = false;
      session.closedAt = nowIso;
      session.updatedAt = nowIso;
      session.totalEnrolled = courseEnrolments.length;
      session.presentCount = presentCount;
      session.lateCount = lateCount;
      session.absentCount = absentCount;
      session.verifiedCount = verifiedCount;

      if (this.isFirestoreActive()) {
        const ops = dirtyRecords.map((rec) => ({
          ref: firestoreDb.collection('attendanceRecords').doc(rec.id),
          data: toFirestoreDoc(rec),
        }));
        ops.push({
          ref: firestoreDb.collection('attendanceSessions').doc(session.id),
          data: toFirestoreDoc(session),
        });
        await this.commitChunkedWrites(ops);
      }

      return session;
    });
  }

  public async addAuditLog(entry: Omit<AuditLog, 'id' | 'createdAt'>): Promise<AuditLog> {
    const log: AuditLog = {
      id: `log_${crypto.randomBytes(6).toString('hex')}`,
      ...entry,
      createdAt: new Date().toISOString(),
    };
    this.state.auditLogs.unshift(log);
    if (this.state.auditLogs.length > 2000) {
      this.state.auditLogs.length = 2000;
    }
    if (this.isFirestoreActive()) {
      await firestoreDb.collection('auditLogs').doc(log.id).set(toFirestoreDoc(log));
    }
    return log;
  }

  public async upsertNotifications(list: AppNotification[]): Promise<void> {
    if (list.length === 0) return;
    const toWrite: AppNotification[] = [];
    for (const item of list) {
      const exists = this.state.notifications.some((n) => n.id === item.id);
      if (!exists) {
        this.state.notifications.unshift(item);
        toWrite.push(item);
      }
    }
    if (this.isFirestoreActive() && toWrite.length > 0) {
      const ops = toWrite.map((n) => ({
        ref: firestoreDb.collection('notifications').doc(n.id),
        data: toFirestoreDoc(n),
      }));
      await this.commitChunkedWrites(ops);
    }
  }

  public async markNotificationRead(id: string, recipientUid: string): Promise<void> {
    const n = this.state.notifications.find((item) => item.id === id && item.recipientUid === recipientUid);
    if (!n || n.read) return;
    n.read = true;
    if (this.isFirestoreActive()) {
      await firestoreDb.collection('notifications').doc(n.id).update({ read: true });
    }
  }

  public async markAllNotificationsRead(recipientUid: string): Promise<number> {
    const unread = this.state.notifications.filter((n) => n.recipientUid === recipientUid && !n.read);
    if (unread.length === 0) return 0;
    for (const n of unread) n.read = true;
    if (this.isFirestoreActive()) {
      const ops = unread.map((n) => ({
        ref: firestoreDb.collection('notifications').doc(n.id),
        data: toFirestoreDoc(n),
      }));
      await this.commitChunkedWrites(ops);
    }
    return unread.length;
  }

  public async saveQrSecret(doc: QRSecretDoc): Promise<void> {
    this.qrSecrets.set(doc.sessionId, doc);
    if (this.isFirestoreActive()) {
      await firestoreDb.collection('qrTokenSecrets').doc(doc.sessionId).set(stripUndefined({ ...doc }));
    }
  }

  public async deleteQrSecret(sessionId: string): Promise<void> {
    this.qrSecrets.delete(sessionId);
    if (this.isFirestoreActive()) {
      await firestoreDb.collection('qrTokenSecrets').doc(sessionId).delete().catch(() => {});
    }
  }

  private upsertCachedRecord(rec: AttendanceRecord) {
    const idx = this.state.records.findIndex((r) => r.id === rec.id);
    if (idx >= 0) this.state.records[idx] = rec;
    else this.state.records.push(rec);
  }

  private upsertCachedSession(ses: AttendanceSession) {
    const idx = this.state.sessions.findIndex((s) => s.id === ses.id);
    if (idx >= 0) this.state.sessions[idx] = ses;
    else this.state.sessions.unshift(ses);
  }
}

export const db = new DatabaseManager();

export function requirePersistentDatabase(req: Request, res: Response, next: NextFunction) {
  if (!db.isAvailable()) {
    res.status(503).json({
      error:
        'Cloud Firestore persistent backend is not configured for this server. Set FIREBASE_SERVICE_ACCOUNT_JSON in environment secrets.',
      code: 'FIRESTORE_UNAVAILABLE',
      storageMode: firebaseAdminStatus.storageMode,
    });
    return;
  }
  next();
}
