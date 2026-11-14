import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
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
  StudentLevel,
  StudentRecord,
} from '../types/lasu.ts';
import { firebaseAdminStatus, firestoreDb, probeFirestoreAdmin } from './firebaseAdmin.ts';
import { createDefaultInstitutionSettings, createDemoSeedState, type StoreState } from './seedDemoData.ts';

export const IS_PRODUCTION = process.env.NODE_ENV === 'production';
export const DEMO_MODE_ENABLED = !IS_PRODUCTION && process.env.ENABLE_DEMO_MODE !== 'false';

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

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

function toTimestamp(iso?: string): Timestamp {
  if (!iso) return Timestamp.now();
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? Timestamp.now() : Timestamp.fromDate(d);
}

function fromTimestamp(val: unknown, fallback?: string): string {
  if (!val) return fallback || new Date().toISOString();
  if (val instanceof Timestamp) return val.toDate().toISOString();
  if (
    typeof val === 'object' &&
    val !== null &&
    'toDate' in val &&
    typeof (val as { toDate: () => Date }).toDate === 'function'
  ) {
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

const TIMESTAMP_FIELDS = new Set(['createdAt', 'updatedAt', 'enrolledAt', 'verifiedAt', 'attemptedAt']);

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

function emptySandboxState(): StoreState {
  return {
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

class DatabaseManager {
  // Retained strictly for explicit non-production dev_sandbox_memory mode; empty when Firestore is active
  public state: StoreState;
  private sandboxFailedAttempts: FailedAttempt[] = [];
  private sandboxQrSecrets = new Map<string, QRSecretDoc>();
  private locks = new Map<string, Promise<void>>();
  private initPromise: Promise<void> | null = null;

  constructor() {
    this.state = emptySandboxState();
  }

  public isFirestoreActive(): boolean {
    return firebaseAdminStatus.firestoreAdminConnected;
  }

  public isAvailable(): boolean {
    return firebaseAdminStatus.storageMode !== 'unconfigured_error';
  }

  public async init(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.performInit();
    return this.initPromise;
  }

  private async performInit(): Promise<void> {
    const connected = await probeFirestoreAdmin();
    if (connected) {
      firebaseAdminStatus.storageMode = 'firestore_admin';
      this.state = emptySandboxState();
      if (!IS_PRODUCTION && DEMO_MODE_ENABLED) {
        const instSnap = await firestoreDb.collection('institutions').limit(1).get();
        if (instSnap.empty) {
          await this.seedFirestoreDemo();
        }
      }
      console.log(
        `[LASU Attend] Cloud Firestore Admin connected (${firebaseAdminStatus.projectId}/${firebaseAdminStatus.firestoreDatabaseId}) — authoritative Firestore query mode active.`
      );
      return;
    }

    if (IS_PRODUCTION || !DEMO_MODE_ENABLED) {
      firebaseAdminStatus.storageMode = 'unconfigured_error';
      console.error(
        `[LASU Attend] CRITICAL: Cloud Firestore Admin SDK unavailable (${firebaseAdminStatus.lastError}). Operational routes will return HTTP 503 FIRESTORE_UNAVAILABLE until FIREBASE_SERVICE_ACCOUNT_JSON is configured.`
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

  private async getDocsByIds<T>(collectionName: string, ids: string[]): Promise<T[]> {
    const unique = Array.from(new Set(ids.filter(Boolean)));
    if (unique.length === 0) return [];
    const results: T[] = [];
    const CHUNK = 100;
    for (let i = 0; i < unique.length; i += CHUNK) {
      const slice = unique.slice(i, i + CHUNK);
      const refs = slice.map((id) => firestoreDb.collection(collectionName).doc(id));
      const snaps = await firestoreDb.getAll(...refs);
      for (const snap of snaps) {
        if (snap.exists && snap.data()) {
          results.push(fromFirestoreDoc<T>(snap.data()!));
        }
      }
    }
    return results;
  }

  private async chunkedInQuery<T>(collectionName: string, field: string, values: string[]): Promise<T[]> {
    const unique = Array.from(new Set(values.filter(Boolean)));
    if (unique.length === 0) return [];
    const CHUNK = 30; // Firestore 'in' operator cap
    const chunkPromises: Array<Promise<FirebaseFirestore.QuerySnapshot>> = [];
    for (let i = 0; i < unique.length; i += CHUNK) {
      const slice = unique.slice(i, i + CHUNK);
      chunkPromises.push(firestoreDb.collection(collectionName).where(field, 'in', slice).get());
    }
    const snaps = await Promise.all(chunkPromises);
    const out: T[] = [];
    for (const snap of snaps) {
      for (const doc of snap.docs) {
        out.push(fromFirestoreDoc<T>(doc.data()));
      }
    }
    return out;
  }

  public async seedFirestoreDemo(): Promise<void> {
    if (IS_PRODUCTION || !DEMO_MODE_ENABLED) {
      throw new Error('Demo seeding is disabled when production mode or ENABLE_DEMO_MODE=false is active.');
    }

    const seed = createDemoSeedState();
    this.sandboxFailedAttempts = [];
    this.sandboxQrSecrets.clear();

    if (!this.isFirestoreActive()) {
      this.state = seed;
      return;
    }

    const ops: Array<{ ref: FirebaseFirestore.DocumentReference; data: Record<string, unknown> }> = [];
    for (const item of seed.institutions)
      ops.push({ ref: firestoreDb.collection('institutions').doc(item.id), data: toFirestoreDoc(item) });
    ops.push({
      ref: firestoreDb.collection('institutionSettings').doc(seed.institutionSettings.id),
      data: toFirestoreDoc(seed.institutionSettings),
    });
    for (const item of seed.departments)
      ops.push({ ref: firestoreDb.collection('departments').doc(item.id), data: toFirestoreDoc(item) });
    for (const item of seed.users)
      ops.push({ ref: firestoreDb.collection('users').doc(item.uid), data: toFirestoreDoc(item) });
    for (const item of seed.students)
      ops.push({ ref: firestoreDb.collection('students').doc(item.id), data: toFirestoreDoc(item) });
    for (const item of seed.courses)
      ops.push({ ref: firestoreDb.collection('courses').doc(item.id), data: toFirestoreDoc(item) });
    for (const item of seed.enrolments)
      ops.push({ ref: firestoreDb.collection('enrolments').doc(item.id), data: toFirestoreDoc(item) });
    for (const item of seed.sessions)
      ops.push({ ref: firestoreDb.collection('attendanceSessions').doc(item.id), data: toFirestoreDoc(item) });
    for (const item of seed.records)
      ops.push({ ref: firestoreDb.collection('attendanceRecords').doc(item.id), data: toFirestoreDoc(item) });
    for (const item of seed.auditLogs)
      ops.push({ ref: firestoreDb.collection('auditLogs').doc(item.id), data: toFirestoreDoc(item) });
    for (const item of seed.notifications)
      ops.push({ ref: firestoreDb.collection('notifications').doc(item.id), data: toFirestoreDoc(item) });

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

  // --- Institutions & Settings ---

  public async getPrimaryInstitution(): Promise<Institution | null> {
    if (!this.isFirestoreActive()) {
      return this.state.institutions[0] || null;
    }
    const snap = await firestoreDb.collection('institutions').limit(1).get();
    if (snap.empty) return null;
    return fromFirestoreDoc<Institution>(snap.docs[0].data());
  }

  public async getInstitutionSettings(): Promise<InstitutionSettings> {
    if (!this.isFirestoreActive()) {
      return this.state.institutionSettings;
    }
    const snap = await firestoreDb.collection('institutionSettings').doc('default').get();
    if (!snap.exists || !snap.data()) {
      return createDefaultInstitutionSettings();
    }
    return fromFirestoreDoc<InstitutionSettings>(snap.data()!);
  }

  public async saveInstitutionSettings(settings: InstitutionSettings): Promise<void> {
    if (!this.isFirestoreActive()) {
      this.state.institutionSettings = settings;
      return;
    }
    await firestoreDb.collection('institutionSettings').doc(settings.id).set(toFirestoreDoc(settings));
  }

  // --- Departments ---

  public async listDepartments(departmentId?: string): Promise<Department[]> {
    if (!this.isFirestoreActive()) {
      return departmentId
        ? this.state.departments.filter((d) => d.id === departmentId)
        : [...this.state.departments];
    }
    if (departmentId) {
      const doc = await this.getDepartmentById(departmentId);
      return doc ? [doc] : [];
    }
    const snap = await firestoreDb.collection('departments').get();
    return snap.docs.map((d) => fromFirestoreDoc<Department>(d.data()));
  }

  public async getDepartmentById(id: string): Promise<Department | null> {
    if (!id) return null;
    if (!this.isFirestoreActive()) {
      return this.state.departments.find((d) => d.id === id) || null;
    }
    const snap = await firestoreDb.collection('departments').doc(id).get();
    return snap.exists && snap.data() ? fromFirestoreDoc<Department>(snap.data()!) : null;
  }

  public async getDepartmentByCode(code: string): Promise<Department | null> {
    const clean = code.trim().toUpperCase();
    if (!this.isFirestoreActive()) {
      return this.state.departments.find((d) => d.code.toUpperCase() === clean) || null;
    }
    const snap = await firestoreDb.collection('departments').where('code', '==', clean).limit(1).get();
    return !snap.empty ? fromFirestoreDoc<Department>(snap.docs[0].data()) : null;
  }

  public async saveDepartment(dept: Department): Promise<void> {
    if (!this.isFirestoreActive()) {
      const idx = this.state.departments.findIndex((d) => d.id === dept.id);
      if (idx >= 0) this.state.departments[idx] = dept;
      else this.state.departments.push(dept);
      return;
    }
    await firestoreDb.collection('departments').doc(dept.id).set(toFirestoreDoc(dept));
  }

  // --- Users & RBAC ---

  public async getUserByUid(uid: string): Promise<PlatformUser | null> {
    if (!uid) return null;
    if (!this.isFirestoreActive()) {
      return this.state.users.find((u) => u.uid === uid) || null;
    }
    const snap = await firestoreDb.collection('users').doc(uid).get();
    return snap.exists && snap.data() ? fromFirestoreDoc<PlatformUser>(snap.data()!) : null;
  }

  public async getUserByEmail(email: string): Promise<PlatformUser | null> {
    const clean = email.trim().toLowerCase();
    if (!clean) return null;
    if (!this.isFirestoreActive()) {
      return this.state.users.find((u) => u.email.toLowerCase() === clean) || null;
    }
    const snap = await firestoreDb.collection('users').where('email', '==', clean).limit(1).get();
    return !snap.empty ? fromFirestoreDoc<PlatformUser>(snap.docs[0].data()) : null;
  }

  public async hasAnySystemAdmin(): Promise<boolean> {
    if (!this.isFirestoreActive()) {
      return this.state.users.some((u) => u.role === 'system_admin' && u.status === 'active');
    }
    // Single-field query avoids composite index requirement
    const snap = await firestoreDb.collection('users').where('role', '==', 'system_admin').limit(20).get();
    return snap.docs.some((d) => (d.data() as PlatformUser).status === 'active');
  }

  public async listUsers(departmentId?: string): Promise<PlatformUser[]> {
    if (!this.isFirestoreActive()) {
      return departmentId ? this.state.users.filter((u) => u.departmentId === departmentId) : [...this.state.users];
    }
    const q = departmentId
      ? firestoreDb.collection('users').where('departmentId', '==', departmentId)
      : firestoreDb.collection('users').limit(500);
    const snap = await q.get();
    return snap.docs.map((d) => fromFirestoreDoc<PlatformUser>(d.data()));
  }

  public async listDemoAccounts(): Promise<PlatformUser[]> {
    if (IS_PRODUCTION || !DEMO_MODE_ENABLED) return [];
    if (!this.isFirestoreActive()) {
      return this.state.users.filter((u) => u.isDemo);
    }
    const snap = await firestoreDb.collection('users').where('isDemo', '==', true).limit(25).get();
    return snap.docs.map((d) => fromFirestoreDoc<PlatformUser>(d.data()));
  }

  public async saveUser(user: PlatformUser): Promise<void> {
    const normalized: PlatformUser = { ...user, email: user.email.trim().toLowerCase() };
    if (!this.isFirestoreActive()) {
      const idx = this.state.users.findIndex((u) => u.uid === normalized.uid);
      if (idx >= 0) this.state.users[idx] = normalized;
      else this.state.users.push(normalized);
      return;
    }
    await firestoreDb.collection('users').doc(normalized.uid).set(toFirestoreDoc(normalized));
  }

  // --- Students & Register ---

  public async getStudentById(id: string): Promise<StudentRecord | null> {
    if (!id) return null;
    if (!this.isFirestoreActive()) {
      return this.state.students.find((s) => s.id === id) || null;
    }
    const snap = await firestoreDb.collection('students').doc(id).get();
    return snap.exists && snap.data() ? fromFirestoreDoc<StudentRecord>(snap.data()!) : null;
  }

  public async getStudentByClaimedUid(uid: string): Promise<StudentRecord | null> {
    if (!uid) return null;
    if (!this.isFirestoreActive()) {
      return this.state.students.find((s) => s.claimedUid === uid) || null;
    }
    const snap = await firestoreDb.collection('students').where('claimedUid', '==', uid).limit(1).get();
    return !snap.empty ? fromFirestoreDoc<StudentRecord>(snap.docs[0].data()) : null;
  }

  public async getStudentByMatric(matricNumber: string): Promise<StudentRecord | null> {
    const clean = matricNumber.trim().toUpperCase();
    if (!clean) return null;
    if (!this.isFirestoreActive()) {
      return this.state.students.find((s) => s.matricNumber.toUpperCase() === clean) || null;
    }
    const directId = `std_${clean.replace(/[^a-zA-Z0-9]/g, '')}`;
    const directSnap = await firestoreDb.collection('students').doc(directId).get();
    if (directSnap.exists && directSnap.data()) {
      return fromFirestoreDoc<StudentRecord>(directSnap.data()!);
    }
    const qSnap = await firestoreDb.collection('students').where('matricNumber', '==', clean).limit(1).get();
    return !qSnap.empty ? fromFirestoreDoc<StudentRecord>(qSnap.docs[0].data()) : null;
  }

  public async listStudentsByIds(ids: string[]): Promise<StudentRecord[]> {
    if (!this.isFirestoreActive()) {
      const set = new Set(ids);
      return this.state.students.filter((s) => set.has(s.id));
    }
    return this.getDocsByIds<StudentRecord>('students', ids);
  }

  public async findExistingStudentsByMatrics(matrics: string[]): Promise<StudentRecord[]> {
    const clean = Array.from(new Set(matrics.map((m) => m.trim().toUpperCase()).filter(Boolean)));
    if (clean.length === 0) return [];
    if (!this.isFirestoreActive()) {
      const set = new Set(clean);
      return this.state.students.filter((s) => set.has(s.matricNumber.toUpperCase()));
    }
    return this.chunkedInQuery<StudentRecord>('students', 'matricNumber', clean);
  }

  public async listStudentsByCohort(departmentId?: string, level?: StudentLevel): Promise<StudentRecord[]> {
    if (!this.isFirestoreActive()) {
      return this.state.students.filter(
        (s) => (!departmentId || s.departmentId === departmentId) && (!level || s.level === level)
      );
    }
    let list: StudentRecord[];
    if (departmentId) {
      const snap = await firestoreDb.collection('students').where('departmentId', '==', departmentId).get();
      list = snap.docs.map((d) => fromFirestoreDoc<StudentRecord>(d.data()));
    } else if (level) {
      const snap = await firestoreDb.collection('students').where('level', '==', level).get();
      list = snap.docs.map((d) => fromFirestoreDoc<StudentRecord>(d.data()));
    } else {
      const snap = await firestoreDb.collection('students').limit(2000).get();
      list = snap.docs.map((d) => fromFirestoreDoc<StudentRecord>(d.data()));
    }
    if (level) list = list.filter((s) => s.level === level);
    if (departmentId) list = list.filter((s) => s.departmentId === departmentId);
    return list;
  }

  public async getDepartmentStudentCounts(
    departmentIds: string[]
  ): Promise<Record<string, { total: number; active: number; pending: number }>> {
    const counts: Record<string, { total: number; active: number; pending: number }> = {};
    for (const id of departmentIds) {
      counts[id] = { total: 0, active: 0, pending: 0 };
    }

    if (!this.isFirestoreActive()) {
      for (const s of this.state.students) {
        if (!counts[s.departmentId]) continue;
        counts[s.departmentId].total++;
        if (s.accountStatus === 'active') counts[s.departmentId].active++;
        else if (s.accountStatus === 'pending_activation') counts[s.departmentId].pending++;
      }
      return counts;
    }

    await Promise.all(
      departmentIds.map(async (deptId) => {
        const snap = await firestoreDb
          .collection('students')
          .where('departmentId', '==', deptId)
          .select('accountStatus')
          .get();
        let active = 0;
        let pending = 0;
        for (const doc of snap.docs) {
          const st = doc.get('accountStatus');
          if (st === 'active') active++;
          else if (st === 'pending_activation') pending++;
        }
        counts[deptId] = { total: snap.size, active, pending };
      })
    );

    return counts;
  }

  public async queryStudentsPaginated(params: {
    user: PlatformUser;
    search?: string;
    departmentId?: string;
    statusFilter?: string;
    courseId?: string;
    page: number;
    pageSize: number;
  }): Promise<PaginatedResult<StudentRecord>> {
    const { user, search = '', departmentId = '', statusFilter = '', courseId = '', page, pageSize } = params;
    const cleanSearch = search.trim().toLowerCase();

    const sanitizeList = (list: StudentRecord[], total: number): PaginatedResult<StudentRecord> => {
      const canSeeCodes = user.role === 'system_admin' || user.role === 'department_admin';
      return {
        items: list.map((s) => ({
          ...s,
          activationCode: canSeeCodes ? s.activationCode : undefined,
        })),
        total,
        page,
        pageSize,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      };
    };

    if (!this.isFirestoreActive()) {
      let list = [...this.state.students];
      if (user.role === 'department_admin') {
        list = list.filter((s) => s.departmentId === user.departmentId);
      } else if (user.role === 'lecturer') {
        const myCourseIds = new Set(
          this.state.courses.filter((c) => c.lecturerUid === user.uid).map((c) => c.id)
        );
        const myStudentIds = new Set(
          this.state.enrolments
            .filter((e) => myCourseIds.has(e.courseId) && e.status === 'enrolled')
            .map((e) => e.studentId)
        );
        list = list.filter((s) => myStudentIds.has(s.id));
      }
      if (courseId) {
        const enrolledInCourse = new Set(
          this.state.enrolments
            .filter((e) => e.courseId === courseId && e.status === 'enrolled')
            .map((e) => e.studentId)
        );
        list = list.filter((s) => enrolledInCourse.has(s.id));
      }
      if (departmentId && user.role !== 'department_admin') {
        list = list.filter((s) => s.departmentId === departmentId);
      }
      if (statusFilter) {
        list = list.filter((s) => s.accountStatus === statusFilter);
      }
      if (cleanSearch) {
        list = list.filter(
          (s) => s.fullName.toLowerCase().includes(cleanSearch) || s.matricNumber.toLowerCase().includes(cleanSearch)
        );
      }
      const total = list.length;
      const start = (page - 1) * pageSize;
      return sanitizeList(list.slice(start, start + pageSize), total);
    }

    // Firestore authoritative query paths
    const effectiveDept = user.role === 'department_admin' ? user.departmentId : departmentId;

    // Path 1: Scoped to course(s) (courseId filter or lecturer view)
    if (courseId || user.role === 'lecturer') {
      let scopedCourseIds: string[];
      if (user.role === 'lecturer') {
        const myCourses = await this.listCoursesForUser(user);
        const allowed = new Set(myCourses.map((c) => c.id));
        scopedCourseIds = courseId ? (allowed.has(courseId) ? [courseId] : []) : Array.from(allowed);
      } else {
        scopedCourseIds = [courseId];
      }
      if (scopedCourseIds.length === 0) {
        return sanitizeList([], 0);
      }
      const enrolments = await this.chunkedInQuery<Enrolment>('enrolments', 'courseId', scopedCourseIds);
      const enrolledIds = Array.from(
        new Set(enrolments.filter((e) => e.status === 'enrolled').map((e) => e.studentId))
      );
      let students = await this.listStudentsByIds(enrolledIds);
      if (effectiveDept) students = students.filter((s) => s.departmentId === effectiveDept);
      if (statusFilter) students = students.filter((s) => s.accountStatus === statusFilter);
      if (cleanSearch) {
        students = students.filter(
          (s) => s.fullName.toLowerCase().includes(cleanSearch) || s.matricNumber.toLowerCase().includes(cleanSearch)
        );
      }
      students.sort((a, b) => a.matricNumber.localeCompare(b.matricNumber));
      const total = students.length;
      const start = (page - 1) * pageSize;
      return sanitizeList(students.slice(start, start + pageSize), total);
    }

    // Path 2: Unfiltered admin browse -> pure Firestore DB pagination via orderBy + limit/offset + count()
    if (!effectiveDept && !statusFilter && !cleanSearch) {
      const col = firestoreDb.collection('students');
      const [countSnap, pageSnap] = await Promise.all([
        col.count().get(),
        col
          .orderBy('matricNumber', 'asc')
          .offset((page - 1) * pageSize)
          .limit(pageSize)
          .get(),
      ]);
      const total = countSnap.data().count;
      return sanitizeList(
        pageSnap.docs.map((d) => fromFirestoreDoc<StudentRecord>(d.data())),
        total
      );
    }

    // Path 3: Single-field filter (avoids composite index) + bounded in-memory refinement
    let list: StudentRecord[] = [];
    if (effectiveDept) {
      const snap = await firestoreDb.collection('students').where('departmentId', '==', effectiveDept).get();
      list = snap.docs.map((d) => fromFirestoreDoc<StudentRecord>(d.data()));
    } else if (statusFilter) {
      const snap = await firestoreDb.collection('students').where('accountStatus', '==', statusFilter).get();
      list = snap.docs.map((d) => fromFirestoreDoc<StudentRecord>(d.data()));
    } else {
      // Search across institution bounded by matricNumber order
      const snap = await firestoreDb.collection('students').orderBy('matricNumber', 'asc').limit(2500).get();
      list = snap.docs.map((d) => fromFirestoreDoc<StudentRecord>(d.data()));
    }

    if (effectiveDept) list = list.filter((s) => s.departmentId === effectiveDept);
    if (statusFilter) list = list.filter((s) => s.accountStatus === statusFilter);
    if (cleanSearch) {
      list = list.filter(
        (s) => s.fullName.toLowerCase().includes(cleanSearch) || s.matricNumber.toLowerCase().includes(cleanSearch)
      );
    }
    list.sort((a, b) => a.matricNumber.localeCompare(b.matricNumber));
    const total = list.length;
    const start = (page - 1) * pageSize;
    return sanitizeList(list.slice(start, start + pageSize), total);
  }

  public async importStudentsBatch(students: StudentRecord[]): Promise<void> {
    if (students.length === 0) return;
    if (!this.isFirestoreActive()) {
      this.state.students.unshift(...students);
      return;
    }
    const ops = students.map((st) => ({
      ref: firestoreDb.collection('students').doc(st.id),
      data: toFirestoreDoc(st),
    }));
    await this.commitChunkedWrites(ops);
  }

  public async activateStudentAtomic(params: {
    student: StudentRecord;
    user: PlatformUser;
  }): Promise<{ student: StudentRecord; user: PlatformUser }> {
    const { student, user } = params;

    if (!this.isFirestoreActive()) {
      const sIdx = this.state.students.findIndex((s) => s.id === student.id);
      if (sIdx >= 0) {
        const cur = this.state.students[sIdx];
        if (cur.claimedUid && cur.claimedUid !== user.uid) {
          throw new Error('ALREADY_CLAIMED_BY_ANOTHER');
        }
        this.state.students[sIdx] = student;
      }
      for (const enr of this.state.enrolments) {
        if (enr.studentId === student.id) enr.studentUid = user.uid;
      }
      for (const rec of this.state.records) {
        if (rec.studentId === student.id) rec.studentUid = user.uid;
      }
      const uIdx = this.state.users.findIndex((u) => u.uid === user.uid);
      if (uIdx >= 0) this.state.users[uIdx] = user;
      else this.state.users.push(user);
      return { student, user };
    }

    await firestoreDb.runTransaction(async (tx) => {
      const sRef = firestoreDb.collection('students').doc(student.id);
      const sSnap = await tx.get(sRef);
      if (!sSnap.exists) {
        throw new Error('STUDENT_NOT_FOUND');
      }
      const cur = fromFirestoreDoc<StudentRecord>(sSnap.data()!);
      if (cur.accountStatus === 'suspended') {
        throw new Error('STUDENT_SUSPENDED');
      }
      if (cur.claimedUid && cur.claimedUid !== user.uid) {
        throw new Error('ALREADY_CLAIMED_BY_ANOTHER');
      }
      tx.set(sRef, toFirestoreDoc(student));
      tx.set(firestoreDb.collection('users').doc(user.uid), toFirestoreDoc(user));
    });

    // Backfill studentUid onto existing enrolments & historical attendance records
    const [enrSnap, recSnap] = await Promise.all([
      firestoreDb.collection('enrolments').where('studentId', '==', student.id).get(),
      firestoreDb.collection('attendanceRecords').where('studentId', '==', student.id).get(),
    ]);

    const batchOps: Array<{ ref: FirebaseFirestore.DocumentReference; data: Record<string, unknown> }> = [];
    for (const d of enrSnap.docs) {
      const data = fromFirestoreDoc<Enrolment>(d.data());
      if (data.studentUid !== user.uid) {
        batchOps.push({ ref: d.ref, data: toFirestoreDoc({ ...data, studentUid: user.uid }) });
      }
    }
    for (const d of recSnap.docs) {
      const data = fromFirestoreDoc<AttendanceRecord>(d.data());
      if (data.studentUid !== user.uid) {
        batchOps.push({ ref: d.ref, data: toFirestoreDoc({ ...data, studentUid: user.uid }) });
      }
    }
    if (batchOps.length > 0) {
      await this.commitChunkedWrites(batchOps);
    }

    return { student, user };
  }

  // --- Courses & Enrolments ---

  public async getCourseById(courseId: string): Promise<Course | null> {
    if (!courseId) return null;
    if (!this.isFirestoreActive()) {
      return this.state.courses.find((c) => c.id === courseId) || null;
    }
    const snap = await firestoreDb.collection('courses').doc(courseId).get();
    return snap.exists && snap.data() ? fromFirestoreDoc<Course>(snap.data()!) : null;
  }

  public async listCoursesForUser(user: PlatformUser): Promise<Course[]> {
    if (!this.isFirestoreActive()) {
      if (user.role === 'system_admin') return [...this.state.courses];
      if (user.role === 'department_admin') {
        return this.state.courses.filter((c) => c.departmentId === user.departmentId);
      }
      if (user.role === 'lecturer') {
        return this.state.courses.filter((c) => c.lecturerUid === user.uid);
      }
      const enrCourseIds = new Set(
        this.state.enrolments
          .filter((e) => e.studentId === user.studentId && e.status === 'enrolled')
          .map((e) => e.courseId)
      );
      return this.state.courses.filter((c) => enrCourseIds.has(c.id));
    }

    if (user.role === 'system_admin') {
      const snap = await firestoreDb.collection('courses').get();
      return snap.docs.map((d) => fromFirestoreDoc<Course>(d.data()));
    }
    if (user.role === 'department_admin') {
      const snap = await firestoreDb.collection('courses').where('departmentId', '==', user.departmentId).get();
      return snap.docs.map((d) => fromFirestoreDoc<Course>(d.data()));
    }
    if (user.role === 'lecturer') {
      const snap = await firestoreDb.collection('courses').where('lecturerUid', '==', user.uid).get();
      return snap.docs.map((d) => fromFirestoreDoc<Course>(d.data()));
    }
    if (!user.studentId) return [];
    const enrolments = await this.listEnrolmentsByStudent(user.studentId);
    const courseIds = enrolments.filter((e) => e.status === 'enrolled').map((e) => e.courseId);
    return this.getDocsByIds<Course>('courses', courseIds);
  }

  public async listCoursesByIds(ids: string[]): Promise<Course[]> {
    if (!this.isFirestoreActive()) {
      const set = new Set(ids);
      return this.state.courses.filter((c) => set.has(c.id));
    }
    return this.getDocsByIds<Course>('courses', ids);
  }

  public async saveCourse(course: Course): Promise<void> {
    if (!this.isFirestoreActive()) {
      const idx = this.state.courses.findIndex((c) => c.id === course.id);
      if (idx >= 0) this.state.courses[idx] = course;
      else this.state.courses.push(course);
      return;
    }
    await firestoreDb.collection('courses').doc(course.id).set(toFirestoreDoc(course));
  }

  public async listEnrolmentsByCourse(courseId: string): Promise<Enrolment[]> {
    if (!this.isFirestoreActive()) {
      return this.state.enrolments.filter((e) => e.courseId === courseId && e.status === 'enrolled');
    }
    const snap = await firestoreDb.collection('enrolments').where('courseId', '==', courseId).get();
    return snap.docs
      .map((d) => fromFirestoreDoc<Enrolment>(d.data()))
      .filter((e) => e.status === 'enrolled');
  }

  public async listEnrolmentsByCourseIds(courseIds: string[]): Promise<Enrolment[]> {
    if (courseIds.length === 0) return [];
    if (!this.isFirestoreActive()) {
      const set = new Set(courseIds);
      return this.state.enrolments.filter((e) => set.has(e.courseId) && e.status === 'enrolled');
    }
    const list = await this.chunkedInQuery<Enrolment>('enrolments', 'courseId', courseIds);
    return list.filter((e) => e.status === 'enrolled');
  }

  public async listEnrolmentsByStudent(studentId: string): Promise<Enrolment[]> {
    if (!studentId) return [];
    if (!this.isFirestoreActive()) {
      return this.state.enrolments.filter((e) => e.studentId === studentId && e.status === 'enrolled');
    }
    const snap = await firestoreDb.collection('enrolments').where('studentId', '==', studentId).get();
    return snap.docs
      .map((d) => fromFirestoreDoc<Enrolment>(d.data()))
      .filter((e) => e.status === 'enrolled');
  }

  public async getEnrolment(courseId: string, studentId: string): Promise<Enrolment | null> {
    if (!this.isFirestoreActive()) {
      return (
        this.state.enrolments.find(
          (e) => e.courseId === courseId && e.studentId === studentId && e.status === 'enrolled'
        ) || null
      );
    }
    const snap = await firestoreDb.collection('enrolments').doc(`enr_${courseId}_${studentId}`).get();
    if (!snap.exists || !snap.data()) return null;
    const enr = fromFirestoreDoc<Enrolment>(snap.data()!);
    return enr.status === 'enrolled' ? enr : null;
  }

  public async enrolStudentsBatch(course: Course, newEnrolments: Enrolment[]): Promise<void> {
    if (!this.isFirestoreActive()) {
      this.state.enrolments.push(...newEnrolments);
      const idx = this.state.courses.findIndex((c) => c.id === course.id);
      if (idx >= 0) this.state.courses[idx] = course;
      return;
    }
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

  // --- Attendance Sessions ---

  public async getSessionById(sessionId: string): Promise<AttendanceSession | null> {
    if (!sessionId) return null;
    if (!this.isFirestoreActive()) {
      return this.state.sessions.find((s) => s.id === sessionId) || null;
    }
    const snap = await firestoreDb.collection('attendanceSessions').doc(sessionId).get();
    return snap.exists && snap.data() ? fromFirestoreDoc<AttendanceSession>(snap.data()!) : null;
  }

  public async listLiveSessions(): Promise<AttendanceSession[]> {
    if (!this.isFirestoreActive()) {
      return this.state.sessions.filter((s) => s.status === 'live');
    }
    const snap = await firestoreDb.collection('attendanceSessions').where('status', '==', 'live').get();
    return snap.docs.map((d) => fromFirestoreDoc<AttendanceSession>(d.data()));
  }

  public async listSessionsForUser(user: PlatformUser): Promise<AttendanceSession[]> {
    let list: AttendanceSession[] = [];
    if (!this.isFirestoreActive()) {
      if (user.role === 'system_admin') list = [...this.state.sessions];
      else if (user.role === 'department_admin') {
        list = this.state.sessions.filter((s) => s.departmentId === user.departmentId);
      } else if (user.role === 'lecturer') {
        list = this.state.sessions.filter((s) => s.lecturerUid === user.uid);
      } else {
        const myCourses = new Set(
          this.state.enrolments
            .filter((e) => e.studentId === user.studentId && e.status === 'enrolled')
            .map((e) => e.courseId)
        );
        list = this.state.sessions.filter((s) => myCourses.has(s.courseId));
      }
    } else {
      if (user.role === 'system_admin') {
        const snap = await firestoreDb.collection('attendanceSessions').get();
        list = snap.docs.map((d) => fromFirestoreDoc<AttendanceSession>(d.data()));
      } else if (user.role === 'department_admin') {
        const snap = await firestoreDb
          .collection('attendanceSessions')
          .where('departmentId', '==', user.departmentId)
          .get();
        list = snap.docs.map((d) => fromFirestoreDoc<AttendanceSession>(d.data()));
      } else if (user.role === 'lecturer') {
        const snap = await firestoreDb
          .collection('attendanceSessions')
          .where('lecturerUid', '==', user.uid)
          .get();
        list = snap.docs.map((d) => fromFirestoreDoc<AttendanceSession>(d.data()));
      } else if (user.studentId) {
        const enrolments = await this.listEnrolmentsByStudent(user.studentId);
        const courseIds = enrolments.map((e) => e.courseId);
        list = await this.chunkedInQuery<AttendanceSession>('attendanceSessions', 'courseId', courseIds);
      }
    }

    return list.sort((a, b) => b.sessionDate.localeCompare(a.sessionDate) || b.createdAt.localeCompare(a.createdAt));
  }

  public async listSessionsByCourseIds(courseIds: string[]): Promise<AttendanceSession[]> {
    if (courseIds.length === 0) return [];
    let list: AttendanceSession[];
    if (!this.isFirestoreActive()) {
      const set = new Set(courseIds);
      list = this.state.sessions.filter((s) => set.has(s.courseId));
    } else {
      list = await this.chunkedInQuery<AttendanceSession>('attendanceSessions', 'courseId', courseIds);
    }
    return list.sort((a, b) => b.sessionDate.localeCompare(a.sessionDate) || b.createdAt.localeCompare(a.createdAt));
  }

  public async saveSession(session: AttendanceSession): Promise<void> {
    if (!this.isFirestoreActive()) {
      const idx = this.state.sessions.findIndex((s) => s.id === session.id);
      if (idx >= 0) this.state.sessions[idx] = session;
      else this.state.sessions.unshift(session);
      return;
    }
    await firestoreDb.collection('attendanceSessions').doc(session.id).set(toFirestoreDoc(session));
  }

  // --- Attendance Records ---

  public async getAttendanceRecord(sessionId: string, studentId: string): Promise<AttendanceRecord | null> {
    if (!this.isFirestoreActive()) {
      return this.state.records.find((r) => r.sessionId === sessionId && r.studentId === studentId) || null;
    }
    const snap = await firestoreDb.collection('attendanceRecords').doc(`rec_${sessionId}_${studentId}`).get();
    return snap.exists && snap.data() ? fromFirestoreDoc<AttendanceRecord>(snap.data()!) : null;
  }

  public async listRecordsBySession(sessionId: string): Promise<AttendanceRecord[]> {
    if (!this.isFirestoreActive()) {
      return this.state.records.filter((r) => r.sessionId === sessionId);
    }
    const snap = await firestoreDb.collection('attendanceRecords').where('sessionId', '==', sessionId).get();
    return snap.docs.map((d) => fromFirestoreDoc<AttendanceRecord>(d.data()));
  }

  public async listRecordsBySessionIds(sessionIds: string[]): Promise<AttendanceRecord[]> {
    if (sessionIds.length === 0) return [];
    if (!this.isFirestoreActive()) {
      const set = new Set(sessionIds);
      return this.state.records.filter((r) => set.has(r.sessionId));
    }
    return this.chunkedInQuery<AttendanceRecord>('attendanceRecords', 'sessionId', sessionIds);
  }

  public async listRecordsByStudent(studentId: string, courseId?: string): Promise<AttendanceRecord[]> {
    if (!studentId) return [];
    let list: AttendanceRecord[];
    if (!this.isFirestoreActive()) {
      list = this.state.records.filter((r) => r.studentId === studentId);
    } else {
      const snap = await firestoreDb.collection('attendanceRecords').where('studentId', '==', studentId).get();
      list = snap.docs.map((d) => fromFirestoreDoc<AttendanceRecord>(d.data()));
    }
    if (courseId) {
      list = list.filter((r) => r.courseId === courseId);
    }
    return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // --- Atomic Operations ---

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
      const enrRef = firestoreDb.collection('enrolments').doc(`enr_placeholder`);

      void enrRef; // constructed dynamically after reading session.courseId

      return firestoreDb.runTransaction(async (tx) => {
        const sesSnap = await tx.get(sesRef);
        if (!sesSnap.exists) {
          return { ok: false as const, status: 404, code: 'SESSION_NOT_FOUND', error: 'Attendance session was not found.' };
        }
        const session = fromFirestoreDoc<AttendanceSession>(sesSnap.data()!);
        if (session.status !== 'live') {
          return { ok: false as const, status: 400, code: 'SESSION_CLOSED', error: 'This attendance session is closed.' };
        }

        const courseEnrRef = firestoreDb.collection('enrolments').doc(`enr_${session.courseId}_${student.id}`);
        const [enrSnap, recSnap] = await Promise.all([tx.get(courseEnrRef), tx.get(recRef)]);

        if (!enrSnap.exists || (enrSnap.data() as Enrolment).status !== 'enrolled') {
          return {
            ok: false as const,
            status: 403,
            code: 'NOT_ENROLLED',
            error: `You are not enrolled in ${session.courseCode}. Contact your department if this is incorrect.`,
          };
        }

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

      return firestoreDb.runTransaction(async (tx) => {
        const [sesSnap, recSnap] = await Promise.all([tx.get(sesRef), tx.get(recRef)]);
        if (!sesSnap.exists) {
          return { ok: false as const, status: 400, code: 'SESSION_CLOSED', error: 'This attendance session is closed.' };
        }
        const session = fromFirestoreDoc<AttendanceSession>(sesSnap.data()!);
        if (session.status !== 'live') {
          return { ok: false as const, status: 400, code: 'SESSION_CLOSED', error: 'This attendance session is closed.' };
        }

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

    if (this.isFirestoreActive()) {
      const sesRef = firestoreDb.collection('attendanceSessions').doc(sessionId);
      const recId = `rec_${sessionId}_${student.id}`;
      const recRef = firestoreDb.collection('attendanceRecords').doc(recId);

      return firestoreDb.runTransaction(async (tx) => {
        const [sesSnap, recSnap] = await Promise.all([tx.get(sesRef), tx.get(recRef)]);
        if (!sesSnap.exists) return null;

        const session = fromFirestoreDoc<AttendanceSession>(sesSnap.data()!);
        const nowIso = new Date().toISOString();
        const existingRec = recSnap.exists ? fromFirestoreDoc<AttendanceRecord>(recSnap.data()!) : null;
        const oldStatus = existingRec?.status || (session.status === 'completed' ? 'absent' : 'not_checked_in');

        const updatedRec: AttendanceRecord = existingRec
          ? {
              ...existingRec,
              status: newStatus,
              checkInTime:
                (newStatus === 'present' || newStatus === 'late') && !existingRec.checkInTime
                  ? nowIso
                  : existingRec.checkInTime,
              correctedByUid: actor.uid,
              correctedByName: actor.displayName,
              correctionReason: reason.trim(),
              correctedAt: nowIso,
              updatedAt: nowIso,
            }
          : {
              id: recId,
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

        let presentCount = session.presentCount;
        let lateCount = session.lateCount;
        let absentCount = session.absentCount;

        if (existingRec) {
          if (existingRec.status === 'present') presentCount = Math.max(0, presentCount - 1);
          else if (existingRec.status === 'late') lateCount = Math.max(0, lateCount - 1);
          else if (existingRec.status === 'absent') absentCount = Math.max(0, absentCount - 1);
        } else if (session.status === 'completed') {
          absentCount = Math.max(0, absentCount - 1);
        }

        if (newStatus === 'present') presentCount++;
        else if (newStatus === 'late') lateCount++;
        else if (newStatus === 'absent') absentCount++;

        const updatedSession: AttendanceSession = {
          ...session,
          presentCount,
          lateCount,
          absentCount,
          updatedAt: nowIso,
        };

        tx.set(recRef, toFirestoreDoc(updatedRec));
        tx.set(sesRef, toFirestoreDoc(updatedSession));

        return { record: updatedRec, session: updatedSession, oldStatus };
      });
    }

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

      return { record: rec, session, oldStatus };
    });
  }

  public async closeSessionAtomic(sessionId: string): Promise<AttendanceSession | null> {
    if (this.isFirestoreActive()) {
      const sesRef = firestoreDb.collection('attendanceSessions').doc(sessionId);

      // Atomically prevent new check-ins while closing absent records
      const session = await firestoreDb.runTransaction(async (tx) => {
        const snap = await tx.get(sesRef);
        if (!snap.exists || !snap.data()) return null;
        const cur = fromFirestoreDoc<AttendanceSession>(snap.data()!);
        if (cur.status === 'completed') return cur;
        const closing: AttendanceSession = {
          ...cur,
          status: 'completed',
          checkpointActive: false,
          closedAt: cur.closedAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        tx.set(sesRef, toFirestoreDoc(closing));
        return cur;
      });

      if (!session) return null;
      if (session.status === 'completed') return session;

      const nowIso = new Date().toISOString();
      const hadCheckpoint = Boolean(session.checkpointStartedAt);

      const [courseEnrolments, existingRecords] = await Promise.all([
        this.listEnrolmentsByCourse(session.courseId),
        this.listRecordsBySession(session.id),
      ]);

      const enrolledStudentIds = courseEnrolments.map((e) => e.studentId);
      const enrolledStudents = await this.listStudentsByIds(enrolledStudentIds);
      const studentMap = new Map(enrolledStudents.map((s) => [s.id, s]));
      const existingByStudent = new Map(existingRecords.map((r) => [r.studentId, r]));

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
          dirtyRecords.push(absentRecord);
          absentCount++;
        }
      }

      if (dirtyRecords.length > 0) {
        const ops = dirtyRecords.map((rec) => ({
          ref: firestoreDb.collection('attendanceRecords').doc(rec.id),
          data: toFirestoreDoc(rec),
        }));
        await this.commitChunkedWrites(ops);
      }

      const finalized: AttendanceSession = {
        ...session,
        status: 'completed',
        checkpointActive: false,
        closedAt: nowIso,
        updatedAt: nowIso,
        totalEnrolled: courseEnrolments.length,
        presentCount,
        lateCount,
        absentCount,
        verifiedCount,
      };
      await sesRef.set(toFirestoreDoc(finalized));
      return finalized;
    }

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

      for (const enr of courseEnrolments) {
        const existing = existingByStudent.get(enr.studentId);
        if (existing) {
          if (existing.status === 'present') presentCount++;
          else if (existing.status === 'late') lateCount++;
          else if (existing.status === 'absent') absentCount++;

          if (hadCheckpoint && existing.checkpointStatus === 'none') {
            existing.checkpointStatus = 'missed';
            existing.updatedAt = nowIso;
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

      return session;
    });
  }

  // --- Failed Attempts ---

  public async recordFailedAttempt(params: {
    sessionId: string;
    reason: string;
    code: string;
    actorUid?: string;
    matricNumber?: string;
  }): Promise<number | null> {
    const attempt: FailedAttempt = {
      id: `fail_${crypto.randomBytes(6).toString('hex')}`,
      sessionId: params.sessionId,
      actorUid: params.actorUid,
      matricNumber: params.matricNumber,
      reason: params.reason,
      code: params.code,
      attemptedAt: new Date().toISOString(),
    };

    if (!this.isFirestoreActive()) {
      this.sandboxFailedAttempts.unshift(attempt);
      if (this.sandboxFailedAttempts.length > 500) {
        this.sandboxFailedAttempts.length = 500;
      }
      const session = this.state.sessions.find((s) => s.id === params.sessionId);
      if (!session) return null;
      session.failedAttemptCount = (session.failedAttemptCount || 0) + 1;
      return session.failedAttemptCount;
    }

    await firestoreDb.collection('failedAttempts').doc(attempt.id).set(toFirestoreDoc(attempt));
    const sesRef = firestoreDb.collection('attendanceSessions').doc(params.sessionId);
    try {
      return await firestoreDb.runTransaction(async (tx) => {
        const snap = await tx.get(sesRef);
        if (!snap.exists || !snap.data()) return null;
        const nextCount = Number(snap.get('failedAttemptCount') || 0) + 1;
        tx.update(sesRef, {
          failedAttemptCount: FieldValue.increment(1),
          updatedAt: Timestamp.now(),
        });
        return nextCount;
      });
    } catch {
      return null;
    }
  }

  public async listFailedAttemptsBySession(sessionId: string, limitCount = 20): Promise<FailedAttempt[]> {
    if (!this.isFirestoreActive()) {
      return this.sandboxFailedAttempts.filter((f) => f.sessionId === sessionId).slice(0, limitCount);
    }
    const snap = await firestoreDb
      .collection('failedAttempts')
      .where('sessionId', '==', sessionId)
      .limit(100)
      .get();
    return snap.docs
      .map((d) => fromFirestoreDoc<FailedAttempt>(d.data()))
      .sort((a, b) => b.attemptedAt.localeCompare(a.attemptedAt))
      .slice(0, limitCount);
  }

  // --- Audit Logs (Paginated) ---

  public async addAuditLog(entry: Omit<AuditLog, 'id' | 'createdAt'>): Promise<AuditLog> {
    const log: AuditLog = {
      id: `log_${crypto.randomBytes(6).toString('hex')}`,
      ...entry,
      createdAt: new Date().toISOString(),
    };
    if (!this.isFirestoreActive()) {
      this.state.auditLogs.unshift(log);
      if (this.state.auditLogs.length > 2000) {
        this.state.auditLogs.length = 2000;
      }
      return log;
    }
    await firestoreDb.collection('auditLogs').doc(log.id).set(toFirestoreDoc(log));
    return log;
  }

  public async queryAuditLogsPaginated(params: {
    user: PlatformUser;
    actionFilter?: string;
    page: number;
    pageSize: number;
  }): Promise<PaginatedResult<AuditLog>> {
    const { user, actionFilter = '', page, pageSize } = params;

    if (!this.isFirestoreActive()) {
      let logs = [...this.state.auditLogs];
      if (user.role === 'department_admin') {
        logs = logs.filter((l) => !l.departmentId || l.departmentId === user.departmentId);
      } else if (user.role === 'lecturer') {
        logs = logs.filter((l) => l.actorUid === user.uid);
      }
      if (actionFilter) {
        logs = logs.filter((l) => l.action === actionFilter);
      }
      const total = logs.length;
      const start = (page - 1) * pageSize;
      return {
        items: logs.slice(start, start + pageSize),
        total,
        page,
        pageSize,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      };
    }

    // System admin without action filter uses true DB-level count() + offset/limit pagination
    if (user.role === 'system_admin' && !actionFilter) {
      const col = firestoreDb.collection('auditLogs');
      const [countSnap, pageSnap] = await Promise.all([
        col.count().get(),
        col
          .orderBy('createdAt', 'desc')
          .offset((page - 1) * pageSize)
          .limit(pageSize)
          .get(),
      ]);
      const total = countSnap.data().count;
      return {
        items: pageSnap.docs.map((d) => fromFirestoreDoc<AuditLog>(d.data())),
        total,
        page,
        pageSize,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      };
    }

    // Filtered / scoped queries use single-field Firestore indexes (no composite index needed)
    let logs: AuditLog[] = [];
    if (user.role === 'lecturer') {
      const snap = await firestoreDb.collection('auditLogs').where('actorUid', '==', user.uid).limit(500).get();
      logs = snap.docs.map((d) => fromFirestoreDoc<AuditLog>(d.data()));
    } else if (user.role === 'department_admin') {
      const snap = await firestoreDb
        .collection('auditLogs')
        .where('departmentId', '==', user.departmentId)
        .limit(500)
        .get();
      logs = snap.docs.map((d) => fromFirestoreDoc<AuditLog>(d.data()));
    } else if (actionFilter) {
      const snap = await firestoreDb.collection('auditLogs').where('action', '==', actionFilter).limit(500).get();
      logs = snap.docs.map((d) => fromFirestoreDoc<AuditLog>(d.data()));
    }

    if (actionFilter) {
      logs = logs.filter((l) => l.action === actionFilter);
    }
    logs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const total = logs.length;
    const start = (page - 1) * pageSize;
    return {
      items: logs.slice(start, start + pageSize),
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  // --- Notifications ---

  public async listNotificationsForUser(
    recipientUid: string,
    category?: string,
    limitCount = 50
  ): Promise<AppNotification[]> {
    let list: AppNotification[];
    if (!this.isFirestoreActive()) {
      list = this.state.notifications.filter((n) => n.recipientUid === recipientUid);
    } else {
      const snap = await firestoreDb
        .collection('notifications')
        .where('recipientUid', '==', recipientUid)
        .limit(200)
        .get();
      list = snap.docs.map((d) => fromFirestoreDoc<AppNotification>(d.data()));
    }
    if (category) {
      list = list.filter((n) => (n.category || 'info') === category);
    }
    return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limitCount);
  }

  public async upsertNotifications(list: AppNotification[]): Promise<void> {
    if (list.length === 0) return;

    if (!this.isFirestoreActive()) {
      for (const item of list) {
        if (!this.state.notifications.some((n) => n.id === item.id)) {
          this.state.notifications.unshift(item);
        }
      }
      return;
    }

    // Deduplicate against Firestore so previously read notifications are not overwritten back to unread
    const uniqueById = new Map<string, AppNotification>();
    for (const item of list) {
      if (!uniqueById.has(item.id)) uniqueById.set(item.id, item);
    }
    const candidates = Array.from(uniqueById.values());
    const existing = await this.getDocsByIds<AppNotification>(
      'notifications',
      candidates.map((c) => c.id)
    );
    const existingIds = new Set(existing.map((e) => e.id));
    const toWrite = candidates.filter((c) => !existingIds.has(c.id));

    if (toWrite.length > 0) {
      const ops = toWrite.map((n) => ({
        ref: firestoreDb.collection('notifications').doc(n.id),
        data: toFirestoreDoc(n),
      }));
      await this.commitChunkedWrites(ops);
    }
  }

  public async markNotificationRead(id: string, recipientUid: string): Promise<void> {
    if (!this.isFirestoreActive()) {
      const n = this.state.notifications.find((item) => item.id === id && item.recipientUid === recipientUid);
      if (n && !n.read) n.read = true;
      return;
    }
    const ref = firestoreDb.collection('notifications').doc(id);
    const snap = await ref.get();
    if (!snap.exists || !snap.data()) return;
    const data = snap.data() as AppNotification;
    if (data.recipientUid === recipientUid && !data.read) {
      await ref.update({ read: true });
    }
  }

  public async markAllNotificationsRead(recipientUid: string): Promise<number> {
    if (!this.isFirestoreActive()) {
      const unread = this.state.notifications.filter((n) => n.recipientUid === recipientUid && !n.read);
      for (const n of unread) n.read = true;
      return unread.length;
    }
    const snap = await firestoreDb
      .collection('notifications')
      .where('recipientUid', '==', recipientUid)
      .get();
    const unreadDocs = snap.docs.filter((d) => !(d.data() as AppNotification).read);
    if (unreadDocs.length === 0) return 0;

    const CHUNK = 400;
    for (let i = 0; i < unreadDocs.length; i += CHUNK) {
      const batch = firestoreDb.batch();
      for (const doc of unreadDocs.slice(i, i + CHUNK)) {
        batch.update(doc.ref, { read: true });
      }
      await batch.commit();
    }
    return unreadDocs.length;
  }

  // --- Shared QR Secrets (Authoritative Persistent State) ---

  public async getQrSecret(sessionId: string): Promise<QRSecretDoc | null> {
    if (!this.isFirestoreActive()) {
      return this.sandboxQrSecrets.get(sessionId) || null;
    }
    const snap = await firestoreDb.collection('qrTokenSecrets').doc(sessionId).get();
    return snap.exists && snap.data() ? (snap.data() as QRSecretDoc) : null;
  }

  public async listAllQrSecrets(): Promise<QRSecretDoc[]> {
    if (!this.isFirestoreActive()) {
      return Array.from(this.sandboxQrSecrets.values());
    }
    const snap = await firestoreDb.collection('qrTokenSecrets').get();
    return snap.docs.map((d) => d.data() as QRSecretDoc);
  }

  public async saveQrSecret(doc: QRSecretDoc): Promise<void> {
    if (!this.isFirestoreActive()) {
      this.sandboxQrSecrets.set(doc.sessionId, doc);
      return;
    }
    await firestoreDb.collection('qrTokenSecrets').doc(doc.sessionId).set(stripUndefined({ ...doc }));
  }

  public async deleteQrSecret(sessionId: string): Promise<void> {
    if (!this.isFirestoreActive()) {
      this.sandboxQrSecrets.delete(sessionId);
      return;
    }
    await firestoreDb.collection('qrTokenSecrets').doc(sessionId).delete().catch(() => {});
  }

  public async mutateQrSecretAtomic(
    sessionId: string,
    mutator: (current: QRSecretDoc | null) => { next: QRSecretDoc; changed: boolean } | null
  ): Promise<{ doc: QRSecretDoc | null; changed: boolean }> {
    if (!this.isFirestoreActive()) {
      return this.withLock(`qr_secret:${sessionId}`, () => {
        const cur = this.sandboxQrSecrets.get(sessionId) || null;
        const res = mutator(cur ? structuredClone(cur) : null);
        if (!res) return { doc: cur, changed: false };
        if (res.changed) {
          this.sandboxQrSecrets.set(sessionId, res.next);
        }
        return { doc: res.next, changed: res.changed };
      });
    }

    const ref = firestoreDb.collection('qrTokenSecrets').doc(sessionId);
    return firestoreDb.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const cur = snap.exists && snap.data() ? (snap.data() as QRSecretDoc) : null;
      const res = mutator(cur ? structuredClone(cur) : null);
      if (!res) return { doc: cur, changed: false };
      if (res.changed) {
        tx.set(ref, stripUndefined({ ...res.next }));
      }
      return { doc: res.next, changed: res.changed };
    });
  }
}

export const db = new DatabaseManager();

export function requirePersistentDatabase(_req: Request, res: Response, next: NextFunction) {
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
