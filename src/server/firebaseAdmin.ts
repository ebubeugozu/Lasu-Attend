import fs from 'node:fs';
import path from 'node:path';
import { cert, getApps, initializeApp, type App, type ServiceAccount } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';

const firebaseConfigPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
const firebaseConfig = fs.existsSync(firebaseConfigPath)
  ? (JSON.parse(fs.readFileSync(firebaseConfigPath, 'utf8')) as {
      projectId: string;
      firestoreDatabaseId?: string;
    })
  : { projectId: 'athletic-serenity-gkx2q', firestoreDatabaseId: 'ai-studio-e11bb378-4219-4cff-a61e-dd8da4971690' };

let adminApp: App;
let hasServiceAccount = false;
let credentialInitError: string | null = null;

const existingApps = getApps();
if (existingApps.length === 0) {
  const saJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (saJson && saJson.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(saJson) as ServiceAccount;
      adminApp = initializeApp({
        credential: cert(parsed),
        projectId: firebaseConfig.projectId,
      });
      hasServiceAccount = true;
    } catch (err) {
      credentialInitError = err instanceof Error ? err.message : 'Invalid FIREBASE_SERVICE_ACCOUNT_JSON';
      console.warn('Invalid FIREBASE_SERVICE_ACCOUNT_JSON; initializing Firebase Admin without cert:', credentialInitError);
      adminApp = initializeApp({ projectId: firebaseConfig.projectId });
    }
  } else {
    adminApp = initializeApp({ projectId: firebaseConfig.projectId });
  }
} else {
  adminApp = existingApps[0];
}

export const adminAuth = getAuth(adminApp);
export const firestoreDb: Firestore =
  firebaseConfig.firestoreDatabaseId && firebaseConfig.firestoreDatabaseId !== '(default)'
    ? getFirestore(adminApp, firebaseConfig.firestoreDatabaseId)
    : getFirestore(adminApp);

try {
  firestoreDb.settings({ ignoreUndefinedProperties: true });
} catch {
  // settings() may only be called once before first operation
}

export type StorageMode = 'firestore_admin' | 'dev_sandbox_memory' | 'unconfigured_error';

export const firebaseAdminStatus: {
  projectId: string;
  firestoreDatabaseId: string;
  hasServiceAccount: boolean;
  firestoreAdminConnected: boolean;
  storageMode: StorageMode;
  lastError: string | null;
} = {
  projectId: firebaseConfig.projectId,
  firestoreDatabaseId: firebaseConfig.firestoreDatabaseId || '(default)',
  hasServiceAccount,
  firestoreAdminConnected: false,
  storageMode: 'unconfigured_error',
  lastError: credentialInitError,
};

export async function probeFirestoreAdmin(): Promise<boolean> {
  try {
    // Attempt an actual Admin SDK read/write probe against Firestore
    const ref = firestoreDb.collection('institutionSettings').doc('_health_probe');
    await ref.get();
    await ref.set({ probedAt: new Date().toISOString() });
    await ref.delete();
    firebaseAdminStatus.firestoreAdminConnected = true;
    firebaseAdminStatus.storageMode = 'firestore_admin';
    firebaseAdminStatus.lastError = null;
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    firebaseAdminStatus.firestoreAdminConnected = false;
    firebaseAdminStatus.lastError = message;
    return false;
  }
}
