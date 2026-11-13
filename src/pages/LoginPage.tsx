import React, { useState } from 'react';
import { ShieldCheck, KeyRound, Mail, ArrowRight, AlertCircle, CheckCircle2, QrCode } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { ThemeSwitcher } from '../context/ThemeContext';
import { BrandMark } from '../components/ui/Common';

export function LoginPage({ redirectNotice }: { redirectNotice?: string }) {
  const { loginWithGoogle, loginWithEmail, sendPasswordReset, loginDemo, demoAccounts } = useAuth();
  const [mode, setMode] = useState<'sso' | 'email' | 'reset'>('sso');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetSent, setResetSent] = useState(false);

  const handleGoogle = async () => {
    setError(null);
    setLoading(true);
    try {
      await loginWithGoogle();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Google sign-in failed.';
      setError(msg.includes('popup-closed') ? 'Sign-in window was closed before completion.' : msg);
    } finally {
      setLoading(false);
    }
  };

  const handleEmailLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await loginWithEmail(email.trim(), password);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Sign-in failed.';
      if (msg.includes('operation-not-allowed')) {
        setError('Email/password login is not enabled on this Firebase project yet. Use Google Sign-In above, or enable Email/Password in Firebase Console.');
      } else {
        setError('Invalid email or password, or account not found.');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await sendPasswordReset(email.trim());
      setResetSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send password reset email.');
    } finally {
      setLoading(false);
    }
  };

  const handleDemo = async (uid: string) => {
    setError(null);
    setLoading(true);
    try {
      await loginDemo(uid);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start demo session.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#F6F8FB] dark:bg-[#09111E] flex flex-col lg:flex-row">
      {/* Left Institutional Brand Column */}
      <aside className="lg:w-[44%] bg-[#0D1828] text-white p-8 md:p-12 lg:p-16 flex flex-col justify-between">
        <div>
          <div className="flex items-center gap-3">
            <BrandMark size={36} light />
            <span className="text-xl font-bold tracking-tight text-white">LASU Attend</span>
          </div>

          <div className="mt-12 max-w-md space-y-4">
            <p className="text-xs font-medium tracking-wide text-[#0F9D91]">
              Lagos State University · Attendance Infrastructure
            </p>
            <h1 className="text-3xl md:text-4xl font-bold leading-tight text-white">
              Reliable lecture hall attendance without the queue.
            </h1>
            <p className="text-sm md:text-base text-[#B8C4D4] leading-relaxed">
              Built for large engineering lecture theatres. Students check in from their seats using dynamic, rotating QR codes while lecturers monitor attendance and analytics in real time.
            </p>
          </div>

          <div className="mt-10 grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-md">
            <div className="bg-[#14243A] border border-white/10 rounded-xl p-4">
              <QrCode className="w-5 h-5 text-[#4263EB] mb-2" />
              <p className="text-sm font-semibold text-white">Dynamic 90s QR</p>
              <p className="text-xs text-[#9FB0C7] mt-1">Synchronized across hall displays with 15s scan grace window.</p>
            </div>
            <div className="bg-[#14243A] border border-white/10 rounded-xl p-4">
              <ShieldCheck className="w-5 h-5 text-[#0F9D91] mb-2" />
              <p className="text-sm font-semibold text-white">Server-Verified</p>
              <p className="text-xs text-[#9FB0C7] mt-1">Register-backed activation and atomic duplicate prevention.</p>
            </div>
          </div>
        </div>

        <p className="mt-10 text-xs text-[#9FB0C7]">
          Lagos State University · Faculty of Engineering Pilot
        </p>
      </aside>

      {/* Right Sign-In Column */}
      <main className="flex-1 flex flex-col items-center justify-center p-6 md:p-12 relative">
        <div className="w-full max-w-md flex justify-end mb-4">
          <ThemeSwitcher variant="compact" />
        </div>

        <div className="w-full max-w-md space-y-6">
          {redirectNotice && (
            <div className="bg-[#4263EB]/10 border border-[#4263EB]/30 rounded-xl px-4 py-3 text-sm text-[#14243A] dark:text-blue-200">
              {redirectNotice}
            </div>
          )}

          <div className="bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl p-6 md:p-8 shadow-xs">
            <h2 className="text-2xl font-bold text-[#172337] dark:text-slate-100">Sign in to LASU Attend</h2>
            <p className="text-sm text-[#697586] dark:text-slate-400 mt-1">
              Use your verified Google account for institutional access or student activation.
            </p>

            {/* Segmented Mode Tabs */}
            <div className="mt-5 grid grid-cols-2 gap-1 p-1 bg-[#F6F8FB] dark:bg-[#09111E] border border-[#E5EAF0] dark:border-slate-800 rounded-lg">
              <button
                type="button"
                onClick={() => {
                  setMode('sso');
                  setError(null);
                }}
                className={`py-2 px-3 text-xs font-medium rounded-md transition-colors ${
                  mode === 'sso'
                    ? 'bg-white dark:bg-[#14243A] text-[#172337] dark:text-white shadow-xs'
                    : 'text-[#697586] dark:text-slate-400 hover:text-[#172337] dark:hover:text-slate-200'
                }`}
              >
                Google Sign-In
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode('email');
                  setError(null);
                  setResetSent(false);
                }}
                className={`py-2 px-3 text-xs font-medium rounded-md transition-colors ${
                  mode !== 'sso'
                    ? 'bg-white dark:bg-[#14243A] text-[#172337] dark:text-white shadow-xs'
                    : 'text-[#697586] dark:text-slate-400 hover:text-[#172337] dark:hover:text-slate-200'
                }`}
              >
                Email & Password
              </button>
            </div>

            {error && (
              <div className="mt-4 flex items-start gap-2.5 rounded-lg bg-[#D84A4A]/10 border border-[#D84A4A]/25 px-3.5 py-2.5 text-xs text-[#D84A4A] dark:text-rose-400">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            {mode === 'sso' && (
              <div className="mt-6 space-y-4">
                <button
                  type="button"
                  disabled={loading}
                  onClick={handleGoogle}
                  className="w-full min-h-[46px] px-4 py-2.5 rounded-lg bg-[#4263EB] hover:bg-[#3451C7] disabled:opacity-60 text-white text-sm font-medium inline-flex items-center justify-center gap-2.5 transition-colors"
                >
                  <span>{loading ? 'Signing in...' : 'Continue with Google'}</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
                <p className="text-xs text-[#697586] dark:text-slate-400 leading-relaxed">
                  Students without an institutional email can sign in with their personal Google account and activate using their matriculation number and department activation code.
                </p>
              </div>
            )}

            {mode === 'email' && (
              <form onSubmit={handleEmailLogin} className="mt-5 space-y-4">
                <div>
                  <label className="block text-xs font-medium text-[#172337] dark:text-slate-200 mb-1.5" htmlFor="login-email">
                    Email address
                  </label>
                  <div className="relative">
                    <Mail className="w-4 h-4 text-[#697586] dark:text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      id="login-email"
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="name@lasu.edu.ng"
                      className="w-full min-h-[42px] pl-9 pr-3 py-2 text-sm border border-[#E5EAF0] dark:border-slate-700 rounded-lg bg-white dark:bg-[#09111E] text-[#172337] dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-[#4263EB]"
                    />
                  </div>
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="block text-xs font-medium text-[#172337] dark:text-slate-200" htmlFor="login-password">
                      Password
                    </label>
                    <button
                      type="button"
                      onClick={() => {
                        setMode('reset');
                        setError(null);
                      }}
                      className="text-xs text-[#4263EB] dark:text-blue-400 hover:underline"
                    >
                      Forgot password?
                    </button>
                  </div>
                  <div className="relative">
                    <KeyRound className="w-4 h-4 text-[#697586] dark:text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      id="login-password"
                      type="password"
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Enter your password"
                      className="w-full min-h-[42px] pl-9 pr-3 py-2 text-sm border border-[#E5EAF0] dark:border-slate-700 rounded-lg bg-white dark:bg-[#09111E] text-[#172337] dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-[#4263EB]"
                    />
                  </div>
                </div>
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full min-h-[44px] px-4 py-2.5 rounded-lg bg-[#14243A] dark:bg-[#4263EB] hover:bg-[#0D1828] dark:hover:bg-[#3451C7] disabled:opacity-60 text-white text-sm font-medium transition-colors"
                >
                  {loading ? 'Verifying...' : 'Sign In'}
                </button>
              </form>
            )}

            {mode === 'reset' && (
              <form onSubmit={handleReset} className="mt-5 space-y-4">
                {resetSent ? (
                  <div className="flex items-start gap-2.5 rounded-lg bg-[#16845B]/10 border border-[#16845B]/25 px-3.5 py-3 text-xs text-[#16845B] dark:text-emerald-400">
                    <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>Password reset instructions have been sent if an account exists for {email}.</span>
                  </div>
                ) : (
                  <>
                    <div>
                      <label className="block text-xs font-medium text-[#172337] dark:text-slate-200 mb-1.5" htmlFor="reset-email">
                        Account email
                      </label>
                      <input
                        id="reset-email"
                        type="email"
                        required
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="name@lasu.edu.ng"
                        className="w-full min-h-[42px] px-3 py-2 text-sm border border-[#E5EAF0] dark:border-slate-700 rounded-lg bg-white dark:bg-[#09111E] text-[#172337] dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-[#4263EB]"
                      />
                    </div>
                    <button
                      type="submit"
                      disabled={loading}
                      className="w-full min-h-[44px] px-4 py-2.5 rounded-lg bg-[#4263EB] hover:bg-[#3451C7] text-white text-sm font-medium transition-colors"
                    >
                      Send Reset Link
                    </button>
                  </>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setMode('email');
                    setResetSent(false);
                  }}
                  className="text-xs text-[#697586] dark:text-slate-400 hover:text-[#172337] dark:hover:text-slate-200"
                >
                  Back to sign in
                </button>
              </form>
            )}
          </div>

          {/* Development / Demo Accounts Panel */}
          {demoAccounts.length > 0 && (
            <div className="bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl p-5">
              <div className="flex items-center justify-between gap-2 mb-3">
                <div>
                  <h3 className="text-sm font-semibold text-[#172337] dark:text-slate-100">Development Demo Mode</h3>
                  <p className="text-xs text-[#697586] dark:text-slate-400">
                    Sample data only · Not official LASU records
                  </p>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {demoAccounts
                  .filter((a) => a.uid !== 'demo_lecturer_2')
                  .map((acc) => {
                    const roleLabel =
                      acc.role === 'system_admin'
                        ? 'System Admin'
                        : acc.role === 'department_admin'
                          ? 'Dept Admin (ECE)'
                          : acc.role === 'lecturer'
                            ? 'Lecturer'
                            : 'Student (200L)';
                    return (
                      <button
                        key={acc.uid}
                        type="button"
                        disabled={loading}
                        onClick={() => handleDemo(acc.uid)}
                        className="text-left px-3 py-2.5 rounded-lg border border-[#E5EAF0] dark:border-slate-800 hover:border-[#4263EB] hover:bg-[#F6F8FB] dark:hover:bg-[#14243A] transition-colors"
                      >
                        <p className="text-xs font-semibold text-[#172337] dark:text-slate-100 truncate">{roleLabel}</p>
                        <p className="text-xs text-[#697586] dark:text-slate-400 truncate mt-0.5">{acc.displayName}</p>
                      </button>
                    );
                  })}
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
