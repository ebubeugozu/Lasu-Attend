import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { registerApiRoutes } from '../src/server/routes.ts';
import { qrEngine } from '../src/server/qrEngine.ts';
import { db } from '../src/server/db.ts';
import { signDemoToken } from '../src/server/auth.ts';

async function run800BurstTest() {
  await db.init();

  const app = express();
  app.use(express.json());
  registerApiRoutes(app);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as { port: number };
  const base = `http://127.0.0.1:${addr.port}`;
  qrEngine.startTicker();

  try {
    // Prepare 800 active student PlatformUser entries in db for MEC 201
    const now = new Date().toISOString();
    const studentTokens: string[] = [];
    for (let i = 0; i < 800; i++) {
      const matric = String(230591001 + i);
      const st = db.state.students.find((s) => s.matricNumber === matric)!;
      st.accountStatus = 'active';
      const uid = st.claimedUid || `demo_student_uid_${matric}`;
      st.claimedUid = uid;
      if (!db.state.users.some((u) => u.uid === uid)) {
        db.state.users.push({
          uid,
          email: `burst.${matric}@lasu.edu.ng`,
          displayName: st.fullName,
          role: 'student',
          departmentId: st.departmentId,
          status: 'active',
          studentId: st.id,
          matricNumber: matric,
          isDemo: true,
          createdAt: now,
          updatedAt: now,
        });
      }
      studentTokens.push(signDemoToken(uid));
    }

    const lecToken = signDemoToken('demo_lecturer_1');
    const sesRes = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${lecToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        courseId: 'crs_mec201',
        lectureTitle: '800-Student Concurrent Burst Test',
        venue: 'Engineering Lecture Theatre 1',
        startImmediately: true,
      }),
    });
    assert.equal(sesRes.status, 201);
    const sesJson = (await sesRes.json()) as { session: { id: string }; qrPayload: { token: string } };
    const sessionId = sesJson.session.id;
    const qrToken = sesJson.qrPayload.token;

    // Fire 800 concurrent check-ins simultaneously
    const t0 = performance.now();
    const latencies: number[] = [];
    const responses = await Promise.all(
      studentTokens.map(async (tok) => {
        const reqStart = performance.now();
        const r = await fetch(`${base}/api/attendance/checkin`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, token: qrToken }),
        });
        latencies.push(performance.now() - reqStart);
        return r.status;
      })
    );
    const totalMs = performance.now() - t0;

    const okCount = responses.filter((s) => s === 201).length;
    assert.equal(okCount, 800, `Expected 800 HTTP 201 check-ins, got ${okCount}`);

    latencies.sort((a, b) => a - b);
    const p50 = latencies[Math.floor(latencies.length * 0.5)];
    const p95 = latencies[Math.floor(latencies.length * 0.95)];

    // Verify duplicate replay storm of 100 concurrent retries yields zero duplicates
    const dupResponses = await Promise.all(
      studentTokens.slice(0, 100).map((tok) =>
        fetch(`${base}/api/attendance/checkin`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, token: qrToken }),
        }).then((r) => r.status)
      )
    );
    assert.equal(dupResponses.every((s) => s === 409), true);

    const sessionAfter = (await db.getSessionById(sessionId))!;
    assert.equal(sessionAfter.presentCount + sessionAfter.lateCount, 800);

    console.log(
      JSON.stringify(
        {
          concurrentRequests: 800,
          accepted201: okCount,
          duplicateReplay100Rejected409: dupResponses.length,
          totalDurationMs: Math.round(totalMs),
          p50LatencyMs: Math.round(p50),
          p95LatencyMs: Math.round(p95),
          finalPresentCount: sessionAfter.presentCount,
        },
        null,
        2
      )
    );

    // Cleanly reset dataset after test
    await db.seedFirestoreDemo();
  } finally {
    qrEngine.destroy();
    server.close();
  }
}

run800BurstTest()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('800-BURST TEST FAILED:', err);
    process.exit(1);
  });
