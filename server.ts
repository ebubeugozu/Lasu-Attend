import 'dotenv/config';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import { validateSecurityConfig } from './src/server/auth.ts';
import { db } from './src/server/db.ts';
import { pubsub } from './src/server/pubsub.ts';
import { qrEngine } from './src/server/qrEngine.ts';
import { registerApiRoutes } from './src/server/routes.ts';

let sharedInitPromise: Promise<void> | null = null;

export async function initBackendServices(): Promise<void> {
  if (!sharedInitPromise) {
    sharedInitPromise = (async () => {
      validateSecurityConfig();
      await Promise.all([db.init(), pubsub.init()]);
    })();
  }
  return sharedInitPromise;
}

export async function createApp(options: { attachVite?: boolean } = {}): Promise<Express> {
  const { attachVite = true } = options;
  await initBackendServices();

  const app = express();
  app.use(express.json({ limit: '5mb' }));

  // Register REST API routes
  registerApiRoutes(app);

  // Never let unmatched /api/* fall through to SPA HTML
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'API route not found.', code: 'NOT_FOUND' });
  });

  const isProd = process.env.NODE_ENV === 'production';
  const distDir = path.resolve(process.cwd(), 'dist');

  if (!isProd && attachVite) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else if (fs.existsSync(distDir)) {
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  return app;
}

function resolveListenPort(): number {
  const explicitAppPort = process.env.APP_PORT ? Number(process.env.APP_PORT) : NaN;
  if (Number.isFinite(explicitAppPort) && explicitAppPort > 0) return explicitAppPort;

  const envPort = process.env.PORT ? Number(process.env.PORT) : NaN;
  const nginxPort = process.env.NGINX_PORT ? Number(process.env.NGINX_PORT) : NaN;
  if (Number.isFinite(envPort) && envPort > 0 && envPort !== nginxPort) {
    return envPort;
  }
  return 3000;
}

export async function startServer() {
  const app = await createApp({ attachVite: process.env.NODE_ENV !== 'production' });
  const PORT = resolveListenPort();

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  const aliveClients = new WeakMap<WebSocket, boolean>();

  wss.on('connection', (ws, req) => {
    aliveClients.set(ws, true);
    ws.on('pong', () => {
      aliveClients.set(ws, true);
    });

    try {
      const url = new URL(req.url || '/ws', `http://${req.headers.host || 'localhost'}`);
      const sessionId = url.searchParams.get('sessionId');
      if (sessionId) {
        qrEngine.subscribe(sessionId, ws).catch((err) => {
          console.error('WS subscribe error:', err);
        });
      }
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(String(raw)) as { type?: string; sessionId?: string };
          if (msg.type === 'subscribe' && msg.sessionId) {
            qrEngine.subscribe(msg.sessionId, ws).catch(() => {});
          }
        } catch {
          // ignore malformed messages
        }
      });
      ws.on('close', () => {
        qrEngine.unsubscribe(ws);
      });
    } catch {
      ws.close();
    }
  });

  const heartbeatInterval = setInterval(() => {
    for (const client of wss.clients) {
      if (aliveClients.get(client) === false) {
        qrEngine.unsubscribe(client);
        client.terminate();
        continue;
      }
      aliveClients.set(client, false);
      if (client.readyState === 1) {
        client.ping();
      }
    }
  }, 30_000);

  qrEngine.startTicker();

  const shutdown = async () => {
    clearInterval(heartbeatInterval);
    qrEngine.destroy();
    wss.close();
    await pubsub.close();
    server.close(() => {
      process.exit(0);
    });
  };

  process.once('SIGTERM', () => {
    shutdown().catch(() => process.exit(1));
  });
  process.once('SIGINT', () => {
    shutdown().catch(() => process.exit(1));
  });

  await new Promise<void>((resolve) => {
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`LASU Attend server listening on http://0.0.0.0:${PORT}`);
      resolve();
    });
  });

  return { app, server, wss, port: PORT };
}

const isDirectRun =
  !process.env.VERCEL &&
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  startServer().catch((err) => {
    console.error('Failed to start LASU Attend server:', err);
    process.exit(1);
  });
}
