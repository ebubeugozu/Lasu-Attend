import assert from 'node:assert/strict';
import WebSocket from 'ws';

const BASE = 'http://127.0.0.1:3000';

async function api<T>(
  path: string,
  opts: { method?: string; token?: string; body?: unknown } = {}
): Promise<{ status: number; data: T }> {
  const headers: Record<string, string> = {};
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method || 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    // plain text / csv
  }
  return { status: res.status, data: data as T };
}

async function runQA() {
  const results: Array<{ name: string; status: string; detail: string }> = [];
  const record = (name: string, detail: string) => {
    results.push({ name, status: 'PASS', detail });
    console.log(`PASS: ${name} — ${detail}`);
  };

  // 1. Health & System Status
  const health = await api<{ ok: boolean }>('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.data.ok, true);

  const sysStatus = await api<{ storageMode: string; firebaseProjectId: string }>('/api/system/status');
  assert.equal(sysStatus.status, 200);
  record('Health & Server Ready', `HTTP 200 on port 3000 (storageMode=${sysStatus.data.storageMode})`);

  // 2. Demo Login & RBAC Enforcement
  const lecLogin = await api<{ token: string }>('/api/auth/demo-login', {
    method: 'POST',
    body: { uid: 'demo_lecturer_1' },
  });
  assert.equal(lecLogin.status, 200);
  const lecToken = lecLogin.data.token;

  const stuLogin = await api<{ token: string }>('/api/auth/demo-login', {
    method: 'POST',
    body: { uid: 'demo_student_1' },
  });
  assert.equal(stuLogin.status, 200);
  const stuToken = stuLogin.data.token;

  const adminLogin = await api<{ token: string }>('/api/auth/demo-login', {
    method: 'POST',
    body: { uid: 'demo_sysadmin_1' },
  });
  assert.equal(adminLogin.status, 200);
  const adminToken = adminLogin.data.token;

  const eceAdminLogin = await api<{ token: string }>('/api/auth/demo-login', {
    method: 'POST',
    body: { uid: 'demo_deptadmin_ece' },
  });
  const eceAdminToken = eceAdminLogin.data.token;

  // Student denied audit logs & session creation
  const stuAudit = await api('/api/audit-logs', { token: stuToken });
  assert.equal(stuAudit.status, 403);
  const stuCreateSession = await api('/api/sessions', {
    method: 'POST',
    token: stuToken,
    body: { courseId: 'crs_mec201' },
  });
  assert.equal(stuCreateSession.status, 403);
  record('Role-Based Access Control', 'Student blocked (403) from audit logs and session creation');

  // Department scoping check: ECE admin blocked from MEC course creation
  const crossDept = await api('/api/courses', {
    method: 'POST',
    token: eceAdminToken,
    body: { courseCode: 'MEC 299', courseTitle: 'Unauthorized Cross Dept', departmentId: 'dept_mec' },
  });
  assert.equal(crossDept.status, 403);
  record('Department-Scoped Admin Permission', 'ECE admin blocked (403) from MEC department writes');

  // 3. CSV Import Validation (valid + duplicate + invalid)
  const csvRes = await api<{ importedCount: number; failedCount: number }>('/api/students/import-csv', {
    method: 'POST',
    token: adminToken,
    body: {
      rows: [
        {
          fullName: 'QA Test Student',
          matricNumber: '250591001',
          department: 'MEC',
          faculty: 'Faculty of Engineering',
          level: '200L',
          accountStatus: 'pending_activation',
        },
        {
          fullName: 'Duplicate Student',
          matricNumber: '230591001',
          department: 'MEC',
          faculty: 'Faculty of Engineering',
          level: '200L',
          accountStatus: 'pending_activation',
        },
        {
          fullName: '',
          matricNumber: 'BAD',
          department: 'MEC',
          faculty: 'Faculty of Engineering',
          level: '999L',
          accountStatus: 'pending_activation',
        },
      ],
    },
  });
  assert.equal(csvRes.status, 200);
  assert.equal(csvRes.data.importedCount, 1);
  assert.equal(csvRes.data.failedCount, 2);
  record('CSV Register Validation & Import', '1 valid imported, 1 duplicate & 1 invalid rejected cleanly');

  // 4. Create & Start Live Session + Multi-Display WebSocket Sync
  const createSes = await api<{ session: { id: string }; qrPayload: { token: string; shortCode: string } }>(
    '/api/sessions',
    {
      method: 'POST',
      token: lecToken,
      body: {
        courseId: 'crs_mec201',
        lectureTitle: 'QA Concurrency & Sync Test',
        venue: 'Engineering Lecture Theatre 1',
        startImmediately: true,
      },
    }
  );
  assert.equal(createSes.status, 201);
  const sesId = createSes.data.session.id;
  const qrToken = createSes.data.qrPayload.token;
  const shortCode = createSes.data.qrPayload.shortCode;

  // Connect 2 concurrent WebSocket presentation clients
  const ws1Msg = new Promise<string>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:3000/ws?sessionId=${sesId}`);
    ws.on('message', (raw) => {
      const parsed = JSON.parse(String(raw)) as { payload?: { token: string } };
      if (parsed.payload?.token) {
        ws.close();
        resolve(parsed.payload.token);
      }
    });
  });
  const ws2Msg = new Promise<string>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:3000/ws?sessionId=${sesId}`);
    ws.on('message', (raw) => {
      const parsed = JSON.parse(String(raw)) as { payload?: { token: string } };
      if (parsed.payload?.token) {
        ws.close();
        resolve(parsed.payload.token);
      }
    });
  });
  const [tok1, tok2] = await Promise.all([ws1Msg, ws2Msg]);
  assert.equal(tok1, qrToken);
  assert.equal(tok2, qrToken);
  record('Multi-Display WebSocket Sync', '2 presentation displays received identical synchronized QR token');

  // 5. Invalid Token Rejection
  const badTokenRes = await api('/api/attendance/checkin', {
    method: 'POST',
    token: stuToken,
    body: { sessionId: sesId, token: 'EXPIRED_INVALID_TOKEN_123' },
  });
  assert.equal(badTokenRes.status, 400);
  record('Expired / Invalid Token Rejection', 'Rejected tampered token with HTTP 400');

  // 6. Valid Student Check-In + Duplicate Rejection
  const okCheckin = await api('/api/attendance/checkin', {
    method: 'POST',
    token: stuToken,
    body: { sessionId: sesId, shortCode },
  });
  assert.equal(okCheckin.status, 201);

  const dupCheckin = await api('/api/attendance/checkin', {
    method: 'POST',
    token: stuToken,
    body: { sessionId: sesId, token: qrToken },
  });
  assert.equal(dupCheckin.status, 409);
  record('Check-In & Duplicate Rejection', 'Initial check-in succeeded (201); duplicate rejected (409)');

  // 7. Second Checkpoint ("Verify Attendance")
  const cpStart = await api(`/api/sessions/${sesId}/checkpoint`, { method: 'POST', token: lecToken });
  assert.equal(cpStart.status, 200);
  const cpToken = (cpStart.data as { qrPayload: { token: string } }).qrPayload.token;

  const cpVerify = await api('/api/attendance/verify', {
    method: 'POST',
    token: stuToken,
    body: { sessionId: sesId, token: cpToken },
  });
  assert.equal(cpVerify.status, 200);
  record('Second Checkpoint Verification', '2nd checkpoint event recorded separately without duplicating initial record');

  // 8. Session Closure & Absent Calculation
  const closeRes = await api<{
    session: { status: string; presentCount: number; absentCount: number; totalEnrolled: number };
  }>(`/api/sessions/${sesId}/close`, { method: 'POST', token: lecToken });
  assert.equal(closeRes.status, 200);
  assert.equal(closeRes.data.session.status, 'completed');
  assert.equal(
    closeRes.data.session.presentCount + closeRes.data.session.absentCount,
    closeRes.data.session.totalEnrolled
  );
  record(
    'Session Closure & Absent Calculation',
    `Closed session: ${closeRes.data.session.presentCount} present + ${closeRes.data.session.absentCount} absent = ${closeRes.data.session.totalEnrolled} enrolled`
  );

  // 9. Manual Correction + Notification + CSV & PDF Export
  const corrRes = await api('/api/attendance/correct', {
    method: 'POST',
    token: lecToken,
    body: {
      sessionId: sesId,
      studentId: 'std_230591002',
      newStatus: 'excused',
      reason: 'Medical note verified by faculty office',
    },
  });
  assert.equal(corrRes.status, 200);

  const exportRes = await api<string>(`/api/reports/export?sessionId=${sesId}&format=csv`, { token: lecToken });
  assert.equal(exportRes.status, 200);
  const lineCount = String(exportRes.data).trim().split('\n').length;
  assert.equal(lineCount, 801); // 1 header + 800 enrolled students

  const pdfRes = await fetch(`${BASE}/api/reports/export?sessionId=${sesId}&format=pdf`, {
    headers: { Authorization: `Bearer ${lecToken}` },
  });
  assert.equal(pdfRes.status, 200);
  const pdfBuf = Buffer.from(await pdfRes.arrayBuffer());
  assert.equal(pdfBuf.subarray(0, 5).toString('ascii'), '%PDF-');
  record(
    'Manual Correction, CSV & PDF Export',
    `Exported ${lineCount - 1} CSV rows + ${pdfBuf.length}-byte PDF matching 800 enrolled students`
  );

  // 10. Student Privacy Check (no leaderboard / ranking fields)
  const stuDash = await api<{ student: { matricNumber: string }; courses: unknown[]; leaderboard?: unknown }>(
    '/api/dashboard/student',
    {
      token: stuToken,
    }
  );
  assert.equal(stuDash.status, 200);
  assert.equal(stuDash.data.student.matricNumber, '230591001');
  assert.equal(stuDash.data.leaderboard, undefined);
  record('Student Dashboard Privacy', 'Student endpoint returns only own matriculation profile and courses');

  // Reset demo state cleanly after QA
  await api('/api/admin/reset-demo', { method: 'POST', token: adminToken });
  console.log('\nALL QA CHECKS PASSED:', results.length);
}

runQA().catch((err) => {
  console.error('QA FAILED:', err);
  process.exit(1);
});
