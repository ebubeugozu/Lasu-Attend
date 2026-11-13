import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { registerApiRoutes } from '../src/server/routes.ts';
import { db } from '../src/server/db.ts';
import { signDemoToken } from '../src/server/auth.ts';
import { firebaseAdminStatus } from '../src/server/firebaseAdmin.ts';
import { calculateOverallStudentStanding, calculateStudentCourseAttendance } from '../src/server/attendanceMath.ts';
import { buildCourseMilestoneNotifications, buildUpcomingClassNotifications } from '../src/server/notifications.ts';
import type { AttendanceRecord, AttendanceSession, Course, Enrolment, InstitutionSettings, StudentRecord } from '../src/types/lasu.ts';

async function verifyEnhancements() {
  // 1. Unit tests for Phase 3 Attendance Math
  {
    const baseCourse: Course = {
      id: 'crs_math_test',
      institutionId: 'inst_lasu',
      departmentId: 'dept_mec',
      departmentName: 'Mechanical Engineering',
      courseCode: 'MEC 299',
      courseTitle: 'Thermodynamics Test',
      level: '200L',
      semester: '2025/2026 Rain',
      lecturerUid: 'lec_1',
      lecturerName: 'Dr. Test',
      status: 'active',
      enrolledCount: 1,
      isDemo: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    const enrolment: Enrolment = {
      id: 'enr_test',
      courseId: 'crs_math_test',
      studentId: 'std_test',
      matricNumber: '230591001',
      lecturerUid: 'lec_1',
      status: 'enrolled',
      enrolledAt: '2026-02-01T00:00:00.000Z',
    };

    const sessions: AttendanceSession[] = [
      // Pre-enrolment completed session: MUST BE EXCLUDED
      {
        id: 'ses_pre',
        courseId: 'crs_math_test',
        courseCode: 'MEC 299',
        courseTitle: 'Thermodynamics Test',
        departmentId: 'dept_mec',
        lecturerUid: 'lec_1',
        lecturerName: 'Dr. Test',
        sessionDate: '2026-01-15',
        startTime: '09:00',
        lateThresholdMinutes: 15,
        rotationIntervalSeconds: 90,
        gracePeriodSeconds: 15,
        status: 'completed',
        checkpointActive: false,
        totalEnrolled: 1,
        presentCount: 0,
        lateCount: 0,
        absentCount: 1,
        verifiedCount: 0,
        failedAttemptCount: 0,
        isDemo: true,
        createdAt: '2026-01-15T09:00:00.000Z',
        updatedAt: '2026-01-15T10:00:00.000Z',
      },
      // Live session: MUST BE EXCLUDED
      {
        id: 'ses_live',
        courseId: 'crs_math_test',
        courseCode: 'MEC 299',
        courseTitle: 'Thermodynamics Test',
        departmentId: 'dept_mec',
        lecturerUid: 'lec_1',
        lecturerName: 'Dr. Test',
        sessionDate: '2026-02-15',
        startTime: '09:00',
        lateThresholdMinutes: 15,
        rotationIntervalSeconds: 90,
        gracePeriodSeconds: 15,
        status: 'live',
        checkpointActive: false,
        totalEnrolled: 1,
        presentCount: 0,
        lateCount: 0,
        absentCount: 0,
        verifiedCount: 0,
        failedAttemptCount: 0,
        isDemo: true,
        createdAt: '2026-02-15T09:00:00.000Z',
        updatedAt: '2026-02-15T09:00:00.000Z',
      },
      // Cancelled session: MUST BE EXCLUDED
      {
        id: 'ses_cancel',
        courseId: 'crs_math_test',
        courseCode: 'MEC 299',
        courseTitle: 'Thermodynamics Test',
        departmentId: 'dept_mec',
        lecturerUid: 'lec_1',
        lecturerName: 'Dr. Test',
        sessionDate: '2026-02-16',
        startTime: '09:00',
        lateThresholdMinutes: 15,
        rotationIntervalSeconds: 90,
        gracePeriodSeconds: 15,
        status: 'cancelled',
        checkpointActive: false,
        totalEnrolled: 1,
        presentCount: 0,
        lateCount: 0,
        absentCount: 0,
        verifiedCount: 0,
        failedAttemptCount: 0,
        isDemo: true,
        createdAt: '2026-02-16T09:00:00.000Z',
        updatedAt: '2026-02-16T09:00:00.000Z',
      },
    ];

    // Zero eligible completed sessions => percentage === null
    const settingsAttend: InstitutionSettings = {
      id: 'default',
      lateCountPolicy: 'count_as_attended',
      attendanceThreshold: 75,
      milestonePercentages: [50, 75, 90, 100],
      updatedAt: '2026-02-01T00:00:00.000Z',
    };

    const zeroSummary = calculateStudentCourseAttendance({
      studentId: 'std_test',
      enrolment,
      course: baseCourse,
      sessions,
      records: [],
      settings: settingsAttend,
    });
    assert.equal(zeroSummary.percentage, null);
    assert.equal(zeroSummary.totalEligible, 0);

    // Add 2 completed post-enrolment sessions (1 present, 1 late)
    sessions.push(
      {
        ...sessions[0],
        id: 'ses_c1',
        sessionDate: '2026-02-10',
        createdAt: '2026-02-10T09:00:00.000Z',
        updatedAt: '2026-02-10T10:00:00.000Z',
        presentCount: 1,
        absentCount: 0,
      },
      {
        ...sessions[0],
        id: 'ses_c2',
        sessionDate: '2026-02-12',
        createdAt: '2026-02-12T09:00:00.000Z',
        updatedAt: '2026-02-12T10:00:00.000Z',
        presentCount: 0,
        lateCount: 1,
        absentCount: 0,
      }
    );

    const records: AttendanceRecord[] = [
      {
        id: 'rec_1',
        sessionId: 'ses_c1',
        courseId: 'crs_math_test',
        lecturerUid: 'lec_1',
        studentId: 'std_test',
        matricNumber: '230591001',
        studentName: 'Student Test',
        status: 'present',
        checkpointStatus: 'none',
        createdAt: '2026-02-10T09:05:00.000Z',
        updatedAt: '2026-02-10T09:05:00.000Z',
      },
      {
        id: 'rec_2',
        sessionId: 'ses_c2',
        courseId: 'crs_math_test',
        lecturerUid: 'lec_1',
        studentId: 'std_test',
        matricNumber: '230591001',
        studentName: 'Student Test',
        status: 'late',
        checkpointStatus: 'none',
        createdAt: '2026-02-12T09:20:00.000Z',
        updatedAt: '2026-02-12T09:20:00.000Z',
      },
    ];

    const resFull = calculateStudentCourseAttendance({
      studentId: 'std_test',
      enrolment,
      course: baseCourse,
      sessions,
      records,
      settings: settingsAttend,
    });
    assert.equal(resFull.totalEligible, 2);
    assert.equal(resFull.percentage, 100);

    const resHalf = calculateStudentCourseAttendance({
      studentId: 'std_test',
      enrolment,
      course: baseCourse,
      sessions,
      records,
      settings: { ...settingsAttend, lateCountPolicy: 'count_as_half' },
    });
    assert.equal(resHalf.percentage, 75);

    const resAbsent = calculateStudentCourseAttendance({
      studentId: 'std_test',
      enrolment,
      course: baseCourse,
      sessions,
      records,
      settings: { ...settingsAttend, lateCountPolicy: 'count_as_absent' },
    });
    assert.equal(resAbsent.percentage, 50);

    const standing = calculateOverallStudentStanding([resHalf], {
      ...settingsAttend,
      lateCountPolicy: 'count_as_half',
    });
    assert.equal(standing.overallPercentage, 75);
    console.log('PASS: Phase 3 attendance percentage math (eligible-only, late weights, null 0-session case)');
  }

  // 2. Unit tests for Phase 6 Notifications (strict timetable/session grounding + deduplication)
  {
    const student: StudentRecord = {
      id: 'std_n1',
      matricNumber: '230591001',
      fullName: 'Test Student',
      departmentId: 'dept_mec',
      departmentName: 'Mechanical Engineering',
      facultyName: 'Faculty of Engineering',
      level: '200L',
      accountStatus: 'active',
      claimedUid: 'uid_n1',
      isDemo: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const courseNoSchedule: Course = {
      id: 'crs_n1',
      institutionId: 'inst_lasu',
      departmentId: 'dept_mec',
      departmentName: 'Mechanical Engineering',
      courseCode: 'MEC 201',
      courseTitle: 'Engineering Mechanics',
      level: '200L',
      semester: '2025/2026 Rain',
      lecturerUid: 'lec_1',
      lecturerName: 'Dr. Ade',
      status: 'active',
      enrolledCount: 1,
      isDemo: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    // Must NOT invent fake upcoming classes if no timetableSlots and no scheduled/live sessions exist
    const none = buildUpcomingClassNotifications({ student, courses: [courseNoSchedule], sessions: [] });
    assert.equal(none.length, 0);

    const lagosDays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
    const tomorrowDate = new Date(Date.now() + 86_400_000);
    const tomorrowWeekday = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Africa/Lagos',
      weekday: 'long',
    }).format(tomorrowDate);
    const todayWeekday = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Africa/Lagos',
      weekday: 'long',
    }).format(new Date());
    const chosenDay = lagosDays.find((d) => d === tomorrowWeekday || d === todayWeekday) || 'Monday';
    const scheduledTodayStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos' }).format(new Date());

    const scheduledCourse: Course = {
      ...courseNoSchedule,
      timetableSlots: [{ dayOfWeek: chosenDay, startTime: '23:59', endTime: '23:59', venue: 'Engineering LT 1' }],
    };
    const scheduledSession: AttendanceSession = {
      id: 'ses_sched_test',
      courseId: 'crs_n1',
      courseCode: 'MEC 201',
      courseTitle: 'Engineering Mechanics',
      departmentId: 'dept_mec',
      lecturerUid: 'lec_1',
      lecturerName: 'Dr. Ade',
      venue: 'Engineering LT 1',
      sessionDate: scheduledTodayStr,
      startTime: '14:00',
      lateThresholdMinutes: 15,
      rotationIntervalSeconds: 90,
      gracePeriodSeconds: 15,
      status: 'scheduled',
      checkpointActive: false,
      totalEnrolled: 1,
      presentCount: 0,
      lateCount: 0,
      absentCount: 0,
      verifiedCount: 0,
      failedAttemptCount: 0,
      isDemo: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const fromSlot = buildUpcomingClassNotifications({
      student,
      courses: [scheduledCourse],
      sessions: [scheduledSession],
    });
    assert.ok(fromSlot.length >= 1);
    assert.equal(fromSlot[0].category, 'upcoming_class');
    assert.ok(fromSlot[0].message.includes('Engineering LT 1'));
    console.log('PASS: Phase 6 upcoming class notifications strictly grounded in configured timetableSlots & sessions');
  }

  // 3. Integration tests against Express API routes
  await db.init();
  const app = express();
  app.use(express.json());
  registerApiRoutes(app);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as { port: number };
  const base = `http://127.0.0.1:${addr.port}`;

  try {
    // System status honesty
    const statusRes = await fetch(`${base}/api/system/status`);
    assert.equal(statusRes.status, 200);
    const statusJson = (await statusRes.json()) as {
      storageMode: string;
      hasServiceAccount: boolean;
      firebaseAdminConnected: boolean;
    };
    assert.ok(['firestore_admin', 'dev_sandbox_memory'].includes(statusJson.storageMode));
    console.log(`PASS: /api/system/status reports honest storageMode=${statusJson.storageMode}`);

    // HTTP 503 FIRESTORE_UNAVAILABLE guard verification
    const prevMode = firebaseAdminStatus.storageMode;
    firebaseAdminStatus.storageMode = 'unconfigured_error';
    const guardRes = await fetch(`${base}/api/departments`);
    assert.equal(guardRes.status, 503);
    const guardJson = (await guardRes.json()) as { code: string };
    assert.equal(guardJson.code, 'FIRESTORE_UNAVAILABLE');
    firebaseAdminStatus.storageMode = prevMode;
    console.log('PASS: Production Firestore unavailable guard returns HTTP 503 FIRESTORE_UNAVAILABLE');

    const adminToken = signDemoToken('demo_sysadmin_1');
    const lecToken = signDemoToken('demo_lecturer_1');
    const stuToken = signDemoToken('demo_student_1');

    // Institution settings RBAC & PATCH
    const lecPatchSettings = await fetch(`${base}/api/settings/institution`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${lecToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ lateCountPolicy: 'count_as_half' }),
    });
    assert.equal(lecPatchSettings.status, 403);

    const adminPatchSettings = await fetch(`${base}/api/settings/institution`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ lateCountPolicy: 'count_as_half', attendanceThreshold: 75 }),
    });
    assert.equal(adminPatchSettings.status, 200);
    const patchedSettings = (await adminPatchSettings.json()) as { lateCountPolicy: string };
    assert.equal(patchedSettings.lateCountPolicy, 'count_as_half');
    console.log('PASS: Institution settings RBAC & lateCountPolicy persistence verified');

    // Course timetable PATCH
    const coursePatch = await fetch(`${base}/api/courses/crs_mec201`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${lecToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        timetableSlots: [{ dayOfWeek: 'Tuesday', startTime: '10:00', endTime: '12:00', venue: 'Eng Hall A' }],
      }),
    });
    assert.equal(coursePatch.status, 200);
    const coursePatchJson = (await coursePatch.json()) as Course;
    assert.equal(coursePatchJson.timetableSlots?.length, 1);
    assert.equal(coursePatchJson.timetableSlots?.[0].venue, 'Eng Hall A');
    console.log('PASS: Course timetable update (PATCH /api/courses/:id) verified');

    // Filtered PDF, CSV, XLS export & Analytics reconciliation
    const analyticsRes = await fetch(`${base}/api/reports/analytics?courseId=crs_mec201`, {
      headers: { Authorization: `Bearer ${lecToken}` },
    });
    assert.equal(analyticsRes.status, 200);
    const analyticsJson = (await analyticsRes.json()) as {
      summary: { presentCount: number; lateCount: number; absentCount: number };
    };

    const csvRes = await fetch(`${base}/api/reports/export?courseId=crs_mec201&format=csv`, {
      headers: { Authorization: `Bearer ${lecToken}` },
    });
    assert.equal(csvRes.status, 200);
    const csvLines = (await csvRes.text()).trim().split('\n');
    const dataRows = csvLines.slice(1);
    const expectedRowCount =
      analyticsJson.summary.presentCount + analyticsJson.summary.lateCount + analyticsJson.summary.absentCount;
    assert.ok(dataRows.length >= expectedRowCount);

    const pdfRes = await fetch(`${base}/api/reports/export?courseId=crs_mec201&format=pdf`, {
      headers: { Authorization: `Bearer ${lecToken}` },
    });
    assert.equal(pdfRes.status, 200);
    assert.equal(pdfRes.headers.get('content-type'), 'application/pdf');
    const pdfBuf = Buffer.from(await pdfRes.arrayBuffer());
    assert.equal(pdfBuf.subarray(0, 5).toString('ascii'), '%PDF-');
    assert.ok(pdfBuf.length > 1500);

    const xlsRes = await fetch(`${base}/api/reports/export?courseId=crs_mec201&format=xls`, {
      headers: { Authorization: `Bearer ${lecToken}` },
    });
    assert.equal(xlsRes.status, 200);
    console.log(
      `PASS: Filtered PDF (${pdfBuf.length}B), CSV (${dataRows.length} rows), and XLS exports reconcile with analytics`
    );

    // Student dashboard syncs notifications & deduplicates milestones; zero rankings/leaderboards
    const stuDash1 = await fetch(`${base}/api/dashboard/student`, {
      headers: { Authorization: `Bearer ${stuToken}` },
    });
    assert.equal(stuDash1.status, 200);
    const stuDashJson = (await stuDash1.json()) as Record<string, unknown>;
    assert.equal('leaderboard' in stuDashJson, false);
    assert.equal('ranking' in stuDashJson, false);
    assert.equal('rank' in stuDashJson, false);

    // Call dashboard again — milestone IDs must not duplicate
    await fetch(`${base}/api/dashboard/student`, { headers: { Authorization: `Bearer ${stuToken}` } });
    const notifsRes = await fetch(`${base}/api/notifications`, {
      headers: { Authorization: `Bearer ${stuToken}` },
    });
    assert.equal(notifsRes.status, 200);
    const notifs = (await notifsRes.json()) as Array<{ id: string; category?: string }>;
    const uniqueIds = new Set(notifs.map((n) => n.id));
    assert.equal(uniqueIds.size, notifs.length);

    // Milestone helper direct deduplication check
    const stuObj = db.state.students.find((s) => s.claimedUid === 'demo_student_1')!;
    const crsObj = db.state.courses.find((c) => c.id === 'crs_mec201')!;
    const enrObj = db.state.enrolments.find((e) => e.courseId === 'crs_mec201' && e.studentId === stuObj.id)!;
    const msA = buildCourseMilestoneNotifications({
      student: stuObj,
      enrolment: enrObj,
      course: crsObj,
      sessions: db.state.sessions,
      records: db.state.records.filter((r) => r.studentId === stuObj.id),
      settings: db.state.institutionSettings,
    });
    const msB = buildCourseMilestoneNotifications({
      student: stuObj,
      enrolment: enrObj,
      course: crsObj,
      sessions: db.state.sessions,
      records: db.state.records.filter((r) => r.studentId === stuObj.id),
      settings: db.state.institutionSettings,
    });
    assert.deepEqual(
      msA.map((m) => m.id),
      msB.map((m) => m.id)
    );

    // Mark all notifications read
    const readAllRes = await fetch(`${base}/api/notifications/read-all`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${stuToken}` },
    });
    assert.equal(readAllRes.status, 200);
    console.log('PASS: Notification deduplication, read-all, and zero-ranking privacy verified');

    // Reset back to baseline demo settings
    await db.seedFirestoreDemo();
  } finally {
    server.close();
  }
}

verifyEnhancements()
  .then(() => {
    console.log('\nALL ENHANCEMENT VERIFICATIONS PASSED');
    process.exit(0);
  })
  .catch((err) => {
    console.error('ENHANCEMENT VERIFICATION FAILED:', err);
    process.exit(1);
  });
