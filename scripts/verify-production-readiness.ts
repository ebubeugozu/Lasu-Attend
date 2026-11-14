import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import WebSocket from 'ws';
import { signDemoToken } from '../src/server/auth.ts';
import { db } from '../src/server/db.ts';
import { createApp } from '../server.ts';

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close(() => reject(new Error('Failed to acquire free port')));
        return;
      }
      const { port } = addr;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function waitForHealth(baseUrl: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for ${baseUrl}/api/health`);
}

function stopChild(proc: ChildProcess | null): Promise<void> {
  return new Promise((resolve) => {
    if (!proc || proc.exitCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        // ignore
      }
      resolve();
    }, 3000);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    proc.kill('SIGTERM');
  });
}

// Lightweight RESP2 TCP Redis server supporting ioredis Pub/Sub, GET/SET PX NX, DEL, EVAL, INFO, PING
function startMockRedisServer(): Promise<{
  port: number;
  url: string;
  close: () => Promise<void>;
}> {
  interface Entry {
    value: string;
    expiresAt: number | null;
  }
  const kv = new Map<string, Entry>();
  const channels = new Map<string, Set<net.Socket>>();
  const sockets = new Set<net.Socket>();

  function getEntry(key: string): string | null {
    const e = kv.get(key);
    if (!e) return null;
    if (e.expiresAt !== null && Date.now() > e.expiresAt) {
      kv.delete(key);
      return null;
    }
    return e.value;
  }

  function encodeBulk(str: string | null): string {
    if (str === null) return '$-1\r\n';
    return `$${Buffer.byteLength(str)}\r\n${str}\r\n`;
  }

  function parseRespCommands(buf: Buffer): { commands: string[][]; remaining: Buffer } {
    const commands: string[][] = [];
    let offset = 0;

    while (offset < buf.length) {
      if (buf[offset] !== 42 /* '*' */) {
        const nl = buf.indexOf('\r\n', offset);
        if (nl === -1) break;
        const line = buf.subarray(offset, nl).toString('utf8').trim();
        if (line) commands.push(line.split(/\s+/));
        offset = nl + 2;
        continue;
      }

      const headerEnd = buf.indexOf('\r\n', offset);
      if (headerEnd === -1) break;
      const argCount = Number(buf.subarray(offset + 1, headerEnd).toString('utf8'));
      let cursor = headerEnd + 2;
      const args: string[] = [];
      let incomplete = false;

      for (let i = 0; i < argCount; i++) {
        if (cursor >= buf.length || buf[cursor] !== 36 /* '$' */) {
          incomplete = true;
          break;
        }
        const lenEnd = buf.indexOf('\r\n', cursor);
        if (lenEnd === -1) {
          incomplete = true;
          break;
        }
        const byteLen = Number(buf.subarray(cursor + 1, lenEnd).toString('utf8'));
        const dataStart = lenEnd + 2;
        const dataEnd = dataStart + byteLen;
        if (buf.length < dataEnd + 2) {
          incomplete = true;
          break;
        }
        args.push(buf.subarray(dataStart, dataEnd).toString('utf8'));
        cursor = dataEnd + 2;
      }

      if (incomplete) break;
      commands.push(args);
      offset = cursor;
    }

    return { commands, remaining: buf.subarray(offset) };
  }

  const server = net.createServer((socket) => {
    sockets.add(socket);
    let buffer: Buffer = Buffer.alloc(0);

    socket.on('close', () => {
      sockets.delete(socket);
      for (const subs of channels.values()) {
        subs.delete(socket);
      }
    });

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const parsed = parseRespCommands(buffer);
      buffer = parsed.remaining;

      for (const args of parsed.commands) {
        const cmd = (args[0] || '').toUpperCase();
        if (cmd === 'PING') {
          socket.write('+PONG\r\n');
        } else if (cmd === 'QUIT') {
          socket.write('+OK\r\n');
          socket.end();
        } else if (cmd === 'CLIENT' || cmd === 'SELECT' || cmd === 'AUTH') {
          socket.write('+OK\r\n');
        } else if (cmd === 'INFO') {
          socket.write(encodeBulk('# Server\r\nredis_version:7.2.0\r\nloading:0\r\n'));
        } else if (cmd === 'SUBSCRIBE') {
          let count = 0;
          for (const ch of args.slice(1)) {
            let subs = channels.get(ch);
            if (!subs) {
              subs = new Set();
              channels.set(ch, subs);
            }
            subs.add(socket);
            count += 1;
            socket.write(`*3\r\n${encodeBulk('subscribe')}${encodeBulk(ch)}:${count}\r\n`);
          }
        } else if (cmd === 'PUBLISH') {
          const ch = args[1] || '';
          const msg = args[2] || '';
          const subs = channels.get(ch);
          let delivered = 0;
          if (subs) {
            const frame = `*3\r\n${encodeBulk('message')}${encodeBulk(ch)}${encodeBulk(msg)}`;
            for (const subSocket of subs) {
              if (!subSocket.destroyed) {
                subSocket.write(frame);
                delivered += 1;
              }
            }
          }
          socket.write(`:${delivered}\r\n`);
        } else if (cmd === 'GET') {
          socket.write(encodeBulk(getEntry(args[1] || '')));
        } else if (cmd === 'SET') {
          const key = args[1] || '';
          const value = args[2] || '';
          let nx = false;
          let ttlMs: number | null = null;
          for (let i = 3; i < args.length; i++) {
            const flag = args[i].toUpperCase();
            if (flag === 'NX') nx = true;
            else if (flag === 'PX' && args[i + 1]) {
              ttlMs = Number(args[++i]);
            } else if (flag === 'EX' && args[i + 1]) {
              ttlMs = Number(args[++i]) * 1000;
            }
          }
          if (nx && getEntry(key) !== null) {
            socket.write('$-1\r\n');
          } else {
            kv.set(key, { value, expiresAt: ttlMs ? Date.now() + ttlMs : null });
            socket.write('+OK\r\n');
          }
        } else if (cmd === 'DEL') {
          let deleted = 0;
          for (const key of args.slice(1)) {
            if (kv.delete(key)) deleted += 1;
          }
          socket.write(`:${deleted}\r\n`);
        } else if (cmd === 'EVAL') {
          // Lua atomic lock release: eval(script, 1, lockKey, token)
          const lockKey = args[3] || '';
          const token = args[4] || '';
          if (getEntry(lockKey) === token) {
            kv.delete(lockKey);
            socket.write(':1\r\n');
          } else {
            socket.write(':0\r\n');
          }
        } else {
          socket.write(`-ERR unsupported command '${cmd}'\r\n`);
        }
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to start mock Redis server'));
        return;
      }
      resolve({
        port: addr.port,
        url: `redis://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise<void>((done) => {
            for (const s of sockets) s.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

async function runTests() {
  // 1. Startup Security Guard: NODE_ENV=production must fail fast if SESSION_SECRET is missing or <32 chars
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['server.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'production',
        SESSION_SECRET: 'short-secret',
        FIREBASE_SERVICE_ACCOUNT_JSON: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += String(d);
    });
    child.on('exit', (code) => {
      try {
        assert.notEqual(code, 0, 'Production server must refuse to start with short SESSION_SECRET');
        assert.match(stderr, /SESSION_SECRET/i);
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  });
  console.log('PASS: Production startup refuses missing/weak SESSION_SECRET (< 32 chars)');

  // 2. Production Fail-Closed, Demo Disabled, & 404 /api/* Guard
  const prodPort = await getFreePort();
  let prodChild: ChildProcess | null = null;
  try {
    const prodEnv: Record<string, string | undefined> = {
      ...process.env,
      NODE_ENV: 'production',
      APP_PORT: String(prodPort),
      SESSION_SECRET: 'prod_verify_secret_with_more_than_32_characters_0123456789',
      FIREBASE_SERVICE_ACCOUNT_JSON: '',
      ENABLE_DEMO_MODE: 'true', // must remain disabled in NODE_ENV=production
      REDIS_URL: '',
    };
    prodChild = spawn(process.execPath, ['server.ts'], {
      cwd: process.cwd(),
      env: prodEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const prodBase = `http://127.0.0.1:${prodPort}`;
    await waitForHealth(prodBase);

    const statusRes = await fetch(`${prodBase}/api/system/status`);
    assert.equal(statusRes.status, 200);
    const statusJson = (await statusRes.json()) as {
      demoModeEnabled: boolean;
      storageMode: string;
      redisConfigured: boolean;
    };
    assert.equal(statusJson.demoModeEnabled, false, 'demoModeEnabled must always be false in production');
    assert.equal(statusJson.storageMode, 'unconfigured_error');
    assert.equal(statusJson.redisConfigured, false);

    // Unmatched API path must return JSON 404, not SPA HTML
    const notFoundRes = await fetch(`${prodBase}/api/this-route-does-not-exist`);
    assert.equal(notFoundRes.status, 404);
    const notFoundJson = (await notFoundRes.json()) as { code: string };
    assert.equal(notFoundJson.code, 'NOT_FOUND');

    // Operational routes must fail closed with HTTP 503 FIRESTORE_UNAVAILABLE (no silent sandbox fallback)
    const opsRes = await fetch(`${prodBase}/api/sessions`);
    assert.equal(opsRes.status, 503);
    const opsJson = (await opsRes.json()) as { code: string };
    assert.equal(opsJson.code, 'FIRESTORE_UNAVAILABLE');

    // Demo endpoints must always be disabled in production (403 on login, enabled:false on list)
    const demoAccountsRes = await fetch(`${prodBase}/api/auth/demo-accounts`);
    assert.equal(demoAccountsRes.status, 200);
    const demoAccountsJson = (await demoAccountsRes.json()) as { enabled: boolean; accounts: unknown[] };
    assert.equal(demoAccountsJson.enabled, false);
    assert.equal(demoAccountsJson.accounts.length, 0);

    const demoLoginRes = await fetch(`${prodBase}/api/auth/demo-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid: 'demo_sysadmin_1' }),
    });
    assert.equal(demoLoginRes.status, 403);

    console.log('PASS: Production fail-closed (503 FIRESTORE_UNAVAILABLE), demo disabled, and JSON 404 guard verified');
  } finally {
    await stopChild(prodChild);
  }

  // 3. Paginated /api/audit-logs + /api/admin/bootstrap Token Guard (Express app test)
  const devApp = await createApp({ attachVite: false });
  const devServer = devApp.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => devServer.once('listening', () => resolve()));
  const devPort = (devServer.address() as net.AddressInfo).port;
  const devBase = `http://127.0.0.1:${devPort}`;

  try {
    const adminToken = signDemoToken('demo_sysadmin_1');
    const demoBootstrapRes = await fetch(`${devBase}/api/admin/bootstrap`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ bootstrapToken: 'any_token_1234567890' }),
    });
    assert.equal(demoBootstrapRes.status, 403, 'Demo tokens must never bootstrap admins');

    // Seed extra audit entries so total > pageSize (10)
    for (let i = 0; i < 14; i++) {
      await db.addAuditLog({
        actorUid: 'demo_sysadmin_1',
        actorName: 'Admin',
        actorRole: 'system_admin',
        action: 'TEST_PAGINATION',
        targetType: 'system',
        targetId: `pg_${i}`,
        details: `Pagination probe ${i}`,
      });
    }

    const page1Res = await fetch(`${devBase}/api/audit-logs?action=TEST_PAGINATION&page=1&pageSize=10`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(page1Res.status, 200);
    const page1 = (await page1Res.json()) as {
      items: unknown[];
      total: number;
      page: number;
      pageSize: number;
      totalPages: number;
    };
    assert.equal(page1.page, 1);
    assert.equal(page1.pageSize, 10);
    assert.equal(page1.total, 14);
    assert.equal(page1.totalPages, 2);
    assert.equal(page1.items.length, 10);

    const page2Res = await fetch(`${devBase}/api/audit-logs?action=TEST_PAGINATION&page=2&pageSize=10`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(page2Res.status, 200);
    const page2 = (await page2Res.json()) as typeof page1;
    assert.equal(page2.items.length, 4);
    console.log('PASS: Paginated /api/audit-logs and /api/admin/bootstrap security checks verified');
  } finally {
    await new Promise<void>((resolve) => devServer.close(() => resolve()));
  }

  // 4. Multi-Instance Redis Pub/Sub + Distributed Lock + Cross-Process WebSocket QR Sync
  const mockRedis = await startMockRedisServer();
  const workerScript = `
    import http from 'node:http';
    import { WebSocketServer } from 'ws';
    import { db } from './src/server/db.ts';
    import { pubsub } from './src/server/pubsub.ts';
    import { qrEngine } from './src/server/qrEngine.ts';

    await db.init();
    await pubsub.init();

    const server = http.createServer((req, res) => {
      if (req.url === '/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(pubsub.getStatus()));
        return;
      }
      if (req.url === '/broadcast' && req.method === 'POST') {
        let raw = '';
        req.on('data', (d) => (raw += d));
        req.on('end', async () => {
          const { sessionId, event } = JSON.parse(raw);
          await qrEngine.broadcast(sessionId, event);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        });
        return;
      }
      if (req.url === '/lock-hold' && req.method === 'POST') {
        let raw = '';
        req.on('data', (d) => (raw += d));
        req.on('end', async () => {
          const { key, holdMs } = JSON.parse(raw);
          const out = await pubsub.acquireDistributedLock(key, 5000, async () => {
            await new Promise((r) => setTimeout(r, holdMs));
            return 'locked-ok';
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(out));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const wss = new WebSocketServer({ server, path: '/ws' });
    wss.on('connection', (ws, req) => {
      const url = new URL(req.url || '/ws', 'http://localhost');
      const sid = url.searchParams.get('sessionId');
      if (sid) qrEngine.subscribe(sid, ws).catch(() => {});
      ws.on('close', () => qrEngine.unsubscribe(ws));
    });

    const port = Number(process.env.WORKER_PORT);
    server.listen(port, '127.0.0.1', () => {
      process.stdout.write('WORKER_READY:' + port + '\\n');
    });
  `;

  const portA = await getFreePort();
  const portB = await getFreePort();
  let workerA: ChildProcess | null = null;
  let workerB: ChildProcess | null = null;

  const spawnWorker = (port: number) =>
    new Promise<ChildProcess>((resolve, reject) => {
      const proc = spawn(process.execPath, ['--input-type=module', '-e', workerScript], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NODE_ENV: 'development',
          REDIS_URL: mockRedis.url,
          FIREBASE_SERVICE_ACCOUNT_JSON: '',
          WORKER_PORT: String(port),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      const timer = setTimeout(() => reject(new Error(`Worker timeout on ${port}: ${err}`)), 10000);
      proc.stdout.on('data', (d) => {
        out += String(d);
        if (out.includes(`WORKER_READY:${port}`)) {
          clearTimeout(timer);
          resolve(proc);
        }
      });
      proc.stderr.on('data', (d) => {
        err += String(d);
      });
    });

  try {
    [workerA, workerB] = await Promise.all([spawnWorker(portA), spawnWorker(portB)]);

    const statusA = (await (await fetch(`http://127.0.0.1:${portA}/status`)).json()) as {
      redisConfigured: boolean;
      redisConnected: boolean;
    };
    const statusB = (await (await fetch(`http://127.0.0.1:${portB}/status`)).json()) as {
      redisConfigured: boolean;
      redisConnected: boolean;
    };
    assert.equal(statusA.redisConfigured, true);
    assert.equal(statusA.redisConnected, true);
    assert.equal(statusB.redisConnected, true);

    // Distributed lock exclusivity test across Worker A & Worker B
    const lockHoldPromise = fetch(`http://127.0.0.1:${portA}/lock-hold`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'qr-rotate:ses_multi_test', holdMs: 300 }),
    }).then((r) => r.json() as Promise<{ acquired: boolean; result?: string }>);

    await new Promise((r) => setTimeout(r, 60));

    const contendedLock = (await (
      await fetch(`http://127.0.0.1:${portB}/lock-hold`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'qr-rotate:ses_multi_test', holdMs: 10 }),
      })
    ).json()) as { acquired: boolean };
    assert.equal(contendedLock.acquired, false, 'Concurrent instance must NOT acquire held QR rotation lock');

    const firstLock = await lockHoldPromise;
    assert.equal(firstLock.acquired, true);
    assert.equal(firstLock.result, 'locked-ok');

    // Lock must now be released and acquirable by Worker B
    const postReleaseLock = (await (
      await fetch(`http://127.0.0.1:${portB}/lock-hold`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'qr-rotate:ses_multi_test', holdMs: 10 }),
      })
    ).json()) as { acquired: boolean };
    assert.equal(postReleaseLock.acquired, true, 'Released distributed lock must be acquirable by Worker B');

    // Cross-instance Pub/Sub -> WebSocket fanout: broadcast on Worker A, receive on WS client attached to Worker B
    const relayedEvent = await new Promise<{ type: string; payload?: { token: string } }>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${portB}/ws?sessionId=ses_demo_live`);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('Timed out waiting for cross-instance WS event'));
      }, 5000);

      ws.on('open', async () => {
        await new Promise((r) => setTimeout(r, 100));
        await fetch(`http://127.0.0.1:${portA}/broadcast`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: 'ses_demo_live',
            event: {
              type: 'qr:rotated',
              payload: { sessionId: 'ses_demo_live', token: 'CROSS_INSTANCE_SYNC_TOKEN' },
            },
          }),
        });
      });

      ws.on('message', (raw) => {
        const parsed = JSON.parse(String(raw)) as { type: string; payload?: { token: string } };
        if (parsed.type === 'qr:rotated' && parsed.payload?.token === 'CROSS_INSTANCE_SYNC_TOKEN') {
          clearTimeout(timer);
          ws.close();
          resolve(parsed);
        }
      });

      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    assert.equal(relayedEvent.payload?.token, 'CROSS_INSTANCE_SYNC_TOKEN');
    console.log(
      'PASS: Two-process ioredis Pub/Sub cross-instance WS QR broadcast + distributed rotation lock verified'
    );
  } finally {
    await Promise.all([stopChild(workerA), stopChild(workerB)]);
    await mockRedis.close();
  }

  console.log('\nALL PRODUCTION-READINESS CHECKS PASSED.');
  process.exit(0);
}

runTests().catch((err) => {
  console.error('PRODUCTION READINESS CHECK FAILED:', err);
  process.exit(1);
});
