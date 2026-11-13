# LASU Attend — University Attendance Management SaaS

LASU Attend is a full-stack attendance management platform designed for Lagos State University (Faculty of Engineering pilot, scaling across departments and faculties). Students mark attendance from their seats using their phone browsers and dynamic rotating QR codes—no queuing at the front of the lecture hall and no app store download required.

## Core Features
- **Three Role-Based Experiences**: Dedicated interfaces and backend permissions for **Lecturers**, **Students**, and **Administrators** (System Admin & Department Admin).
- **Dynamic Rotating QR System**: Cryptographically generated QR tokens rotating automatically every **90 seconds** with a **15-second grace period**, synchronized across multiple projector displays via WebSockets (`/ws`), plus manual short fallback codes (`LASU-XXXXXX`) for camera accessibility.
- **Optional Second Checkpoint ("Verify Attendance")**: Generates a separate short-lived verification QR event during a lecture without duplicating initial attendance records.
- **Server-Authoritative Check-Ins**: Atomic per-session locking prevents race conditions or duplicate submissions across 800+ simultaneous check-ins. Students cannot write directly to Firestore attendance records.
- **CSV Official Register Import & Activation**: 8-step validation workflow detecting duplicates and invalid rows without silent drops, issuing one-time activation codes so students cannot hijack another matriculation number.
- **Analytics & Exports**: Trend lines, present/late/absent distribution, session breakdowns, student attendance histograms, course comparisons, configurable risk thresholds, and CSV / Excel (`.xls`) exports.
- **Immutable Audit Logs**: Tracks session lifecycle, accepted/rejected check-ins, manual corrections (with required reason), register imports, and role changes.

## Setup & Deployment (Beginner-Friendly Guide)

1. **Install Dependencies**
   ```bash
   npm install
   ```

2. **Environment Variables**
   Copy `.env.example` to `.env` if running outside AI Studio:
   - `ENABLE_DEMO_MODE="true"` (set to `"false"` in strict production deployments).
   - `SESSION_SECRET`: Random string (at least 16 chars) for server session signing.
   - `FIREBASE_SERVICE_ACCOUNT_JSON` *(optional for production)*: Paste your Firebase Service Account JSON to enable direct `firebase-admin` Firestore writes from the Node.js server.

3. **Run in Development or Production**
   - Development: `npm run dev` (starts Express + WebSockets + Vite on port `3000`)
   - Production Build: `npm run build` followed by `npm start` (`node server.ts` on port `3000`)

4. **Deploy Firestore Security Rules**
   `firestore.rules` is included and validated against `@firebase/eslint-plugin-security-rules` (`npx eslint firestore.rules`). Deploy updates via Firebase CLI (`firebase deploy --only firestore:rules`) or AI Studio's rule deployment.

## Development & Demo Testing Process
When `ENABLE_DEMO_MODE="true"`, the login screen displays a clearly labelled **Development Demo Mode** panel containing synthetic sample data (800 synthetic 200-level Engineering students, 4 courses, and 7 historical sessions).
- **Sample Lecturer**: `Dr. Adeyemi Ogunleye`
- **Sample System Admin**: `Prof. Folashade Balogun`
- **Sample Department Admin (ECE)**: `Dr. Chukwuma Okafor`
- **Sample Student**: `Toluwani A. Adebayo` (`230591001`)
- **Sample Student Activation Test**: Sign in with Google and activate matriculation number `230591999` with activation code `LASU-2026-ACT`.

*Note: Demo accounts and sample records are strictly marked (`isDemo: true`) and are not real LASU student records.*
