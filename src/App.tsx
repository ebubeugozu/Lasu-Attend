import React, { useEffect, useState } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ThemeProvider, useTheme } from './context/ThemeContext';
import { LoginPage } from './pages/LoginPage';
import { ActivationPage } from './pages/ActivationPage';
import { CheckInPage } from './pages/CheckInPage';
import { QRPresentationView } from './components/qr/QRPresentationView';
import { LecturerExperience } from './experiences/LecturerExperience';
import { StudentExperience } from './experiences/StudentExperience';
import { AdminExperience } from './experiences/AdminExperience';

function AppRouter() {
  const { ready, authenticated, needsActivation, user } = useAuth();
  const { setActiveUserScope } = useTheme();
  const [pathname, setPathname] = useState(() => window.location.pathname);

  useEffect(() => {
    setActiveUserScope(user?.uid ?? null);
  }, [user?.uid, setActiveUserScope]);

  useEffect(() => {
    const onPop = () => setPathname(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = (path: string) => {
    window.history.pushState({}, '', path);
    setPathname(path.split('?')[0]);
  };

  // Dedicated Check-In Route (/checkin?s=...&t=...&mode=...)
  if (pathname === '/checkin') {
    return <CheckInPage onDone={() => navigate('/')} />;
  }

  // Dedicated Full-Screen QR Presentation Mode (/present/:sessionId)
  if (pathname.startsWith('/present/')) {
    const sessionId = pathname.slice('/present/'.length).trim();
    if (!ready) {
      return (
        <div className="min-h-screen bg-[#0D1828] text-white flex items-center justify-center">
          <p className="text-sm text-[#9FB0C7]">Loading presentation display...</p>
        </div>
      );
    }
    if (!authenticated) {
      return <LoginPage redirectNotice="Sign in as the course lecturer or administrator to open the lecture hall QR display." />;
    }
    return <QRPresentationView sessionId={sessionId} onExit={() => navigate('/')} />;
  }

  if (!ready) {
    return (
      <div className="min-h-screen bg-[#F6F8FB] dark:bg-[#09111E] flex items-center justify-center">
        <p className="text-sm font-medium text-[#697586] dark:text-slate-400">Loading LASU Attend...</p>
      </div>
    );
  }

  if (!authenticated) {
    return <LoginPage />;
  }

  if (needsActivation || !user || user.status !== 'active') {
    return <ActivationPage />;
  }

  if (user.role === 'student') {
    return (
      <StudentExperience
        onOpenCheckIn={(code) => {
          navigate(code ? `/checkin?code=${encodeURIComponent(code)}` : '/checkin');
        }}
      />
    );
  }

  if (user.role === 'lecturer') {
    return <LecturerExperience onOpenPresentation={(sid) => navigate(`/present/${sid}`)} />;
  }

  // system_admin or department_admin
  return <AdminExperience onOpenPresentation={(sid) => navigate(`/present/${sid}`)} />;
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <AppRouter />
      </AuthProvider>
    </ThemeProvider>
  );
}
