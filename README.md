# LASU Attend — University Attendance Management SaaS

LASU Attend is a full-stack attendance management platform designed for Lagos State University (starting with 800 second-year Engineering students and built to scale across departments, faculties, and institutions). Students mark attendance from their seats using their phone browsers and dynamic rotating QR codes—no queuing at the front of the lecture hall and no app store download required.

## Core Features
- **Three Role-Based Experiences**: Dedicated interfaces and backend permissions for **Lecturers**, **Students**, and **Administrators** (System Admin & Department Admin).
- **Dynamic Rotating QR System**: Cryptographically generated QR tokens rotating automatically every **90 seconds** with a **15-second grace period**, backed by Cloud Firestore (`qrTokenSecrets`) and optional Redis Pub/Sub + distributed locks across multiple server instances, plus manual fallback short codes (`LASU-XXXXXX`).
- **Optional Second Checkpoint ("Verify Attendance")**: Generates a separate short-lived verification QR event during a lecture without duplicating initial attendance records.
- **Server-Authoritative Cloud Firestore Operations**: Atomic Firestore `runTransaction` controls prevent duplicate check-ins, lost updates across concurrent students, or race conditions. Students cannot write directly to Firestore attendance records.
- **CSV Official Register Import & Activation**: Multi-step validation workflow detecting duplicates and invalid rows without silent drops, issuing one-time activation codes so students cannot hijack another matriculation number.
- **Analytics & Branded Exports**: Trend lines, present/late/absent distribution, session breakdowns, student attendance histograms, course comparisons, configurable risk thresholds, and PDF / CSV / Excel (`.xls`) exports.
- **Immutable Audit Logs**: Paginated audit trail tracking session lifecycle, accepted/rejected check-ins, manual corrections (with required reason), register imports, and role changes.

## Production Setup & Deployment Guide

### 1. Environment Variables
Copy `.env.example` to `.env` for local runs, or configure these in your hosting dashboard:
- `FIREBASE_SERVICE_ACCOUNT_JSON` **(required in production)**: Paste the JSON contents of your Firebase Service Account key (`Firebase Console -> Project Settings -> Service Accounts -> Generate new private key`). Never expose this in frontend code.
- `SESSION_SECRET` **(required in production, >= 32 characters)**: Random secret string used for server token signing. Production startup fails cleanly if missing or shorter than 32 characters.
- `ENABLE_DEMO_MODE`: Must be `"false"` (default) in production. Set to `"true"` only in local development if you want synthetic test accounts.
- `INITIAL_ADMIN_EMAIL` *(optional)*: Comma-separated verified email address(es) allowed to auto-provision the very first `system_admin` account when zero active `system_admin` accounts exist in Firestore.
- `ADMIN_BOOTSTRAP_TOKEN` *(optional, >= 16 characters)*: Secret token accepted by `POST /api/admin/bootstrap` to promote the first verified user to `system_admin` when zero active `system_admin` accounts exist.
- `REDIS_URL` *(recommended for multi-instance Node deployments)*: Redis connection string (e.g. `rediss://...`) for shared Pub/Sub WebSocket event fan-out and distributed QR rotation locks across server instances.
- `VITE_WS_URL` *(optional)*: Dedicated WebSocket server URL (e.g. `wss://ws.yourdomain.com`) if hosting the static frontend and REST API on Vercel Serverless while hosting persistent WebSockets separately.

### 2. Deploying on Vercel (and Real-Time WebSockets Architecture)
`vercel.json` and `api/index.ts` are configured for Vercel deployment:
- **Frontend & REST API (`/api/*`)**: `npm run build` compiles the Vite React app into `dist/`, and `/api/*` requests run through `api/index.ts` as Vercel Serverless Functions.
- **Important Note on Persistent WebSockets (`/ws`)**: Vercel Serverless Functions are short-lived HTTP invocations and cannot hold persistent WebSocket connections open.
  - **Single-platform Node hosting (Recommended for built-in `/ws`)**: Run `npm run build` and `npm start` (`node server.ts`) on a persistent Node.js host (Railway, Render, Fly.io, Cloud Run with WebSockets enabled) with `REDIS_URL` for multi-instance scaling.
  - **Hybrid Vercel + Node WebSocket setup**: Deploy the frontend and `/api/*` to Vercel, deploy `node server.ts` on a persistent Node host with the same `FIREBASE_SERVICE_ACCOUNT_JSON` and `REDIS_URL`, and set `VITE_WS_URL="wss://your-ws-host"` in Vercel build env vars. If no WebSocket server is reachable, the presentation view automatically resyncs via `/api/sessions/:id/qr` with exponential backoff.

### 3. Deploy Firestore Security Rules
`firestore.rules` is validated with `@firebase/eslint-plugin-security-rules`:
```bash
npx eslint firestore.rules
```
Deploy via Firebase CLI (`firebase deploy --only firestore:rules`) or AI Studio's rule deployment tool.

### 4. Local Development & Verification
```bash
npm install
ENABLE_DEMO_MODE="true" npm run dev
```
- Run `npm run lint` (`tsc --noEmit`) and `npm run build` before deployment.
- Verification scripts (run in dev mode with `ENABLE_DEMO_MODE="true"`):
  - `npx tsx scripts/qa-verify.ts`
  - `npx tsx scripts/verify-enhancements.ts`
  - `npx tsx scripts/burst-800-test.ts`
  - `npx tsx scripts/verify-production-readiness.ts`
