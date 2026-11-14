import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { Redis } from 'ioredis';

const QR_CHANNEL = 'lasu-attend:qr-events';

interface PubSubEnvelope {
  originId: string;
  sessionId: string;
  event: unknown;
}

class PubSubManager {
  private instanceId = crypto.randomBytes(6).toString('hex');
  private emitter = new EventEmitter();
  private pubClient: Redis | null = null;
  private subClient: Redis | null = null;
  private redisConfigured = false;
  private redisConnected = false;
  private lastError: string | null = null;
  private initPromise: Promise<void> | null = null;
  private localLocks = new Map<string, Promise<void>>();

  public async init(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.connectRedis();
    return this.initPromise;
  }

  private async connectRedis(): Promise<void> {
    const redisUrl = (process.env.REDIS_URL || '').trim();
    if (!redisUrl) {
      this.redisConfigured = false;
      this.redisConnected = false;
      return;
    }

    this.redisConfigured = true;
    try {
      const commonOptions = {
        lazyConnect: true,
        maxRetriesPerRequest: 2,
        enableReadyCheck: true,
        retryStrategy: (times: number) => Math.min(times * 500, 5000),
      };

      const pub = new Redis(redisUrl, commonOptions);
      const sub = new Redis(redisUrl, commonOptions);

      pub.on('error', (err) => {
        this.lastError = err instanceof Error ? err.message : String(err);
        this.redisConnected = false;
      });
      sub.on('error', (err) => {
        this.lastError = err instanceof Error ? err.message : String(err);
        this.redisConnected = false;
      });

      pub.on('ready', () => {
        this.redisConnected = true;
        this.lastError = null;
      });

      await Promise.all([pub.connect(), sub.connect()]);

      sub.on('message', (channel, message) => {
        if (channel !== QR_CHANNEL) return;
        try {
          const parsed = JSON.parse(message) as PubSubEnvelope;
          // Ignore events published by this same server instance (already delivered locally)
          if (parsed.originId === this.instanceId) return;
          this.emitter.emit('session_event', parsed.sessionId, parsed.event);
        } catch {
          // ignore malformed pubsub messages
        }
      });

      await sub.subscribe(QR_CHANNEL);

      this.pubClient = pub;
      this.subClient = sub;
      this.redisConnected = true;
      this.lastError = null;
      console.log('[LASU Attend] Redis Pub/Sub connected for multi-instance QR synchronization.');
    } catch (err) {
      this.redisConnected = false;
      this.lastError = err instanceof Error ? err.message : String(err);
      console.warn(
        `[LASU Attend] Redis Pub/Sub connection failed (${this.lastError}); falling back to local in-process event bus.`
      );
    }
  }

  public getStatus(): { redisConfigured: boolean; redisConnected: boolean; lastError: string | null } {
    return {
      redisConfigured: this.redisConfigured,
      redisConnected: this.redisConnected && this.pubClient?.status === 'ready',
      lastError: this.lastError,
    };
  }

  public onSessionEvent(handler: (sessionId: string, event: unknown) => void): () => void {
    this.emitter.on('session_event', handler);
    return () => {
      this.emitter.off('session_event', handler);
    };
  }

  public async publishSessionEvent(sessionId: string, event: unknown): Promise<void> {
    // Deliver immediately to local WebSocket subscribers
    this.emitter.emit('session_event', sessionId, event);

    // Replicate to other server instances if Redis is active
    if (this.pubClient && this.pubClient.status === 'ready') {
      const envelope: PubSubEnvelope = {
        originId: this.instanceId,
        sessionId,
        event,
      };
      try {
        await this.pubClient.publish(QR_CHANNEL, JSON.stringify(envelope));
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
      }
    }
  }

  public async acquireDistributedLock<T>(
    key: string,
    ttlMs: number,
    fn: () => Promise<T>
  ): Promise<{ acquired: boolean; result?: T }> {
    if (this.pubClient && this.pubClient.status === 'ready') {
      const lockKey = `lasu-attend:lock:${key}`;
      const token = `${this.instanceId}:${crypto.randomBytes(6).toString('hex')}`;
      try {
        const res = await this.pubClient.set(lockKey, token, 'PX', ttlMs, 'NX');
        if (res !== 'OK') {
          return { acquired: false };
        }
        try {
          const result = await fn();
          return { acquired: true, result };
        } finally {
          const releaseScript = `
            if redis.call("get", KEYS[1]) == ARGV[1] then
              return redis.call("del", KEYS[1])
            else
              return 0
            end
          `;
          await this.pubClient.eval(releaseScript, 1, lockKey, token).catch(() => {});
        }
      } catch {
        // Fallback to local lock + Firestore transaction guard below
      }
    }

    // Local per-process serialization lock
    const prev = this.localLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.localLocks.set(key, prev.then(() => current));
    await prev;
    try {
      const result = await fn();
      return { acquired: true, result };
    } finally {
      release();
      if (this.localLocks.get(key) === current) {
        this.localLocks.delete(key);
      }
    }
  }

  public async getCache<T>(key: string): Promise<T | null> {
    if (!this.pubClient || this.pubClient.status !== 'ready') return null;
    try {
      const raw = await this.pubClient.get(`lasu-attend:cache:${key}`);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  }

  public async setCache(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    if (!this.pubClient || this.pubClient.status !== 'ready') return;
    try {
      await this.pubClient.set(`lasu-attend:cache:${key}`, JSON.stringify(value), 'EX', ttlSeconds);
    } catch {
      // ignore cache errors
    }
  }

  public async delCache(key: string): Promise<void> {
    if (!this.pubClient || this.pubClient.status !== 'ready') return;
    try {
      await this.pubClient.del(`lasu-attend:cache:${key}`);
    } catch {
      // ignore cache errors
    }
  }

  public async close(): Promise<void> {
    const ops: Array<Promise<unknown>> = [];
    if (this.subClient) {
      ops.push(this.subClient.quit().catch(() => this.subClient?.disconnect()));
    }
    if (this.pubClient) {
      ops.push(this.pubClient.quit().catch(() => this.pubClient?.disconnect()));
    }
    await Promise.all(ops);
    this.subClient = null;
    this.pubClient = null;
    this.redisConnected = false;
    this.initPromise = null;
  }
}

export const pubsub = new PubSubManager();
