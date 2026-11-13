import 'dotenv/config';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { WebSocketServer } from 'ws';
import { db } from './src/server/db.ts';
import { qrEngine } from './src/server/qrEngine.ts';
import { registerApiRoutes } from './src/server/routes.ts';

async function startServer() {
  await db.init();

  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '5mb' }));

  // Register REST API routes
  registerApiRoutes(app);

  // Create HTTP + WebSocket server for synchronized QR displays & live attendance
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    try {
      const url = new URL(req.url || '/ws', `http://${req.headers.host || 'localhost'}`);
      const sessionId = url.searchParams.get('sessionId');
      if (sessionId) {
        qrEngine.subscribe(sessionId, ws);
      }
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(String(raw)) as { type?: string; sessionId?: string };
          if (msg.type === 'subscribe' && msg.sessionId) {
            qrEngine.subscribe(msg.sessionId, ws);
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

  qrEngine.startTicker();

  const isProd = process.env.NODE_ENV === 'production';
  const distDir = path.resolve(process.cwd(), 'dist');

  if (!isProd) {
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

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`LASU Attend server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start LASU Attend server:', err);
  process.exit(1);
});
