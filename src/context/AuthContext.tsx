import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import type { PlatformUser, StudentRecord } from '../types/lasu';
import { apiFetch, getStoredDemoToken, setStoredDemoToken } from '../lib/api';
import {
  auth,
  requestPasswordReset,
  signInWithEmailPassword,
  signInWithGooglePopup,
  signOutFirebase,
  testFirestoreConnection,
} from '../lib/firebase';

export interface DemoAccountSummary {
  uid: string;
  displayName: string;
  email: string;
  role: PlatformUser['role'];
  departmentName?: string;
  matricNumber?: string;
}

export interface SystemStatus {
  demoModeEnabled: boolean;
  firebaseProjectId: string;
  firestoreDatabaseId: string;
  firebaseAdminConnected: boolean;
  hasServiceAccount?: boolean;
  storageMode?: 'firestore_admin' | 'dev_sandbox_memory' | 'unconfigured_error';
  firestoreError?: string | null;
}

interface AuthContextValue {
  ready: boolean;
  authenticated: boolean;
  needsActivation: boolean;
  isDemoSession: boolean;
  email: string | null;
  displayName: string | null;
  user: PlatformUser | null;
  studentProfile: StudentRecord | null;
  demoAccounts: DemoAccountSummary[];
  systemStatus: SystemStatus | null;
  firestoreReachable: boolean;
  loginWithGoogle: () => Promise<void>;
  loginWithEmail: (email: string, password: string) => Promise<void>;
  sendPasswordReset: (email: string) => Promise<void>;
  loginDemo: (uid: string) => Promise<void>;
  activateStudent: (matricNumber: string, activationCode: string) => Promise<void>;
  refreshSession: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [needsActivation, setNeedsActivation] = useState(false);
  const [isDemoSession, setIsDemoSession] = useState(false);
  const [email, setEmail] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [user, setUser] = useState<PlatformUser | null>(null);
  const [studentProfile, setStudentProfile] = useState<StudentRecord | null>(null);
  const [demoAccounts, setDemoAccounts] = useState<DemoAccountSummary[]>([]);
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [firestoreReachable, setFirestoreReachable] = useState(true);

  const resolveServerSession = useCallback(async () => {
    try {
      const data = await apiFetch<{
        authenticated: boolean;
        uid: string;
        email: string;
        displayName: string;
        isDemoToken: boolean;
        user: PlatformUser | null;
        studentProfile: StudentRecord | null;
        needsActivation: boolean;
      }>('/api/auth/session', { method: 'POST' });

      setAuthenticated(true);
      setEmail(data.email);
      setDisplayName(data.displayName);
      setIsDemoSession(data.isDemoToken);
      setUser(data.user);
      setStudentProfile(data.studentProfile);
      setNeedsActivation(data.needsActivation);
    } catch {
      setAuthenticated(false);
      setUser(null);
      setStudentProfile(null);
      setNeedsActivation(false);
      setIsDemoSession(false);
    }
  }, []);

  useEffect(() => {
    // Boot check: Firestore connectivity + system status + demo accounts
    testFirestoreConnection().then((res) => setFirestoreReachable(res.reachable));
    apiFetch<SystemStatus>('/api/system/status')
      .then((s) => setSystemStatus(s))
      .catch(() => {});
    apiFetch<{ enabled: boolean; accounts: DemoAccountSummary[] }>('/api/auth/demo-accounts')
      .then((res) => {
        if (res.enabled) setDemoAccounts(res.accounts);
      })
      .catch(() => {});

    const unsub = onAuthStateChanged(auth, async (fbUser) => {
      const demoToken = getStoredDemoToken();
      if (demoToken || fbUser) {
        await resolveServerSession();
      } else {
        setAuthenticated(false);
        setUser(null);
        setStudentProfile(null);
        setNeedsActivation(false);
        setIsDemoSession(false);
      }
      setReady(true);
    });

    return () => unsub();
  }, [resolveServerSession]);

  const loginWithGoogle = useCallback(async () => {
    setStoredDemoToken(null);
    await signInWithGooglePopup();
    await resolveServerSession();
  }, [resolveServerSession]);

  const loginWithEmail = useCallback(
    async (emailVal: string, password: string) => {
      setStoredDemoToken(null);
      await signInWithEmailPassword(emailVal, password);
      await resolveServerSession();
    },
    [resolveServerSession]
  );

  const sendPasswordReset = useCallback(async (emailVal: string) => {
    await requestPasswordReset(emailVal);
  }, []);

  const loginDemo = useCallback(
    async (uid: string) => {
      if (auth.currentUser) {
        await signOutFirebase();
      }
      const res = await apiFetch<{ token: string; user: PlatformUser; studentProfile: StudentRecord | null }>(
        '/api/auth/demo-login',
        {
          method: 'POST',
          body: JSON.stringify({ uid }),
        }
      );
      setStoredDemoToken(res.token);
      setAuthenticated(true);
      setIsDemoSession(true);
      setEmail(res.user.email);
      setDisplayName(res.user.displayName);
      setUser(res.user);
      setStudentProfile(res.studentProfile);
      setNeedsActivation(false);
    },
    []
  );

  const activateStudent = useCallback(
    async (matricNumber: string, activationCode: string) => {
      const res = await apiFetch<{ user: PlatformUser; studentProfile: StudentRecord }>('/api/auth/activate-student', {
        method: 'POST',
        body: JSON.stringify({ matricNumber, activationCode }),
      });
      setUser(res.user);
      setStudentProfile(res.studentProfile);
      setNeedsActivation(false);
    },
    []
  );

  const logout = useCallback(async () => {
    setStoredDemoToken(null);
    if (auth.currentUser) {
      await signOutFirebase();
    }
    setAuthenticated(false);
    setUser(null);
    setStudentProfile(null);
    setNeedsActivation(false);
    setIsDemoSession(false);
  }, []);

  return (
    <AuthContext.Provider
      value={{
        ready,
        authenticated,
        needsActivation,
        isDemoSession,
        email,
        displayName,
        user,
        studentProfile,
        demoAccounts,
        systemStatus,
        firestoreReachable,
        loginWithGoogle,
        loginWithEmail,
        sendPasswordReset,
        loginDemo,
        activateStudent,
        refreshSession: resolveServerSession,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
