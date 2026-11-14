import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Express } from 'express';
import { createApp } from '../server.ts';

let cachedAppPromise: Promise<Express> | null = null;

async function getApp(): Promise<Express> {
  if (!cachedAppPromise) {
    cachedAppPromise = createApp({ attachVite: false });
  }
  return cachedAppPromise;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const app = await getApp();
  app(req, res);
}
