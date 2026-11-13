import crypto from 'node:crypto';
import express, { type Express, type Response } from 'express';
import type {
  AppNotification,
  AttendanceRecord,
  AttendanceSession,
  AttendanceStatus,
  Course,
  CourseTimetableSlot,
  LateCountPolicy,
  StudentLevel,
  StudentRecord,
  UserRole,
} from '../types/lasu.ts';
import {
  calculateOverallStudentStanding,
  calculateSessionEffectiveRate,
  calculateStudentCourseAttendance,
  getLatePolicyDescription,
  getLateWeight,
} from './attendanceMath.ts';
import {
  canAccessDepartment,
  checkRateLimit,
  requireAuth,
  requireRole,
  signDemoToken,
  type RequestWithAuth,
} from './auth.ts';
import { db, DEMO_MODE_ENABLED, requirePersistentDatabase } from './db.ts';
import { firebaseAdminStatus } from './firebaseAdmin.ts';
import { buildCourseMilestoneNotifications, buildUpcomingClassNotifications } from './notifications.ts';
import { computeExportSummary, streamAttendancePdfReport } from './pdfExport.ts';
import { GRACE_PERIOD_SECONDS, qrEngine, ROTATION_INTERVAL_SECONDS } from './qrEngine.ts';

function uid(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function recordFailedAttempt(
  sessionId: string,
  reason: string,
  code: string,
  actorUid?: string,
  matricNumber?: string
) {
  db.failedAttempts.unshift({
    id: uid('fail'),
    sessionId,
    actorUid,
    matricNumber,
    reason,
    code,
    attemptedAt: new Date().toISOString(),
  });
  if (db.failedAttempts.length > 500) {
    db.failedAttempts.length = 500;
  }
  const session = db.state.sessions.find((s) => s.id === sessionId);
  if (session) {
    session.failedAttemptCount = (session.failedAttemptCount || 0) + 1;
    qrEngine.broadcast(sessionId, {
      type: 'attendance:failed_attempt',
      sessionId,
      failedAttemptCount: session.failedAttemptCount,
    });
  }
}

function escapeCsv(val: string | number | undefined): string {
  const str = String(val ?? '');
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function sanitizeTimetableSlots(rawSlots?: unknown): CourseTimetableSlot[] {
  if (!Array.isArray(rawSlots)) return [];
  const validDays = new Set(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);
  const out: CourseTimetableSlot[] = [];
  for (const item of rawSlots) {
    if (!item || typeof item !== 'object') continue;
    const slot = item as Record<string, unknown>;
    const dayOfWeek = String(slot.dayOfWeek || '');
    const startTime = String(slot.startTime || '').trim();
    const endTime = String(slot.endTime || '').trim();
    const venue = String(slot.venue || '').trim();
    if (!validDays.has(dayOfWeek) || !startTime || !venue) continue;
    out.push({
      dayOfWeek: dayOfWeek as CourseTimetableSlot['dayOfWeek'],
      startTime,
      endTime: endTime || startTime,
      venue: venue.slice(0, 120),
    });
    if (out.length >= 10) break;
  }
  return out;
}

async function syncStudentNotifications(student: StudentRecord) {
  if (!student.claimedUid) return;
  const enrolments = db.state.enrolments.filter((e) => e.studentId === student.id && e.status === 'enrolled');
  const courseMap = new Map(db.state.courses.map((c) => [c.id, c]));
  const enrolledCourses = enrolments.map((e) => courseMap.get(e.courseId)).filter((c): c is Course => Boolean(c));
  const enrolledCourseIds = new Set(enrolledCourses.map((c) => c.id));
  const studentSessions = db.state.sessions.filter((s) => enrolledCourseIds.has(s.courseId));
  const studentRecords = db.state.records.filter((r) => r.studentId === student.id);

  const upcoming = buildUpcomingClassNotifications({
    student,
    courses: enrolledCourses,
    sessions: studentSessions,
  });

  const milestones: AppNotification[] = [];
  for (const enr of enrolments) {
    const crs = courseMap.get(enr.courseId);
    if (!crs) continue;
    milestones.push(
      ...buildCourseMilestoneNotifications({
        student,
        enrolment: enr,
        course: crs,
        sessions: db.state.sessions,
        records: studentRecords,
        settings: db.state.institutionSettings,
      })
    );
  }

  await db.upsertNotifications([...upcoming, ...milestones]);
}

async function evaluateCourseMilestonesForSession(courseId: string) {
  const course = db.state.courses.find((c) => c.id === courseId);
  if (!course) return;
  const enrolments = db.state.enrolments.filter((e) => e.courseId === courseId && e.status === 'enrolled');
  const studentMap = new Map(db.state.students.map((s) => [s.id, s]));
  const toCreate: AppNotification[] = [];

  for (const enr of enrolments) {
    const student = studentMap.get(enr.studentId);
    if (!student || !student.claimedUid) continue;
    // Skip synthetic non-signed-in placeholder accounts during bulk closure unless primary/real user
    if (student.claimedUid.startsWith('demo_student_uid_')) continue;
    const records = db.state.records.filter((r) => r.studentId === student.id && r.courseId === courseId);
    toCreate.push(
      ...buildCourseMilestoneNotifications({
        student,
        enrolment: enr,
        course,
        sessions: db.state.sessions,
        records,
        settings: db.state.institutionSettings,
      })
    );
  }
  await db.upsertNotifications(toCreate);
}

export function registerApiRoutes(app: Express) {
  const router = express.Router();

  // Health & System Status (Always reachable even if Firestore Admin isn't configured yet)
  router.get('/health', (_req, res) => {
    res.json({ ok: true, time: new Date().toISOString() });
  });

  router.get('/system/status', (_req, res) => {
    res.json({
      demoModeEnabled: DEMO_MODE_ENABLED,
      firebaseProjectId: firebaseAdminStatus.projectId,
      firestoreDatabaseId: firebaseAdminStatus.firestoreDatabaseId,
      hasServiceAccount: firebaseAdminStatus.hasServiceAccount,
      firebaseAdminConnected: firebaseAdminStatus.firestoreAdminConnected,
      storageMode: firebaseAdminStatus.storageMode,
      firestoreError: firebaseAdminStatus.firestoreAdminConnected ? null : firebaseAdminStatus.lastError,
    });
  });

  // Require persistent Firestore (or explicit non-production dev sandbox) for all operational routes
  router.use(requirePersistentDatabase);

  // Auth: Session Resolution for Firebase Auth users
  router.post('/auth/session', requireAuth, (req: RequestWithAuth, res: Response) => {
    const ctx = req.authContext!;
    const pendingStudent = ctx.user?.studentId
      ? db.state.students.find((s) => s.id === ctx.user!.studentId)
      : undefined;

    res.json({
      authenticated: true,
      uid: ctx.uid,
      email: ctx.email,
      emailVerified: ctx.emailVerified,
      displayName: ctx.displayName,
      isDemoToken: ctx.isDemoToken,
      user: ctx.user,
      studentProfile: pendingStudent ?? null,
      needsActivation: !ctx.user || ctx.user.status === 'pending',
    });
  });

  // Demo Mode Login (only when DEMO_MODE_ENABLED)
  router.post('/auth/demo-login', (req, res) => {
    if (!DEMO_MODE_ENABLED) {
      res.status(403).json({ error: 'Demo mode is disabled in this environment.' });
      return;
    }
    const { uid: targetUid } = req.body as { uid?: string };
    const demoUser = db.state.users.find((u) => u.uid === targetUid && u.isDemo);
    if (!demoUser) {
      res.status(404).json({ error: 'Demo account not found.' });
      return;
    }
    const token = signDemoToken(demoUser.uid);
    const studentProfile = demoUser.studentId
      ? db.state.students.find((s) => s.id === demoUser.studentId) ?? null
      : null;

    res.json({
      token,
      user: demoUser,
      studentProfile,
      isDemo: true,
    });
  });

  router.get('/auth/demo-accounts', (_req, res) => {
    if (!DEMO_MODE_ENABLED) {
      res.json({ enabled: false, accounts: [] });
      return;
    }
    const accounts = db.state.users
      .filter((u) => u.isDemo)
      .map((u) => ({
        uid: u.uid,
        displayName: u.displayName,
        email: u.email,
        role: u.role,
        departmentName: u.departmentName,
        matricNumber: u.matricNumber,
      }));
    res.json({ enabled: true, accounts });
  });

  // Student Account Activation using Official Register + Admin-Issued Activation Code
  router.post('/auth/activate-student', requireAuth, async (req: RequestWithAuth, res: Response) => {
    const ctx = req.authContext!;
    const ip = req.ip || 'unknown';
    if (!checkRateLimit(`activate:${ip}:${ctx.uid}`, 10, 10 * 60 * 1000)) {
      res.status(429).json({ error: 'Too many activation attempts. Please wait a few minutes and try again.' });
      return;
    }

    const { matricNumber, activationCode } = req.body as { matricNumber?: string; activationCode?: string };
    const cleanMatric = (matricNumber || '').trim().toUpperCase();
    const cleanCode = (activationCode || '').trim().toUpperCase();

    if (!cleanMatric || !cleanCode) {
      res.status(400).json({ error: 'Both matriculation number and activation code are required.' });
      return;
    }

    await db.withLock(`activate:${cleanMatric}`, async () => {
      const student = db.state.students.find((s) => s.matricNumber.toUpperCase() === cleanMatric);
      if (!student) {
        res.status(404).json({ error: 'Matriculation number was not found on the official student register.' });
        return;
      }
      if (student.accountStatus === 'suspended') {
        res.status(403).json({ error: 'This student account is currently suspended. Contact your department.' });
        return;
      }
      if (student.claimedUid && student.claimedUid !== ctx.uid) {
        res.status(409).json({
          error:
            'This matriculation number has already been activated by another account. Contact your department administrator if this is an error.',
        });
        return;
      }
      if (!student.activationCode || student.activationCode.toUpperCase() !== cleanCode) {
        res.status(403).json({ error: 'Invalid activation code. Verify the code issued by your department.' });
        return;
      }

      const now = new Date().toISOString();
      student.accountStatus = 'active';
      student.claimedUid = ctx.uid;
      student.email = ctx.email || student.email;
      student.activationCode = undefined;
      student.updatedAt = now;

      const linkedEnrolments = db.state.enrolments.filter((e) => e.studentId === student.id);
      for (const enr of linkedEnrolments) enr.studentUid = ctx.uid;

      const linkedRecords = db.state.records.filter((r) => r.studentId === student.id);
      for (const rec of linkedRecords) rec.studentUid = ctx.uid;

      let user = db.state.users.find((u) => u.uid === ctx.uid);
      if (!user) {
        user = {
          uid: ctx.uid,
          email: ctx.email,
          displayName: student.fullName,
          role: 'student',
          departmentId: student.departmentId,
          departmentName: student.departmentName,
          facultyName: student.facultyName,
          status: 'active',
          studentId: student.id,
          matricNumber: student.matricNumber,
          isDemo: student.isDemo,
          createdAt: now,
          updatedAt: now,
        };
      } else {
        user.role = 'student';
        user.status = 'active';
        user.studentId = student.id;
        user.matricNumber = student.matricNumber;
        user.departmentId = student.departmentId;
        user.departmentName = student.departmentName;
        user.facultyName = student.facultyName;
        user.displayName = student.fullName;
        user.updatedAt = now;
      }

      try {
        await db.activateStudentAtomic({ student, user, linkedEnrolments, linkedRecords });
      } catch (err) {
        if (err instanceof Error && err.message === 'ALREADY_CLAIMED_BY_ANOTHER') {
          res.status(409).json({ error: 'This matriculation number has already been activated by another account.' });
          return;
        }
        throw err;
      }

      await db.addAuditLog({
        actorUid: ctx.uid,
        actorName: student.fullName,
        actorRole: 'student',
        action: 'STUDENT_ACCOUNT_ACTIVATED',
        targetType: 'student',
        targetId: student.id,
        details: `Student ${student.matricNumber} activated account via official register verification.`,
        departmentId: student.departmentId,
      });

      res.json({ user, studentProfile: student });
    });
  });

  // Institution Settings (Late Policy & Thresholds)
  router.get('/settings/institution', requireAuth, (_req, res) => {
    const settings = db.state.institutionSettings;
    res.json({
      ...settings,
      latePolicyDescription: getLatePolicyDescription(settings.lateCountPolicy),
    });
  });

  router.patch(
    '/settings/institution',
    requireAuth,
    requireRole(['system_admin']),
    async (req: RequestWithAuth, res: Response) => {
      const actor = req.authContext!.user!;
      const { lateCountPolicy, attendanceThreshold, milestonePercentages } = req.body as {
        lateCountPolicy?: LateCountPolicy;
        attendanceThreshold?: number;
        milestonePercentages?: number[];
      };

      const current = db.state.institutionSettings;
      const validPolicies = new Set<LateCountPolicy>(['count_as_attended', 'count_as_half', 'count_as_absent']);
      const nextPolicy =
        lateCountPolicy && validPolicies.has(lateCountPolicy) ? lateCountPolicy : current.lateCountPolicy;
      const nextThreshold =
        typeof attendanceThreshold === 'number' && attendanceThreshold >= 10 && attendanceThreshold <= 100
          ? Math.round(attendanceThreshold)
          : current.attendanceThreshold;
      const nextMilestones =
        Array.isArray(milestonePercentages) && milestonePercentages.length > 0
          ? Array.from(
              new Set(
                milestonePercentages
                  .map((n) => Math.round(Number(n)))
                  .filter((n) => Number.isFinite(n) && n >= 10 && n <= 100)
              )
            ).sort((a, b) => a - b)
          : current.milestonePercentages;

      const updated = {
        ...current,
        lateCountPolicy: nextPolicy,
        attendanceThreshold: nextThreshold,
        milestonePercentages: nextMilestones.length > 0 ? nextMilestones : [50, 75, 90, 100],
        updatedAt: new Date().toISOString(),
        updatedByUid: actor.uid,
      };

      await db.saveInstitutionSettings(updated);
      await db.addAuditLog({
        actorUid: actor.uid,
        actorName: actor.displayName,
        actorRole: actor.role,
        action: 'INSTITUTION_SETTINGS_UPDATED',
        targetType: 'institution_settings',
        targetId: updated.id,
        details: `Updated late policy to "${updated.lateCountPolicy}" and threshold to ${updated.attendanceThreshold}%.`,
      });

      res.json({
        ...updated,
        latePolicyDescription: getLatePolicyDescription(updated.lateCountPolicy),
      });
    }
  );

  // Lecturer Overview Dashboard
  router.get(
    '/dashboard/lecturer',
    requireAuth,
    requireRole(['lecturer', 'department_admin', 'system_admin']),
    (req: RequestWithAuth, res: Response) => {
      const user = req.authContext!.user!;
      const settings = db.state.institutionSettings;
      const lateWeight = getLateWeight(settings.lateCountPolicy);

      const myCourses =
        user.role === 'system_admin'
          ? db.state.courses
          : user.role === 'department_admin'
            ? db.state.courses.filter((c) => c.departmentId === user.departmentId)
            : db.state.courses.filter((c) => c.lecturerUid === user.uid);

      const courseIds = new Set(myCourses.map((c) => c.id));
      const mySessions = db.state.sessions
        .filter((s) => courseIds.has(s.courseId))
        .sort((a, b) => b.sessionDate.localeCompare(a.sessionDate) || b.createdAt.localeCompare(a.createdAt));

      const completedSessions = mySessions.filter((s) => s.status === 'completed');
      const liveSessions = mySessions.filter((s) => s.status === 'live');

      const uniqueEnrolledStudents = new Set<string>();
      for (const enr of db.state.enrolments) {
        if (courseIds.has(enr.courseId) && enr.status === 'enrolled') {
          uniqueEnrolledStudents.add(enr.studentId);
        }
      }

      let totalEffective = 0;
      let totalExpected = 0;
      let totalPresent = 0;
      let totalLate = 0;
      let totalAbsent = 0;

      for (const s of completedSessions) {
        totalPresent += s.presentCount;
        totalLate += s.lateCount;
        totalAbsent += s.absentCount;
        totalEffective += s.presentCount + s.lateCount * lateWeight;
        totalExpected += s.totalEnrolled;
      }

      const avgAttendanceRate =
        totalExpected > 0 ? Math.round((totalEffective / totalExpected) * 1000) / 10 : 0;

      let attendanceDelta: number | null = null;
      if (completedSessions.length >= 2) {
        const latestRate = calculateSessionEffectiveRate(completedSessions[0], settings.lateCountPolicy);
        const prevRate = calculateSessionEffectiveRate(completedSessions[1], settings.lateCountPolicy);
        attendanceDelta = Math.round((latestRate - prevRate) * 10) / 10;
      }

      const studentStats = new Map<
        string,
        {
          studentId: string;
          studentName: string;
          matricNumber: string;
          effective: number;
          attended: number;
          total: number;
          courses: Set<string>;
        }
      >();
      const completedSessionIds = new Set(completedSessions.map((s) => s.id));
      const sessionCourseCode = new Map(completedSessions.map((s) => [s.id, s.courseCode]));

      for (const rec of db.state.records) {
        if (!completedSessionIds.has(rec.sessionId)) continue;
        let entry = studentStats.get(rec.studentId);
        if (!entry) {
          entry = {
            studentId: rec.studentId,
            studentName: rec.studentName,
            matricNumber: rec.matricNumber,
            effective: 0,
            attended: 0,
            total: 0,
            courses: new Set(),
          };
          studentStats.set(rec.studentId, entry);
        }
        if (rec.status === 'excused') continue;
        entry.total++;
        if (rec.status === 'present') {
          entry.attended++;
          entry.effective += 1;
        } else if (rec.status === 'late') {
          if (lateWeight > 0) entry.attended++;
          entry.effective += lateWeight;
        }
        const cc = sessionCourseCode.get(rec.sessionId);
        if (cc) entry.courses.add(cc);
      }

      const atRiskStudents = Array.from(studentStats.values())
        .map((st) => ({
          studentId: st.studentId,
          studentName: st.studentName,
          matricNumber: st.matricNumber,
          attended: st.attended,
          total: st.total,
          rate: st.total > 0 ? Math.round((st.effective / st.total) * 100) : 0,
          courses: Array.from(st.courses),
        }))
        .filter((st) => st.total >= 2 && st.rate < settings.attendanceThreshold)
        .sort((a, b) => a.rate - b.rate || a.matricNumber.localeCompare(b.matricNumber));

      const trendSeries = [...completedSessions]
        .slice(0, 10)
        .reverse()
        .map((s) => ({
          sessionId: s.id,
          label: `${s.courseCode} · ${s.sessionDate.slice(5)}`,
          courseCode: s.courseCode,
          date: s.sessionDate,
          rate: calculateSessionEffectiveRate(s, settings.lateCountPolicy),
          present: s.presentCount,
          late: s.lateCount,
          absent: s.absentCount,
        }));

      const courseBreakdown = myCourses.map((c) => {
        const cSessions = completedSessions.filter((s) => s.courseId === c.id);
        const exp = cSessions.reduce((acc, s) => acc + s.totalEnrolled, 0);
        const eff = cSessions.reduce((acc, s) => acc + s.presentCount + s.lateCount * lateWeight, 0);
        return {
          courseId: c.id,
          courseCode: c.courseCode,
          courseTitle: c.courseTitle,
          enrolledCount: c.enrolledCount,
          sessionsHeld: cSessions.length,
          averageRate: exp > 0 ? Math.round((eff / exp) * 1000) / 10 : 0,
        };
      });

      res.json({
        summary: {
          totalEnrolled: uniqueEnrolledStudents.size,
          averageAttendanceRate: avgAttendanceRate,
          attendanceDelta,
          totalSessionsHeld: completedSessions.length,
          liveSessionCount: liveSessions.length,
          studentsRequiringAttention: atRiskStudents.length,
          attendanceThreshold: settings.attendanceThreshold,
          lateCountPolicy: settings.lateCountPolicy,
        },
        distribution: [
          { name: 'Present', value: totalPresent, color: '#16845B' },
          { name: 'Late', value: totalLate, color: '#D99020' },
          { name: 'Absent', value: totalAbsent, color: '#D84A4A' },
        ],
        trendSeries,
        courseBreakdown,
        recentSessions: mySessions.slice(0, 8),
        atRiskStudents: atRiskStudents.slice(0, 8),
        liveSessions,
        courses: myCourses,
        onboardingChecklist: {
          hasCourse: myCourses.length > 0,
          hasEnrolments: uniqueEnrolledStudents.size > 0,
          hasSession: mySessions.length > 0,
          hasCompletedReport: completedSessions.length > 0,
        },
      });
    }
  );

  // Student Dashboard (strictly personal data only, Phase 3 accurate math + Phase 6 notification sync)
  router.get(
    '/dashboard/student',
    requireAuth,
    requireRole(['student']),
    async (req: RequestWithAuth, res: Response) => {
      const user = req.authContext!.user!;
      const student = db.state.students.find((s) => s.id === user.studentId || s.claimedUid === user.uid);
      if (!student) {
        res.status(404).json({ error: 'Student profile not found.' });
        return;
      }

      // Sync upcoming classes & deduplicated milestones cleanly
      await syncStudentNotifications(student);

      const settings = db.state.institutionSettings;
      const myEnrolments = db.state.enrolments.filter((e) => e.studentId === student.id && e.status === 'enrolled');
      const courseMap = new Map(db.state.courses.map((c) => [c.id, c]));
      const myCourseIds = new Set(myEnrolments.map((e) => e.courseId));

      const myRecords = db.state.records
        .filter((r) => r.studentId === student.id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

      const courseSummaries = myEnrolments
        .map((enr) => {
          const c = courseMap.get(enr.courseId);
          if (!c) return null;
          return calculateStudentCourseAttendance({
            studentId: student.id,
            enrolment: enr,
            course: c,
            sessions: db.state.sessions,
            records: myRecords,
            settings,
          });
        })
        .filter((item): item is NonNullable<typeof item> => item !== null);

      const standing = calculateOverallStudentStanding(courseSummaries, settings);
      const sessionMap = new Map(db.state.sessions.map((s) => [s.id, s]));

      const enrichedHistory = myRecords.map((r) => {
        const ses = sessionMap.get(r.sessionId);
        const crs = courseMap.get(r.courseId);
        return {
          ...r,
          courseCode: crs?.courseCode || ses?.courseCode || 'COURSE',
          courseTitle: crs?.courseTitle || ses?.courseTitle || '',
          lectureTitle: ses?.lectureTitle || '',
          venue: ses?.venue || '',
          sessionDate: ses?.sessionDate || r.createdAt.slice(0, 10),
          startTime: ses?.startTime || '',
        };
      });

      const missedSessions = enrichedHistory.filter((r) => r.status === 'absent');
      const liveCoursesSessions = db.state.sessions.filter(
        (s) => myCourseIds.has(s.courseId) && s.status === 'live'
      );

      res.json({
        student,
        lateCountPolicy: settings.lateCountPolicy,
        latePolicyDescription: getLatePolicyDescription(settings.lateCountPolicy),
        attendanceThreshold: settings.attendanceThreshold,
        overallPercentage: standing.overallPercentage,
        attendedTotal: standing.attendedTotal,
        presentTotal: standing.presentTotal,
        lateTotal: standing.lateTotal,
        totalCompletedSessions: standing.totalEligibleSessions,
        missedCount: standing.missedTotal,
        courses: courseSummaries,
        recentRecords: enrichedHistory.slice(0, 15),
        allRecords: enrichedHistory,
        missedSessions,
        liveSessions: liveCoursesSessions,
      });
    }
  );

  // Administrator Overview Dashboard (with rich chart data for Phase 4)
  router.get(
    '/dashboard/admin',
    requireAuth,
    requireRole(['system_admin', 'department_admin']),
    (req: RequestWithAuth, res: Response) => {
      const user = req.authContext!.user!;
      const settings = db.state.institutionSettings;
      const lateWeight = getLateWeight(settings.lateCountPolicy);
      const isSystem = user.role === 'system_admin';
      const scopedDepts = isSystem
        ? db.state.departments
        : db.state.departments.filter((d) => d.id === user.departmentId);
      const scopedDeptIds = new Set(scopedDepts.map((d) => d.id));

      const scopedStudents = db.state.students.filter((s) => scopedDeptIds.has(s.departmentId));
      const scopedCourses = db.state.courses.filter((c) => scopedDeptIds.has(c.departmentId));
      const scopedSessions = db.state.sessions.filter((s) => scopedDeptIds.has(s.departmentId));
      const completedSessions = scopedSessions
        .filter((s) => s.status === 'completed')
        .sort((a, b) => a.sessionDate.localeCompare(b.sessionDate));

      const totalExpected = completedSessions.reduce((a, s) => a + s.totalEnrolled, 0);
      const totalEffective = completedSessions.reduce(
        (a, s) => a + s.presentCount + s.lateCount * lateWeight,
        0
      );
      const totalPresent = completedSessions.reduce((a, s) => a + s.presentCount, 0);
      const totalLate = completedSessions.reduce((a, s) => a + s.lateCount, 0);
      const totalAbsent = completedSessions.reduce((a, s) => a + s.absentCount, 0);
      const avgRate = totalExpected > 0 ? Math.round((totalEffective / totalExpected) * 1000) / 10 : 0;

      const departmentStats = scopedDepts.map((d) => {
        const dStudents = scopedStudents.filter((s) => s.departmentId === d.id);
        const dCourses = scopedCourses.filter((c) => c.departmentId === d.id);
        const dSessions = completedSessions.filter((s) => s.departmentId === d.id);
        const dExp = dSessions.reduce((a, s) => a + s.totalEnrolled, 0);
        const dEff = dSessions.reduce((a, s) => a + s.presentCount + s.lateCount * lateWeight, 0);
        return {
          departmentId: d.id,
          code: d.code,
          name: d.name,
          facultyName: d.facultyName,
          studentCount: dStudents.length,
          activeStudentCount: dStudents.filter((s) => s.accountStatus === 'active').length,
          courseCount: dCourses.length,
          sessionsHeld: dSessions.length,
          averageRate: dExp > 0 ? Math.round((dEff / dExp) * 1000) / 10 : 0,
        };
      });

      const sessionTrendSeries = completedSessions.slice(-12).map((s) => ({
        sessionId: s.id,
        label: `${s.courseCode} · ${s.sessionDate.slice(5)}`,
        date: s.sessionDate,
        rate: calculateSessionEffectiveRate(s, settings.lateCountPolicy),
        present: s.presentCount,
        late: s.lateCount,
        absent: s.absentCount,
      }));

      const lecturers = db.state.users.filter(
        (u) => (u.role === 'lecturer' || u.role === 'department_admin') && scopedDeptIds.has(u.departmentId)
      );

      res.json({
        scope: isSystem ? 'institution' : 'department',
        summary: {
          totalStudents: scopedStudents.length,
          activeStudents: scopedStudents.filter((s) => s.accountStatus === 'active').length,
          pendingStudents: scopedStudents.filter((s) => s.accountStatus === 'pending_activation').length,
          totalCourses: scopedCourses.length,
          totalLecturers: lecturers.length,
          totalSessionsHeld: completedSessions.length,
          liveSessions: scopedSessions.filter((s) => s.status === 'live').length,
          averageAttendanceRate: avgRate,
        },
        distribution: [
          { name: 'Present', value: totalPresent, color: '#16845B' },
          { name: 'Late', value: totalLate, color: '#D99020' },
          { name: 'Absent', value: totalAbsent, color: '#D84A4A' },
        ],
        sessionTrendSeries,
        departmentStats,
        recentSessions: [...scopedSessions]
          .sort((a, b) => b.sessionDate.localeCompare(a.sessionDate))
          .slice(0, 8),
        recentAuditLogs: db.state.auditLogs
          .filter((l) => isSystem || !l.departmentId || scopedDeptIds.has(l.departmentId))
          .slice(0, 10),
      });
    }
  );

  // Departments
  router.get('/departments', requireAuth, (req: RequestWithAuth, res: Response) => {
    const user = req.authContext!.user;
    if (user?.role === 'department_admin') {
      res.json(db.state.departments.filter((d) => d.id === user.departmentId));
      return;
    }
    res.json(db.state.departments);
  });

  router.post(
    '/departments',
    requireAuth,
    requireRole(['system_admin']),
    async (req: RequestWithAuth, res: Response) => {
      const user = req.authContext!.user!;
      const { name, code, facultyName } = req.body as { name?: string; code?: string; facultyName?: string };
      if (!name || !code || !facultyName) {
        res.status(400).json({ error: 'Department name, code, and faculty name are required.' });
        return;
      }
      const cleanCode = code.trim().toUpperCase();
      if (db.state.departments.some((d) => d.code === cleanCode)) {
        res.status(409).json({ error: 'A department with this code already exists.' });
        return;
      }
      const dept = {
        id: `dept_${cleanCode.toLowerCase().replace(/[^a-z0-9]/g, '')}`,
        institutionId: 'inst_lasu',
        facultyName: facultyName.trim(),
        name: name.trim(),
        code: cleanCode,
        status: 'active' as const,
        createdAt: new Date().toISOString(),
      };
      await db.saveDepartment(dept);
      await db.addAuditLog({
        actorUid: user.uid,
        actorName: user.displayName,
        actorRole: user.role,
        action: 'DEPARTMENT_CREATED',
        targetType: 'department',
        targetId: dept.id,
        details: `Created department ${dept.code} (${dept.name}).`,
        departmentId: dept.id,
      });
      res.status(201).json(dept);
    }
  );

  // Courses
  router.get('/courses', requireAuth, (req: RequestWithAuth, res: Response) => {
    const user = req.authContext!.user;
    if (!user) {
      res.json([]);
      return;
    }
    let list: Course[] = [];
    if (user.role === 'system_admin') {
      list = db.state.courses;
    } else if (user.role === 'department_admin') {
      list = db.state.courses.filter((c) => c.departmentId === user.departmentId);
    } else if (user.role === 'lecturer') {
      list = db.state.courses.filter((c) => c.lecturerUid === user.uid);
    } else {
      const enrCourseIds = new Set(
        db.state.enrolments
          .filter((e) => e.studentId === user.studentId && e.status === 'enrolled')
          .map((e) => e.courseId)
      );
      list = db.state.courses.filter((c) => enrCourseIds.has(c.id));
    }
    res.json(list);
  });

  router.post(
    '/courses',
    requireAuth,
    requireRole(['system_admin', 'department_admin', 'lecturer']),
    async (req: RequestWithAuth, res: Response) => {
      const user = req.authContext!.user!;
      const { courseCode, courseTitle, departmentId, level, semester, lecturerUid, timetableSlots } = req.body as {
        courseCode?: string;
        courseTitle?: string;
        departmentId?: string;
        level?: StudentLevel;
        semester?: string;
        lecturerUid?: string;
        timetableSlots?: CourseTimetableSlot[];
      };

      if (!courseCode || !courseTitle || !departmentId) {
        res.status(400).json({ error: 'Course code, title, and department are required.' });
        return;
      }

      if (user.role === 'department_admin' && departmentId !== user.departmentId) {
        res.status(403).json({ error: 'You can only create courses in your assigned department.' });
        return;
      }

      const dept = db.state.departments.find((d) => d.id === departmentId);
      if (!dept) {
        res.status(404).json({ error: 'Department not found.' });
        return;
      }

      const assignedLecturerUid = user.role === 'lecturer' ? user.uid : lecturerUid || user.uid;
      const lecturer = db.state.users.find((u) => u.uid === assignedLecturerUid) || user;
      const cleanSlots = sanitizeTimetableSlots(timetableSlots);

      const now = new Date().toISOString();
      const course: Course = {
        id: uid('crs'),
        institutionId: 'inst_lasu',
        departmentId: dept.id,
        departmentName: dept.name,
        courseCode: courseCode.trim().toUpperCase(),
        courseTitle: courseTitle.trim(),
        level: level || '200L',
        semester: (semester || '2025/2026 Rain Semester').trim(),
        lecturerUid: lecturer.uid,
        lecturerName: lecturer.displayName,
        status: 'active',
        enrolledCount: 0,
        timetableSlots: cleanSlots.length > 0 ? cleanSlots : undefined,
        isDemo: user.isDemo,
        createdAt: now,
        updatedAt: now,
      };
      await db.saveCourse(course);
      await db.addAuditLog({
        actorUid: user.uid,
        actorName: user.displayName,
        actorRole: user.role,
        action: 'COURSE_CREATED',
        targetType: 'course',
        targetId: course.id,
        details: `Created course ${course.courseCode} - ${course.courseTitle}.`,
        departmentId: course.departmentId,
      });
      res.status(201).json(course);
    }
  );

  router.patch(
    '/courses/:id',
    requireAuth,
    requireRole(['system_admin', 'department_admin', 'lecturer']),
    async (req: RequestWithAuth, res: Response) => {
      const user = req.authContext!.user!;
      const course = db.state.courses.find((c) => c.id === req.params.id);
      if (!course) {
        res.status(404).json({ error: 'Course not found.' });
        return;
      }
      if (user.role === 'lecturer' && course.lecturerUid !== user.uid) {
        res.status(403).json({ error: 'You can only update your own courses.' });
        return;
      }
      if (user.role === 'department_admin' && !canAccessDepartment(user, course.departmentId)) {
        res.status(403).json({ error: 'Access denied for another department.' });
        return;
      }

      const { courseTitle, semester, timetableSlots, status } = req.body as {
        courseTitle?: string;
        semester?: string;
        timetableSlots?: CourseTimetableSlot[];
        status?: 'active' | 'archived';
      };

      if (courseTitle && courseTitle.trim().length >= 3) course.courseTitle = courseTitle.trim();
      if (semester && semester.trim().length >= 2) course.semester = semester.trim();
      if (status === 'active' || status === 'archived') course.status = status;
      if (timetableSlots !== undefined) {
        const cleanSlots = sanitizeTimetableSlots(timetableSlots);
        course.timetableSlots = cleanSlots;
      }
      course.updatedAt = new Date().toISOString();

      await db.saveCourse(course);
      await db.addAuditLog({
        actorUid: user.uid,
        actorName: user.displayName,
        actorRole: user.role,
        action: 'COURSE_UPDATED',
        targetType: 'course',
        targetId: course.id,
        details: `Updated course ${course.courseCode} schedule/details.`,
        departmentId: course.departmentId,
      });
      res.json(course);
    }
  );

  router.post(
    '/courses/:id/enrol',
    requireAuth,
    requireRole(['system_admin', 'department_admin', 'lecturer']),
    async (req: RequestWithAuth, res: Response) => {
      const user = req.authContext!.user!;
      const course = db.state.courses.find((c) => c.id === req.params.id);
      if (!course) {
        res.status(404).json({ error: 'Course not found.' });
        return;
      }
      if (user.role === 'lecturer' && course.lecturerUid !== user.uid) {
        res.status(403).json({ error: 'You can only manage enrolments for your own courses.' });
        return;
      }
      if (user.role === 'department_admin' && !canAccessDepartment(user, course.departmentId)) {
        res.status(403).json({ error: 'Access denied for another department.' });
        return;
      }

      const { matricNumbers, departmentId, level } = req.body as {
        matricNumbers?: string[];
        departmentId?: string;
        level?: StudentLevel;
      };

      let targetStudents: StudentRecord[] = [];
      if (Array.isArray(matricNumbers) && matricNumbers.length > 0) {
        const set = new Set(matricNumbers.map((m) => m.trim().toUpperCase()));
        targetStudents = db.state.students.filter((s) => set.has(s.matricNumber.toUpperCase()));
      } else if (departmentId || level) {
        targetStudents = db.state.students.filter(
          (s) => (!departmentId || s.departmentId === departmentId) && (!level || s.level === level)
        );
      }

      const existingStudentIds = new Set(
        db.state.enrolments.filter((e) => e.courseId === course.id && e.status === 'enrolled').map((e) => e.studentId)
      );
      const now = new Date().toISOString();
      const newEnrolments = [];

      for (const s of targetStudents) {
        if (existingStudentIds.has(s.id)) continue;
        newEnrolments.push({
          id: `enr_${course.id}_${s.id}`,
          courseId: course.id,
          studentId: s.id,
          matricNumber: s.matricNumber,
          studentUid: s.claimedUid,
          lecturerUid: course.lecturerUid,
          status: 'enrolled' as const,
          enrolledAt: now,
        });
        existingStudentIds.add(s.id);
      }

      course.enrolledCount = existingStudentIds.size;
      course.updatedAt = now;

      await db.enrolStudentsBatch(course, newEnrolments);
      await db.addAuditLog({
        actorUid: user.uid,
        actorName: user.displayName,
        actorRole: user.role,
        action: 'COURSE_ENROLMENT_UPDATED',
        targetType: 'course',
        targetId: course.id,
        details: `Enrolled ${newEnrolments.length} students into ${course.courseCode} (total enrolled: ${course.enrolledCount}).`,
        departmentId: course.departmentId,
      });
      res.json({ added: newEnrolments.length, enrolledCount: course.enrolledCount });
    }
  );

  // Students Register & CSV Import
  router.get(
    '/students',
    requireAuth,
    requireRole(['system_admin', 'department_admin', 'lecturer']),
    (req: RequestWithAuth, res: Response) => {
      const user = req.authContext!.user!;
      const search = String(req.query.search || '').trim().toLowerCase();
      const deptFilter = String(req.query.departmentId || '');
      const statusFilter = String(req.query.status || '');
      const courseId = String(req.query.courseId || '');
      const page = Math.max(1, Number(req.query.page || 1));
      const pageSize = Math.min(100, Math.max(10, Number(req.query.pageSize || 25)));

      let list = db.state.students;
      if (user.role === 'department_admin') {
        list = list.filter((s) => s.departmentId === user.departmentId);
      } else if (user.role === 'lecturer') {
        const myCourseIds = new Set(db.state.courses.filter((c) => c.lecturerUid === user.uid).map((c) => c.id));
        const myStudentIds = new Set(
          db.state.enrolments.filter((e) => myCourseIds.has(e.courseId) && e.status === 'enrolled').map((e) => e.studentId)
        );
        list = list.filter((s) => myStudentIds.has(s.id));
      }

      if (courseId) {
        const enrolledInCourse = new Set(
          db.state.enrolments.filter((e) => e.courseId === courseId && e.status === 'enrolled').map((e) => e.studentId)
        );
        list = list.filter((s) => enrolledInCourse.has(s.id));
      }
      if (deptFilter && user.role !== 'department_admin') {
        list = list.filter((s) => s.departmentId === deptFilter);
      }
      if (statusFilter) {
        list = list.filter((s) => s.accountStatus === statusFilter);
      }
      if (search) {
        list = list.filter(
          (s) => s.fullName.toLowerCase().includes(search) || s.matricNumber.toLowerCase().includes(search)
        );
      }

      const total = list.length;
      const start = (page - 1) * pageSize;
      const items = list.slice(start, start + pageSize).map((s) => ({
        ...s,
        activationCode: user.role === 'system_admin' || user.role === 'department_admin' ? s.activationCode : undefined,
      }));

      res.json({ items, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) });
    }
  );

  router.post(
    '/students/import-csv',
    requireAuth,
    requireRole(['system_admin', 'department_admin']),
    async (req: RequestWithAuth, res: Response) => {
      const user = req.authContext!.user!;
      const { rows } = req.body as {
        rows?: Array<{
          fullName?: string;
          matricNumber?: string;
          department?: string;
          faculty?: string;
          level?: string;
          accountStatus?: string;
        }>;
      };

      if (!Array.isArray(rows) || rows.length === 0) {
        res.status(400).json({ error: 'No student rows provided for import.' });
        return;
      }

      const existingMatrics = new Set(db.state.students.map((s) => s.matricNumber.toUpperCase()));
      const seenInBatch = new Set<string>();
      const validLevels = new Set(['100L', '200L', '300L', '400L', '500L']);
      const now = new Date().toISOString();

      const succeeded: StudentRecord[] = [];
      const failed: Array<{ rowNumber: number; matricNumber: string; fullName: string; reason: string }> = [];

      rows.forEach((raw, idx) => {
        const rowNumber = idx + 1;
        const fullName = (raw.fullName || '').trim();
        const matric = (raw.matricNumber || '').trim().toUpperCase();
        const deptText = (raw.department || '').trim();
        const faculty = (raw.faculty || 'Faculty of Engineering').trim();
        const levelRaw = (raw.level || '200L').trim().toUpperCase();
        const level = (levelRaw.endsWith('L') ? levelRaw : `${levelRaw}L`) as StudentLevel;
        const statusRaw = (raw.accountStatus || 'pending_activation').trim().toLowerCase();

        if (!fullName || fullName.length < 2) {
          failed.push({ rowNumber, matricNumber: matric, fullName, reason: 'Missing or invalid full name.' });
          return;
        }
        if (!matric || !/^[A-Z0-9\-/]{5,24}$/.test(matric)) {
          failed.push({ rowNumber, matricNumber: matric, fullName, reason: 'Invalid matriculation number format.' });
          return;
        }
        if (seenInBatch.has(matric)) {
          failed.push({ rowNumber, matricNumber: matric, fullName, reason: 'Duplicate matriculation number in CSV.' });
          return;
        }
        if (existingMatrics.has(matric)) {
          failed.push({ rowNumber, matricNumber: matric, fullName, reason: 'Matriculation number already exists in register.' });
          return;
        }
        if (!validLevels.has(level)) {
          failed.push({ rowNumber, matricNumber: matric, fullName, reason: `Unsupported level "${raw.level}".` });
          return;
        }

        const matchedDept =
          db.state.departments.find(
            (d) => d.code.toLowerCase() === deptText.toLowerCase() || d.name.toLowerCase() === deptText.toLowerCase()
          ) || db.state.departments.find((d) => d.id === user.departmentId);

        if (!matchedDept) {
          failed.push({ rowNumber, matricNumber: matric, fullName, reason: `Unknown department "${deptText}".` });
          return;
        }
        if (user.role === 'department_admin' && matchedDept.id !== user.departmentId) {
          failed.push({
            rowNumber,
            matricNumber: matric,
            fullName,
            reason: `Department admin cannot import records into ${matchedDept.name}.`,
          });
          return;
        }

        const accountStatus =
          statusRaw === 'active'
            ? 'active'
            : statusRaw === 'suspended'
              ? 'suspended'
              : 'pending_activation';

        const activationCode =
          accountStatus === 'pending_activation'
            ? `LASU-${crypto.randomBytes(3).toString('hex').toUpperCase()}`
            : undefined;

        const record: StudentRecord = {
          id: `std_${matric.replace(/[^a-zA-Z0-9]/g, '')}`,
          matricNumber: matric,
          fullName,
          departmentId: matchedDept.id,
          departmentName: matchedDept.name,
          facultyName: faculty,
          level,
          accountStatus,
          activationCode,
          isDemo: false,
          createdAt: now,
          updatedAt: now,
        };

        seenInBatch.add(matric);
        existingMatrics.add(matric);
        succeeded.push(record);
      });

      await db.importStudentsBatch(succeeded);
      await db.addAuditLog({
        actorUid: user.uid,
        actorName: user.displayName,
        actorRole: user.role,
        action: 'STUDENT_REGISTER_IMPORTED',
        targetType: 'student_register',
        targetId: uid('csv'),
        details: `CSV import completed: ${succeeded.length} imported, ${failed.length} failed/rejected.`,
        departmentId: user.departmentId,
      });

      res.json({ importedCount: succeeded.length, failedCount: failed.length, succeeded, failed });
    }
  );

  // User & Role Management
  router.get(
    '/users',
    requireAuth,
    requireRole(['system_admin', 'department_admin']),
    (req: RequestWithAuth, res: Response) => {
      const user = req.authContext!.user!;
      const list =
        user.role === 'system_admin'
          ? db.state.users
          : db.state.users.filter((u) => u.departmentId === user.departmentId);
      res.json(list);
    }
  );

  router.post(
    '/users/approve-staff',
    requireAuth,
    requireRole(['system_admin', 'department_admin']),
    async (req: RequestWithAuth, res: Response) => {
      const actor = req.authContext!.user!;
      const { email, displayName, role, departmentId } = req.body as {
        email?: string;
        displayName?: string;
        role?: UserRole;
        departmentId?: string;
      };
      if (!email || !displayName || !role || !departmentId) {
        res.status(400).json({ error: 'Email, full name, role, and department are required.' });
        return;
      }
      if (actor.role === 'department_admin' && (role === 'system_admin' || departmentId !== actor.departmentId)) {
        res.status(403).json({ error: 'Department admins can only approve lecturers within their own department.' });
        return;
      }
      const dept = db.state.departments.find((d) => d.id === departmentId);
      if (!dept) {
        res.status(404).json({ error: 'Department not found.' });
        return;
      }
      const cleanEmail = email.trim().toLowerCase();
      const now = new Date().toISOString();
      let existing = db.state.users.find((u) => u.email.toLowerCase() === cleanEmail);
      if (existing) {
        existing.role = role;
        existing.departmentId = dept.id;
        existing.departmentName = dept.name;
        existing.facultyName = dept.facultyName;
        existing.status = 'active';
        existing.updatedAt = now;
      } else {
        existing = {
          uid: uid('staff'),
          email: cleanEmail,
          displayName: displayName.trim(),
          role,
          departmentId: dept.id,
          departmentName: dept.name,
          facultyName: dept.facultyName,
          status: 'active',
          isDemo: false,
          createdAt: now,
          updatedAt: now,
        };
      }

      await db.saveUser(existing);
      await db.addAuditLog({
        actorUid: actor.uid,
        actorName: actor.displayName,
        actorRole: actor.role,
        action: 'STAFF_ACCOUNT_APPROVED',
        targetType: 'user',
        targetId: existing.uid,
        details: `Approved ${existing.displayName} (${existing.email}) as ${role} in ${dept.code}.`,
        departmentId: dept.id,
      });
      res.status(201).json(existing);
    }
  );

  router.patch(
    '/users/:uid/role',
    requireAuth,
    requireRole(['system_admin']),
    async (req: RequestWithAuth, res: Response) => {
      const actor = req.authContext!.user!;
      const target = db.state.users.find((u) => u.uid === req.params.uid);
      if (!target) {
        res.status(404).json({ error: 'User not found.' });
        return;
      }
      const { role, status, departmentId } = req.body as {
        role?: UserRole;
        status?: 'active' | 'pending' | 'suspended';
        departmentId?: string;
      };
      const prevRole = target.role;
      if (role) target.role = role;
      if (status) target.status = status;
      if (departmentId) {
        const dept = db.state.departments.find((d) => d.id === departmentId);
        if (dept) {
          target.departmentId = dept.id;
          target.departmentName = dept.name;
          target.facultyName = dept.facultyName;
        }
      }
      target.updatedAt = new Date().toISOString();

      await db.saveUser(target);
      await db.addAuditLog({
        actorUid: actor.uid,
        actorName: actor.displayName,
        actorRole: actor.role,
        action: 'USER_ROLE_CHANGED',
        targetType: 'user',
        targetId: target.uid,
        details: `Updated ${target.displayName}: role ${prevRole} -> ${target.role}, status ${target.status}.`,
        departmentId: target.departmentId,
      });
      res.json(target);
    }
  );

  // Sessions CRUD & Lifecycle
  router.get('/sessions', requireAuth, (req: RequestWithAuth, res: Response) => {
    const user = req.authContext!.user;
    if (!user) {
      res.json([]);
      return;
    }
    let list = db.state.sessions;
    if (user.role === 'lecturer') {
      list = list.filter((s) => s.lecturerUid === user.uid);
    } else if (user.role === 'department_admin') {
      list = list.filter((s) => s.departmentId === user.departmentId);
    } else if (user.role === 'student') {
      const myCourses = new Set(
        db.state.enrolments.filter((e) => e.studentId === user.studentId && e.status === 'enrolled').map((e) => e.courseId)
      );
      list = list.filter((s) => myCourses.has(s.courseId));
    }
    const sorted = [...list].sort(
      (a, b) => b.sessionDate.localeCompare(a.sessionDate) || b.createdAt.localeCompare(a.createdAt)
    );
    res.json(sorted);
  });

  router.post(
    '/sessions',
    requireAuth,
    requireRole(['lecturer', 'department_admin', 'system_admin']),
    async (req: RequestWithAuth, res: Response) => {
      const user = req.authContext!.user!;
      const { courseId, lectureTitle, venue, sessionDate, startTime, lateThresholdMinutes, startImmediately } =
        req.body as {
          courseId?: string;
          lectureTitle?: string;
          venue?: string;
          sessionDate?: string;
          startTime?: string;
          lateThresholdMinutes?: number;
          startImmediately?: boolean;
        };

      const course = db.state.courses.find((c) => c.id === courseId);
      if (!course) {
        res.status(404).json({ error: 'Course not found.' });
        return;
      }
      if (user.role === 'lecturer' && course.lecturerUid !== user.uid) {
        res.status(403).json({ error: 'You can only create sessions for your assigned courses.' });
        return;
      }
      if (user.role === 'department_admin' && !canAccessDepartment(user, course.departmentId)) {
        res.status(403).json({ error: 'Cannot create sessions outside your department.' });
        return;
      }

      const now = new Date();
      const nowIso = now.toISOString();
      const enrolledCount = db.state.enrolments.filter(
        (e) => e.courseId === course.id && e.status === 'enrolled'
      ).length;

      const defaultVenue = course.timetableSlots?.[0]?.venue;

      const session: AttendanceSession = {
        id: uid('ses'),
        courseId: course.id,
        courseCode: course.courseCode,
        courseTitle: course.courseTitle,
        departmentId: course.departmentId,
        lecturerUid: course.lecturerUid,
        lecturerName: course.lecturerName,
        lectureTitle: lectureTitle?.trim() || `${course.courseCode} Lecture`,
        venue: venue?.trim() || defaultVenue,
        sessionDate: sessionDate || nowIso.slice(0, 10),
        startTime: startTime || now.toTimeString().slice(0, 5),
        openedAt: startImmediately ? nowIso : undefined,
        lateThresholdMinutes: typeof lateThresholdMinutes === 'number' ? Math.max(0, lateThresholdMinutes) : 15,
        rotationIntervalSeconds: ROTATION_INTERVAL_SECONDS,
        gracePeriodSeconds: GRACE_PERIOD_SECONDS,
        status: startImmediately ? 'live' : 'scheduled',
        checkpointActive: false,
        totalEnrolled: enrolledCount,
        presentCount: 0,
        lateCount: 0,
        absentCount: 0,
        verifiedCount: 0,
        failedAttemptCount: 0,
        isDemo: course.isDemo,
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      await db.saveSession(session);
      await db.addAuditLog({
        actorUid: user.uid,
        actorName: user.displayName,
        actorRole: user.role,
        action: 'SESSION_CREATED',
        targetType: 'attendance_session',
        targetId: session.id,
        details: `Created session for ${course.courseCode} (${session.lectureTitle}).`,
        departmentId: course.departmentId,
      });

      let qrPayload = null;
      if (startImmediately) {
        qrPayload = qrEngine.initSession(session.id, session.rotationIntervalSeconds);
        await db.addAuditLog({
          actorUid: user.uid,
          actorName: user.displayName,
          actorRole: user.role,
          action: 'SESSION_STARTED',
          targetType: 'attendance_session',
          targetId: session.id,
          details: `Started live QR attendance for ${course.courseCode}.`,
          departmentId: course.departmentId,
        });
      }

      res.status(201).json({ session, qrPayload });
    }
  );

  router.get('/sessions/:id', requireAuth, (req: RequestWithAuth, res: Response) => {
    const session = db.state.sessions.find((s) => s.id === req.params.id);
    if (!session) {
      res.status(404).json({ error: 'Session not found.' });
      return;
    }
    res.json(session);
  });

  router.post(
    '/sessions/:id/start',
    requireAuth,
    requireRole(['lecturer', 'department_admin', 'system_admin']),
    async (req: RequestWithAuth, res: Response) => {
      const user = req.authContext!.user!;
      const session = db.state.sessions.find((s) => s.id === req.params.id);
      if (!session) {
        res.status(404).json({ error: 'Session not found.' });
        return;
      }
      if (user.role === 'lecturer' && session.lecturerUid !== user.uid) {
        res.status(403).json({ error: 'Forbidden.' });
        return;
      }
      if (session.status === 'completed' || session.status === 'cancelled') {
        res.status(400).json({ error: 'Cannot start a closed or cancelled session.' });
        return;
      }

      const nowIso = new Date().toISOString();
      session.status = 'live';
      if (!session.openedAt) session.openedAt = nowIso;
      session.updatedAt = nowIso;
      await db.saveSession(session);

      const qrPayload = qrEngine.initSession(session.id, session.rotationIntervalSeconds);
      await db.addAuditLog({
        actorUid: user.uid,
        actorName: user.displayName,
        actorRole: user.role,
        action: 'SESSION_STARTED',
        targetType: 'attendance_session',
        targetId: session.id,
        details: `Started live QR session for ${session.courseCode}.`,
        departmentId: session.departmentId,
      });
      res.json({ session, qrPayload });
    }
  );

  router.post(
    '/sessions/:id/checkpoint',
    requireAuth,
    requireRole(['lecturer', 'department_admin', 'system_admin']),
    async (req: RequestWithAuth, res: Response) => {
      const user = req.authContext!.user!;
      const session = db.state.sessions.find((s) => s.id === req.params.id);
      if (!session || session.status !== 'live') {
        res.status(400).json({ error: 'Session must be live to start a second attendance checkpoint.' });
        return;
      }
      if (user.role === 'lecturer' && session.lecturerUid !== user.uid) {
        res.status(403).json({ error: 'Forbidden.' });
        return;
      }
      session.checkpointActive = true;
      session.checkpointStartedAt = new Date().toISOString();
      session.updatedAt = session.checkpointStartedAt;
      await db.saveSession(session);
      const qrPayload = qrEngine.startCheckpoint(session.id, session.rotationIntervalSeconds);

      await db.addAuditLog({
        actorUid: user.uid,
        actorName: user.displayName,
        actorRole: user.role,
        action: 'CHECKPOINT_STARTED',
        targetType: 'attendance_session',
        targetId: session.id,
        details: `Started second attendance verification checkpoint for ${session.courseCode}.`,
        departmentId: session.departmentId,
      });
      res.json({ session, qrPayload });
    }
  );

  router.post(
    '/sessions/:id/checkpoint/stop',
    requireAuth,
    requireRole(['lecturer', 'department_admin', 'system_admin']),
    async (req: RequestWithAuth, res: Response) => {
      const user = req.authContext!.user!;
      const session = db.state.sessions.find((s) => s.id === req.params.id);
      if (!session) {
        res.status(404).json({ error: 'Session not found.' });
        return;
      }
      if (user.role === 'lecturer' && session.lecturerUid !== user.uid) {
        res.status(403).json({ error: 'Forbidden.' });
        return;
      }
      session.checkpointActive = false;
      session.updatedAt = new Date().toISOString();
      await db.saveSession(session);
      qrEngine.stopCheckpoint(session.id);
      res.json({ session, qrPayload: qrEngine.getLivePayload(session.id) });
    }
  );

  router.post(
    '/sessions/:id/close',
    requireAuth,
    requireRole(['lecturer', 'department_admin', 'system_admin']),
    async (req: RequestWithAuth, res: Response) => {
      const user = req.authContext!.user!;
      const existingSession = db.state.sessions.find((s) => s.id === req.params.id);
      if (!existingSession) {
        res.status(404).json({ error: 'Session not found.' });
        return;
      }
      if (user.role === 'lecturer' && existingSession.lecturerUid !== user.uid) {
        res.status(403).json({ error: 'Forbidden.' });
        return;
      }
      if (existingSession.status === 'completed') {
        res.json({ session: existingSession });
        return;
      }

      const closed = await db.closeSessionAtomic(existingSession.id);
      if (!closed) {
        res.status(404).json({ error: 'Session not found.' });
        return;
      }

      qrEngine.closeSession(closed.id);

      await db.addAuditLog({
        actorUid: user.uid,
        actorName: user.displayName,
        actorRole: user.role,
        action: 'SESSION_CLOSED',
        targetType: 'attendance_session',
        targetId: closed.id,
        details: `Closed ${closed.courseCode} session: ${closed.presentCount} present, ${closed.lateCount} late, ${closed.absentCount} absent.`,
        departmentId: closed.departmentId,
      });

      await db.upsertNotifications([
        {
          id: uid('notif'),
          recipientUid: closed.lecturerUid,
          title: `${closed.courseCode} attendance finalized`,
          message: `${closed.presentCount + closed.lateCount} of ${closed.totalEnrolled} students checked in (${closed.absentCount} marked absent).`,
          type: 'success',
          category: 'info',
          courseId: closed.courseId,
          read: false,
          createdAt: new Date().toISOString(),
        },
      ]);

      await evaluateCourseMilestonesForSession(closed.courseId);

      res.json({ session: closed });
    }
  );

  // Live QR Presentation Endpoint
  router.get(
    '/sessions/:id/qr',
    requireAuth,
    requireRole(['lecturer', 'department_admin', 'system_admin']),
    (req: RequestWithAuth, res: Response) => {
      const payload = qrEngine.getLivePayload(req.params.id);
      if (!payload) {
        res.status(404).json({ error: 'Session not found.' });
        return;
      }
      res.json(payload);
    }
  );

  // Live / Completed Session Roster
  router.get(
    '/sessions/:id/roster',
    requireAuth,
    requireRole(['lecturer', 'department_admin', 'system_admin']),
    (req: RequestWithAuth, res: Response) => {
      const session = db.state.sessions.find((s) => s.id === req.params.id);
      if (!session) {
        res.status(404).json({ error: 'Session not found.' });
        return;
      }

      const search = String(req.query.search || '').trim().toLowerCase();
      const statusFilter = String(req.query.status || '');
      const checkpointFilter = String(req.query.checkpoint || '');
      const sortBy = String(req.query.sortBy || 'matricNumber');
      const sortDir = String(req.query.sortDir || 'asc') === 'desc' ? -1 : 1;
      const page = Math.max(1, Number(req.query.page || 1));
      const pageSize = Math.min(100, Math.max(10, Number(req.query.pageSize || 25)));

      const enrolments = db.state.enrolments.filter(
        (e) => e.courseId === session.courseId && e.status === 'enrolled'
      );
      const recordMap = new Map(
        db.state.records.filter((r) => r.sessionId === session.id).map((r) => [r.studentId, r])
      );
      const studentMap = new Map(db.state.students.map((s) => [s.id, s]));

      let rows = enrolments
        .map((e) => {
          const st = studentMap.get(e.studentId);
          if (!st) return null;
          const rec = recordMap.get(st.id);
          const derivedStatus = rec
            ? rec.status
            : session.status === 'completed'
              ? 'absent'
              : 'not_checked_in';
          return {
            studentId: st.id,
            matricNumber: st.matricNumber,
            studentName: st.fullName,
            departmentName: st.departmentName,
            status: derivedStatus,
            checkInTime: rec?.checkInTime || null,
            checkpointStatus: rec?.checkpointStatus || 'none',
            checkpointTime: rec?.checkpointTime || null,
            correctionReason: rec?.correctionReason || null,
          };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);

      if (search) {
        rows = rows.filter(
          (r) => r.studentName.toLowerCase().includes(search) || r.matricNumber.toLowerCase().includes(search)
        );
      }
      if (statusFilter) {
        rows = rows.filter((r) => r.status === statusFilter);
      }
      if (checkpointFilter) {
        rows = rows.filter((r) => r.checkpointStatus === checkpointFilter);
      }

      rows.sort((a, b) => {
        if (sortBy === 'studentName') return a.studentName.localeCompare(b.studentName) * sortDir;
        if (sortBy === 'status') return a.status.localeCompare(b.status) * sortDir;
        if (sortBy === 'checkInTime') return (a.checkInTime || '').localeCompare(b.checkInTime || '') * sortDir;
        return a.matricNumber.localeCompare(b.matricNumber) * sortDir;
      });

      const total = rows.length;
      const start = (page - 1) * pageSize;
      const items = rows.slice(start, start + pageSize);
      const failedAttempts = db.failedAttempts.filter((f) => f.sessionId === session.id).slice(0, 20);

      res.json({
        session,
        items,
        total,
        page,
        pageSize,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
        failedAttempts,
      });
    }
  );

  // Student Check-in Pre-Lookup
  router.get('/checkin/lookup', requireAuth, (req: RequestWithAuth, res: Response) => {
    const ctx = req.authContext!;
    const user = ctx.user;
    const rawSessionId = String(req.query.s || '').trim();
    const rawToken = String(req.query.t || '').trim();
    const rawCode = String(req.query.code || '').trim();
    const rawMode = String(req.query.mode || 'checkin') === 'verify' ? 'verify' : 'checkin';

    let sessionId = rawSessionId;
    let mode: 'checkin' | 'verify' = rawMode;
    let tokenOrCode = rawToken;

    if (!sessionId && rawCode) {
      const found = qrEngine.findSessionByShortCode(rawCode);
      if (!found) {
        res.status(404).json({
          error: 'Invalid or expired attendance code. Please check the code on the lecture screen.',
          code: 'EXPIRED_QR',
        });
        return;
      }
      sessionId = found.sessionId;
      mode = found.mode;
      tokenOrCode = rawCode;
    }

    const session = db.state.sessions.find((s) => s.id === sessionId);
    if (!session) {
      res.status(404).json({ error: 'Attendance session not found.', code: 'SESSION_NOT_FOUND' });
      return;
    }

    const tokenCheck = qrEngine.validateToken(sessionId, tokenOrCode, mode);
    const student = user?.studentId ? db.state.students.find((s) => s.id === user.studentId) : null;
    const isEnrolled = student
      ? db.state.enrolments.some((e) => e.courseId === session.courseId && e.studentId === student.id && e.status === 'enrolled')
      : false;
    const existingRecord = student
      ? db.state.records.find((r) => r.sessionId === session.id && r.studentId === student.id)
      : null;

    res.json({
      session: {
        id: session.id,
        courseId: session.courseId,
        courseCode: session.courseCode,
        courseTitle: session.courseTitle,
        lectureTitle: session.lectureTitle,
        venue: session.venue,
        lecturerName: session.lecturerName,
        sessionDate: session.sessionDate,
        startTime: session.startTime,
        status: session.status,
        checkpointActive: session.checkpointActive,
      },
      mode,
      tokenValid: tokenCheck.valid,
      tokenError: tokenCheck.reason || null,
      tokenErrorCode: tokenCheck.code || null,
      studentActivated: Boolean(user && user.role === 'student' && user.status === 'active' && student),
      isEnrolled,
      existingRecord: existingRecord
        ? {
            status: existingRecord.status,
            checkInTime: existingRecord.checkInTime,
            checkpointStatus: existingRecord.checkpointStatus,
            checkpointTime: existingRecord.checkpointTime,
          }
        : null,
    });
  });

  // Server-Authoritative Student Check-In (Firestore runTransaction + Duplicate Prevention)
  router.post('/attendance/checkin', requireAuth, async (req: RequestWithAuth, res: Response) => {
    const ctx = req.authContext!;
    const user = ctx.user;
    const ip = req.ip || 'unknown';

    if (!checkRateLimit(`checkin:${ctx.uid}:${ip}`, 15, 60 * 1000)) {
      res.status(429).json({ error: 'Too many check-in requests. Please wait a moment.', code: 'RATE_LIMITED' });
      return;
    }

    const { sessionId: bodySessionId, token, shortCode } = req.body as {
      sessionId?: string;
      token?: string;
      shortCode?: string;
    };

    let sessionId = (bodySessionId || '').trim();
    const tokenOrCode = (token || shortCode || '').trim();

    if (!sessionId && shortCode) {
      const found = qrEngine.findSessionByShortCode(shortCode);
      if (found) sessionId = found.sessionId;
    }

    if (!sessionId || !tokenOrCode) {
      res.status(400).json({ error: 'Missing attendance session or QR token.', code: 'BAD_REQUEST' });
      return;
    }

    if (!user || user.status !== 'active' || user.role !== 'student' || !user.studentId) {
      recordFailedAttempt(sessionId, 'Unverified or non-student account attempted check-in.', 'ACCOUNT_VERIFICATION_REQUIRED', ctx.uid);
      res.status(403).json({
        error: 'Your student account requires activation before marking attendance.',
        code: 'ACCOUNT_VERIFICATION_REQUIRED',
      });
      return;
    }

    const student = db.state.students.find((s) => s.id === user.studentId);
    if (!student || student.accountStatus !== 'active') {
      recordFailedAttempt(sessionId, 'Inactive student account attempted check-in.', 'ACCOUNT_VERIFICATION_REQUIRED', ctx.uid, user.matricNumber);
      res.status(403).json({
        error: 'Your student account is pending verification or suspended.',
        code: 'ACCOUNT_VERIFICATION_REQUIRED',
      });
      return;
    }

    const tokenCheck = qrEngine.validateToken(sessionId, tokenOrCode, 'checkin');
    if (!tokenCheck.valid) {
      recordFailedAttempt(
        sessionId,
        `${student.matricNumber} presented invalid/expired token.`,
        tokenCheck.code || 'EXPIRED_QR',
        ctx.uid,
        student.matricNumber
      );
      await db.addAuditLog({
        actorUid: ctx.uid,
        actorName: student.fullName,
        actorRole: 'student',
        action: 'INVALID_TOKEN_REJECTED',
        targetType: 'attendance_session',
        targetId: sessionId,
        details: `Rejected invalid/expired QR check-in token for ${student.matricNumber}.`,
        departmentId: student.departmentId,
      });
      res.status(400).json({ error: tokenCheck.reason, code: tokenCheck.code });
      return;
    }

    const result = await db.atomicCheckIn({
      sessionId,
      student,
      actorUid: ctx.uid,
    });

    if (!result.ok) {
      if (result.code === 'ALREADY_CHECKED_IN' && result.existing) {
        await db.addAuditLog({
          actorUid: ctx.uid,
          actorName: student.fullName,
          actorRole: 'student',
          action: 'DUPLICATE_CHECKIN_REJECTED',
          targetType: 'attendance_record',
          targetId: result.existing.id,
          details: `Blocked duplicate check-in attempt for ${student.matricNumber}.`,
          departmentId: student.departmentId,
        });
        const ses = db.state.sessions.find((s) => s.id === sessionId);
        res.status(409).json({
          error: result.error,
          code: result.code,
          record: result.existing,
          courseCode: ses?.courseCode,
          courseTitle: ses?.courseTitle,
        });
        return;
      }

      recordFailedAttempt(sessionId, `${student.matricNumber}: ${result.error}`, result.code, ctx.uid, student.matricNumber);
      res.status(result.status).json({ error: result.error, code: result.code });
      return;
    }

    const { record, session } = result;
    await db.addAuditLog({
      actorUid: ctx.uid,
      actorName: student.fullName,
      actorRole: 'student',
      action: 'STUDENT_CHECKIN_ACCEPTED',
      targetType: 'attendance_record',
      targetId: record.id,
      details: `${student.matricNumber} checked in (${record.status}) for ${session.courseCode}.`,
      departmentId: student.departmentId,
    });

    qrEngine.broadcast(session.id, {
      type: 'attendance:checkin',
      sessionId: session.id,
      presentCount: session.presentCount,
      lateCount: session.lateCount,
      verifiedCount: session.verifiedCount,
      totalEnrolled: session.totalEnrolled,
      record,
    });

    res.status(201).json({
      ok: true,
      record,
      courseCode: session.courseCode,
      courseTitle: session.courseTitle,
      lectureTitle: session.lectureTitle,
    });
  });

  // Optional Second Checkpoint ("Verify Attendance")
  router.post('/attendance/verify', requireAuth, async (req: RequestWithAuth, res: Response) => {
    const ctx = req.authContext!;
    const user = ctx.user;
    const { sessionId: bodySessionId, token, shortCode } = req.body as {
      sessionId?: string;
      token?: string;
      shortCode?: string;
    };

    let sessionId = (bodySessionId || '').trim();
    const tokenOrCode = (token || shortCode || '').trim();
    if (!sessionId && shortCode) {
      const found = qrEngine.findSessionByShortCode(shortCode);
      if (found) sessionId = found.sessionId;
    }

    if (!user || user.role !== 'student' || !user.studentId || user.status !== 'active') {
      res.status(403).json({ error: 'Active student account required.', code: 'ACCOUNT_VERIFICATION_REQUIRED' });
      return;
    }

    const tokenCheck = qrEngine.validateToken(sessionId, tokenOrCode, 'verify');
    if (!tokenCheck.valid) {
      recordFailedAttempt(
        sessionId,
        `Invalid/expired 2nd checkpoint token for ${user.matricNumber}`,
        tokenCheck.code || 'EXPIRED_QR',
        ctx.uid,
        user.matricNumber
      );
      res.status(400).json({ error: tokenCheck.reason, code: tokenCheck.code });
      return;
    }

    const result = await db.atomicVerifyCheckpoint({
      sessionId,
      studentId: user.studentId,
      actorUid: ctx.uid,
      matricNumber: user.matricNumber || user.studentId,
    });

    if (!result.ok) {
      res.status(result.status).json({
        error: result.error,
        code: result.code,
        record: result.existing,
      });
      return;
    }

    const { record, session } = result;
    await db.addAuditLog({
      actorUid: ctx.uid,
      actorName: user.displayName,
      actorRole: 'student',
      action: 'CHECKPOINT_VERIFIED',
      targetType: 'attendance_record',
      targetId: record.id,
      details: `${user.matricNumber} completed second checkpoint verification in ${session.courseCode}.`,
      departmentId: user.departmentId,
    });

    qrEngine.broadcast(session.id, {
      type: 'attendance:verified',
      sessionId: session.id,
      verifiedCount: session.verifiedCount,
      record,
    });

    res.json({
      ok: true,
      record,
      courseCode: session.courseCode,
      courseTitle: session.courseTitle,
    });
  });

  // Authorized Manual Correction with Mandatory Reason, Audit Log & Attendance Update Notification
  router.post(
    '/attendance/correct',
    requireAuth,
    requireRole(['lecturer', 'department_admin', 'system_admin']),
    async (req: RequestWithAuth, res: Response) => {
      const actor = req.authContext!.user!;
      const { sessionId, studentId, newStatus, reason } = req.body as {
        sessionId?: string;
        studentId?: string;
        newStatus?: AttendanceStatus;
        reason?: string;
      };

      if (!sessionId || !studentId || !newStatus || !reason || reason.trim().length < 4) {
        res.status(400).json({ error: 'Session, student, new status, and a clear correction reason are required.' });
        return;
      }

      const session = db.state.sessions.find((s) => s.id === sessionId);
      if (!session) {
        res.status(404).json({ error: 'Session not found.' });
        return;
      }
      if (actor.role === 'lecturer' && session.lecturerUid !== actor.uid) {
        res.status(403).json({ error: 'You can only correct records in your own courses.' });
        return;
      }
      if (actor.role === 'department_admin' && !canAccessDepartment(actor, session.departmentId)) {
        res.status(403).json({ error: 'Access denied for another department.' });
        return;
      }

      const student = db.state.students.find((s) => s.id === studentId);
      if (!student) {
        res.status(404).json({ error: 'Student not found.' });
        return;
      }

      const result = await db.atomicCorrectAttendance({
        sessionId,
        student,
        newStatus,
        reason,
        actor,
      });

      if (!result) {
        res.status(404).json({ error: 'Session not found.' });
        return;
      }

      await db.addAuditLog({
        actorUid: actor.uid,
        actorName: actor.displayName,
        actorRole: actor.role,
        action: 'ATTENDANCE_MANUALLY_CORRECTED',
        targetType: 'attendance_record',
        targetId: result.record.id,
        details: `Corrected ${student.matricNumber} in ${session.courseCode} from ${result.oldStatus} to ${newStatus}. Reason: ${reason.trim()}`,
        departmentId: session.departmentId,
      });

      if (student.claimedUid) {
        await db.upsertNotifications([
          {
            id: uid('notif'),
            recipientUid: student.claimedUid,
            title: `Attendance updated for ${session.courseCode}`,
            message: `Your attendance status for ${session.sessionDate} was updated to "${newStatus}" by ${actor.displayName}. Reason: ${reason.trim()}`,
            type: 'info',
            category: 'attendance_update',
            courseId: session.courseId,
            read: false,
            createdAt: new Date().toISOString(),
          },
        ]);

        // Re-evaluate course milestones for this student
        const enr = db.state.enrolments.find(
          (e) => e.courseId === session.courseId && e.studentId === student.id && e.status === 'enrolled'
        );
        const crs = db.state.courses.find((c) => c.id === session.courseId);
        if (enr && crs) {
          const ms = buildCourseMilestoneNotifications({
            student,
            enrolment: enr,
            course: crs,
            sessions: db.state.sessions,
            records: db.state.records.filter((r) => r.studentId === student.id),
            settings: db.state.institutionSettings,
          });
          await db.upsertNotifications(ms);
        }
      }

      qrEngine.broadcast(session.id, {
        type: 'attendance:corrected',
        sessionId: session.id,
        presentCount: result.session.presentCount,
        lateCount: result.session.lateCount,
        absentCount: result.session.absentCount,
      });

      res.json({ record: result.record, session: result.session });
    }
  );

  // Analytics & Reports (Phase 4 & 5 unified filters)
  router.get(
    '/reports/analytics',
    requireAuth,
    requireRole(['lecturer', 'department_admin', 'system_admin']),
    (req: RequestWithAuth, res: Response) => {
      const user = req.authContext!.user!;
      const settings = db.state.institutionSettings;
      const lateWeight = getLateWeight(settings.lateCountPolicy);
      const courseId = String(req.query.courseId || '');
      const departmentId = String(req.query.departmentId || '');
      const dateFrom = String(req.query.dateFrom || '');
      const dateTo = String(req.query.dateTo || '');
      const statusFilter = String(req.query.status || '');
      const studentFilter = String(req.query.student || '').trim().toLowerCase();
      const riskThreshold = Math.min(
        100,
        Math.max(10, Number(req.query.riskThreshold || settings.attendanceThreshold || 75))
      );

      let courses = db.state.courses;
      if (user.role === 'lecturer') courses = courses.filter((c) => c.lecturerUid === user.uid);
      else if (user.role === 'department_admin') courses = courses.filter((c) => c.departmentId === user.departmentId);

      if (departmentId && user.role !== 'department_admin') {
        courses = courses.filter((c) => c.departmentId === departmentId);
      }
      if (courseId) {
        courses = courses.filter((c) => c.id === courseId);
      }

      const courseIds = new Set(courses.map((c) => c.id));
      let sessions = db.state.sessions.filter((s) => courseIds.has(s.courseId) && s.status === 'completed');
      if (dateFrom) sessions = sessions.filter((s) => s.sessionDate >= dateFrom);
      if (dateTo) sessions = sessions.filter((s) => s.sessionDate <= dateTo);

      sessions.sort((a, b) => a.sessionDate.localeCompare(b.sessionDate));

      const sessionIds = new Set(sessions.map((s) => s.id));
      const matchingRecords = db.state.records.filter((rec) => {
        if (!sessionIds.has(rec.sessionId)) return false;
        if (statusFilter && rec.status !== statusFilter) return false;
        if (
          studentFilter &&
          !rec.studentName.toLowerCase().includes(studentFilter) &&
          !rec.matricNumber.toLowerCase().includes(studentFilter)
        ) {
          return false;
        }
        return true;
      });

      const recordsBySession = new Map<string, AttendanceRecord[]>();
      for (const rec of matchingRecords) {
        const list = recordsBySession.get(rec.sessionId) || [];
        list.push(rec);
        recordsBySession.set(rec.sessionId, list);
      }

      let totalPresent = 0;
      let totalLate = 0;
      let totalAbsent = 0;
      let totalExcused = 0;
      let totalExpected = 0;

      const sessionSeries = sessions.map((s) => {
        const recs = recordsBySession.get(s.id) || [];
        const useFiltered = Boolean(statusFilter || studentFilter);
        const present = useFiltered ? recs.filter((r) => r.status === 'present').length : s.presentCount;
        const late = useFiltered ? recs.filter((r) => r.status === 'late').length : s.lateCount;
        const absent = useFiltered ? recs.filter((r) => r.status === 'absent').length : s.absentCount;
        const excused = recs.filter((r) => r.status === 'excused').length;
        const expected = useFiltered ? Math.max(0, recs.length - excused) : Math.max(0, s.totalEnrolled - excused);

        totalPresent += present;
        totalLate += late;
        totalAbsent += absent;
        totalExcused += excused;
        totalExpected += expected;

        const rate =
          expected > 0 ? Math.round(((present + late * lateWeight) / expected) * 1000) / 10 : 0;

        return {
          sessionId: s.id,
          label: `${s.courseCode} (${s.sessionDate.slice(5)})`,
          courseCode: s.courseCode,
          lectureTitle: s.lectureTitle,
          date: s.sessionDate,
          present,
          late,
          absent,
          totalEnrolled: expected,
          rate,
        };
      });

      const studentStats = new Map<
        string,
        {
          studentId: string;
          studentName: string;
          matricNumber: string;
          present: number;
          late: number;
          absent: number;
          total: number;
          effective: number;
        }
      >();

      for (const rec of matchingRecords) {
        let entry = studentStats.get(rec.studentId);
        if (!entry) {
          entry = {
            studentId: rec.studentId,
            studentName: rec.studentName,
            matricNumber: rec.matricNumber,
            present: 0,
            late: 0,
            absent: 0,
            total: 0,
            effective: 0,
          };
          studentStats.set(rec.studentId, entry);
        }
        if (rec.status === 'excused') continue;
        entry.total++;
        if (rec.status === 'present') {
          entry.present++;
          entry.effective += 1;
        } else if (rec.status === 'late') {
          entry.late++;
          entry.effective += lateWeight;
        } else if (rec.status === 'absent') {
          entry.absent++;
        }
      }

      const buckets = [
        { range: '90-100%', count: 0 },
        { range: '75-89%', count: 0 },
        { range: '50-74%', count: 0 },
        { range: 'Below 50%', count: 0 },
      ];

      const studentSummaries = Array.from(studentStats.values()).map((st) => {
        const rate = st.total > 0 ? Math.round((st.effective / st.total) * 100) : 0;
        if (rate >= 90) buckets[0].count++;
        else if (rate >= 75) buckets[1].count++;
        else if (rate >= 50) buckets[2].count++;
        else buckets[3].count++;
        return { ...st, rate };
      });

      const lowAttendanceStudents = studentSummaries
        .filter((s) => s.rate < riskThreshold)
        .sort((a, b) => a.rate - b.rate || a.matricNumber.localeCompare(b.matricNumber));

      const lowAttendanceSessions = sessionSeries.filter((s) => s.rate < riskThreshold);

      const courseComparison = courses.map((c) => {
        const cs = sessionSeries.filter((s) => s.courseCode === c.courseCode);
        const exp = cs.reduce((a, s) => a + s.totalEnrolled, 0);
        const eff = cs.reduce((a, s) => a + s.present + s.late * lateWeight, 0);
        return {
          courseId: c.id,
          courseCode: c.courseCode,
          courseTitle: c.courseTitle,
          enrolledCount: c.enrolledCount,
          sessionsHeld: cs.length,
          averageRate: exp > 0 ? Math.round((eff / exp) * 1000) / 10 : 0,
        };
      });

      const averageRate =
        totalExpected > 0
          ? Math.round(((totalPresent + totalLate * lateWeight) / totalExpected) * 1000) / 10
          : 0;

      res.json({
        lateCountPolicy: settings.lateCountPolicy,
        summary: {
          averageRate,
          presentCount: totalPresent,
          lateCount: totalLate,
          absentCount: totalAbsent,
          excusedCount: totalExcused,
          enrolledCount: courses.reduce((a, c) => a + c.enrolledCount, 0),
          sessionsCount: sessions.length,
        },
        distribution: [
          { name: 'Present', value: totalPresent, color: '#16845B' },
          { name: 'Late', value: totalLate, color: '#D99020' },
          { name: 'Absent', value: totalAbsent, color: '#D84A4A' },
        ],
        sessionSeries,
        studentHistogram: buckets,
        courseComparison,
        lowAttendanceStudents: lowAttendanceStudents.slice(0, 50),
        lowAttendanceSessions,
      });
    }
  );

  // PDF, CSV & Excel-Compatible Export (Phase 5)
  router.get(
    '/reports/export',
    requireAuth,
    requireRole(['lecturer', 'department_admin', 'system_admin']),
    (req: RequestWithAuth, res: Response) => {
      const user = req.authContext!.user!;
      const settings = db.state.institutionSettings;
      const sessionId = String(req.query.sessionId || '');
      const courseId = String(req.query.courseId || '');
      const departmentId = String(req.query.departmentId || '');
      const dateFrom = String(req.query.dateFrom || '');
      const dateTo = String(req.query.dateTo || '');
      const statusFilter = String(req.query.status || '');
      const studentFilter = String(req.query.student || '').trim().toLowerCase();
      const format = String(req.query.format || 'csv').toLowerCase();

      let sessions = db.state.sessions;
      if (user.role === 'lecturer') sessions = sessions.filter((s) => s.lecturerUid === user.uid);
      else if (user.role === 'department_admin') sessions = sessions.filter((s) => s.departmentId === user.departmentId);

      if (departmentId && user.role !== 'department_admin') {
        sessions = sessions.filter((s) => s.departmentId === departmentId);
      }
      if (sessionId) sessions = sessions.filter((s) => s.id === sessionId);
      if (courseId) sessions = sessions.filter((s) => s.courseId === courseId);
      if (dateFrom) sessions = sessions.filter((s) => s.sessionDate >= dateFrom);
      if (dateTo) sessions = sessions.filter((s) => s.sessionDate <= dateTo);

      // When exporting across general reports (no explicit sessionId), only include completed sessions so totals match dashboard
      if (!sessionId) {
        sessions = sessions.filter((s) => s.status === 'completed');
      }

      const sessionMap = new Map(sessions.map((s) => [s.id, s]));
      const rows = db.state.records
        .filter((r) => {
          if (!sessionMap.has(r.sessionId)) return false;
          if (statusFilter && r.status !== statusFilter) return false;
          if (
            studentFilter &&
            !r.studentName.toLowerCase().includes(studentFilter) &&
            !r.matricNumber.toLowerCase().includes(studentFilter)
          ) {
            return false;
          }
          return true;
        })
        .sort(
          (a, b) =>
            (sessionMap.get(a.sessionId)?.sessionDate || '').localeCompare(
              sessionMap.get(b.sessionId)?.sessionDate || ''
            ) || a.matricNumber.localeCompare(b.matricNumber)
        );

      const filenameBase = sessionId
        ? `lasu-attend-${sessionId}`
        : courseId
          ? `lasu-attend-${courseId}`
          : 'lasu-attend-report';

      if (format === 'pdf') {
        const pdfRows = rows.map((record) => ({
          record,
          session: sessionMap.get(record.sessionId)!,
        }));
        const deptObj = departmentId ? db.state.departments.find((d) => d.id === departmentId) : null;
        const crsObj = courseId ? db.state.courses.find((c) => c.id === courseId) : null;
        const sesObj = sessionId ? db.state.sessions.find((s) => s.id === sessionId) : null;

        streamAttendancePdfReport(
          res,
          `${filenameBase}.pdf`,
          {
            institutionName: db.state.institutions[0]?.name || 'Lagos State University',
            generatedBy: user.displayName,
            generatedAt: new Date().toISOString(),
            filters: {
              departmentLabel:
                deptObj ? `${deptObj.code} — ${deptObj.name}` : user.role === 'department_admin' ? user.departmentName || user.departmentId : 'All Departments',
              courseLabel: sesObj
                ? `${sesObj.courseCode} (${sesObj.sessionDate})`
                : crsObj
                  ? `${crsObj.courseCode} — ${crsObj.courseTitle}`
                  : 'All Authorised Courses',
              dateRangeLabel:
                dateFrom || dateTo ? `${dateFrom || 'Start'} to ${dateTo || 'Present'}` : 'All Dates',
              statusLabel: statusFilter ? statusFilter.toUpperCase() : 'All Statuses',
              studentQuery: studentFilter,
            },
            lateCountPolicy: settings.lateCountPolicy,
            summary: computeExportSummary(pdfRows, settings.lateCountPolicy),
          },
          pdfRows
        );
        return;
      }

      const headers = [
        'Course Code',
        'Course Title',
        'Session Date',
        'Student Name',
        'Matriculation Number',
        'Attendance Status',
        'Initial Check-in Timestamp',
        'Second Checkpoint Result',
        'Correction Notes',
      ];

      const lines = [headers.map(escapeCsv).join(',')];
      for (const r of rows) {
        const s = sessionMap.get(r.sessionId)!;
        lines.push(
          [
            s.courseCode,
            s.courseTitle,
            s.sessionDate,
            r.studentName,
            r.matricNumber,
            r.status,
            r.checkInTime || '',
            r.checkpointStatus,
            r.correctionReason || '',
          ]
            .map(escapeCsv)
            .join(',')
        );
      }

      if (format === 'xls' || format === 'excel') {
        res.setHeader('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.xls"`);
        res.send(`\uFEFF${lines.join('\r\n')}`);
        return;
      }

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.csv"`);
      res.send(`\uFEFF${lines.join('\r\n')}`);
    }
  );

  // Audit Logs (Strictly hidden from students)
  router.get(
    '/audit-logs',
    requireAuth,
    requireRole(['system_admin', 'department_admin', 'lecturer']),
    (req: RequestWithAuth, res: Response) => {
      const user = req.authContext!.user!;
      const actionFilter = String(req.query.action || '');
      let logs = db.state.auditLogs;
      if (user.role === 'department_admin') {
        logs = logs.filter((l) => !l.departmentId || l.departmentId === user.departmentId);
      } else if (user.role === 'lecturer') {
        logs = logs.filter((l) => l.actorUid === user.uid);
      }
      if (actionFilter) {
        logs = logs.filter((l) => l.action === actionFilter);
      }
      res.json(logs.slice(0, 200));
    }
  );

  // Notifications
  router.get('/notifications', requireAuth, async (req: RequestWithAuth, res: Response) => {
    const user = req.authContext!.user;
    if (user?.role === 'student' && user.studentId) {
      const student = db.state.students.find((s) => s.id === user.studentId);
      if (student) await syncStudentNotifications(student);
    }
    const uidVal = req.authContext!.uid;
    const category = String(req.query.category || '');
    let list = db.state.notifications
      .filter((n) => n.recipientUid === uidVal)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (category) {
      list = list.filter((n) => (n.category || 'info') === category);
    }
    res.json(list.slice(0, 50));
  });

  router.post('/notifications/:id/read', requireAuth, async (req: RequestWithAuth, res: Response) => {
    await db.markNotificationRead(req.params.id, req.authContext!.uid);
    res.json({ ok: true });
  });

  router.post('/notifications/read-all', requireAuth, async (req: RequestWithAuth, res: Response) => {
    const updated = await db.markAllNotificationsRead(req.authContext!.uid);
    res.json({ ok: true, updated });
  });

  // Reset Demo Data (Dev / Admin)
  router.post(
    '/admin/reset-demo',
    requireAuth,
    requireRole(['system_admin']),
    async (_req, res) => {
      if (!DEMO_MODE_ENABLED) {
        res.status(403).json({ error: 'Demo mode is disabled.' });
        return;
      }
      await db.seedFirestoreDemo();
      res.json({ ok: true });
    }
  );

  app.use('/api', router);
}
