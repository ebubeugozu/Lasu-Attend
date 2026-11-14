import React, { useState } from 'react';
import { ShieldAlert, CheckCircle2, LogOut, KeyRound } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { ThemeSwitcher } from '../context/ThemeContext';
import { BrandMark } from '../components/ui/Common';

export function ActivationPage({ compact = false, onActivated }: { compact?: boolean; onActivated?: () => void }) {
  const { email, displayName, user, activateStudent, logout } = useAuth();
  const [matricNumber, setMatricNumber] = useState('');
  const [activationCode, setActivationCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await activateStudent(matricNumber.trim(), activationCode.trim());
      if (onActivated) onActivated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Activation failed.');
    } finally {
      setLoading(false);
    }
  };

  if (user && user.status === 'suspended') {
    return (
      <div className="min-h-screen bg-[#F6F8FB] dark:bg-[#09111E] flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl p-8 text-center">
          <ShieldAlert className="w-10 h-10 text-[#D84A4A] dark:text-rose-400 mx-auto mb-3" />
          <h1 className="text-xl font-bold text-[#172337] dark:text-slate-100">Account Suspended</h1>
          <p className="text-sm text-[#697586] dark:text-slate-400 mt-2">
            Your LASU Attend access has been suspended. Please contact your department administrator for review.
          </p>
          <button
            type="button"
            onClick={logout}
            className="mt-6 px-4 py-2.5 text-sm font-medium text-[#172337] dark:text-slate-100 border border-[#E5EAF0] dark:border-slate-700 rounded-lg hover:bg-[#F6F8FB] dark:hover:bg-slate-800"
          >
            Sign Out
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={compact ? '' : 'min-h-screen bg-[#F6F8FB] dark:bg-[#09111E] flex items-center justify-center p-4 sm:p-6'}>
      <div className="max-w-lg w-full bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl p-5 sm:p-6 md:p-8">
        {!compact && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#E5EAF0] dark:border-slate-800 pb-4 mb-6">
            <div className="flex items-center gap-2.5">
              <BrandMark size={28} />
              <span className="font-semibold text-[#172337] dark:text-slate-100">LASU Attend</span>
            </div>
            <div className="flex items-center gap-2">
              <ThemeSwitcher variant="compact" />
              <button
                type="button"
                onClick={logout}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-[#697586] dark:text-slate-400 hover:text-[#172337] dark:hover:text-slate-100"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span>Sign Out</span>
              </button>
            </div>
          </div>
        )}

        <h1 className="text-xl font-bold text-[#172337] dark:text-slate-100">Activate Student Account</h1>
        <p className="text-sm text-[#697586] dark:text-slate-400 mt-1">
          Signed in as <span className="font-medium text-[#172337] dark:text-slate-100">{displayName || email}</span> ({email}).
        </p>

        <div className="mt-4 bg-[#F6F8FB] dark:bg-[#09111E] border border-[#E5EAF0] dark:border-slate-800 rounded-lg p-3.5 text-xs text-[#697586] dark:text-slate-400 leading-relaxed">
          To protect student records, entering a matriculation number alone is not sufficient. Enter the one-time activation code issued by your department on the official student register.
        </div>

        <form onSubmit={handleSubmit} className="mt-5 space-y-4">
          {error && (
            <div className="rounded-lg bg-[#D84A4A]/10 border border-[#D84A4A]/25 px-3.5 py-2.5 text-xs text-[#D84A4A] dark:text-rose-400">
              {error}
            </div>
          )}

          <div>
            <label htmlFor="act-matric" className="block text-xs font-medium text-[#172337] dark:text-slate-200 mb-1.5">
              Matriculation Number
            </label>
            <input
              id="act-matric"
              type="text"
              required
              value={matricNumber}
              onChange={(e) => setMatricNumber(e.target.value)}
              placeholder="e.g. 230591999"
              className="w-full min-h-[44px] px-3 py-2 text-sm font-mono-tabular border border-[#E5EAF0] dark:border-slate-700 rounded-lg bg-white dark:bg-[#09111E] text-[#172337] dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-[#4263EB]"
            />
          </div>

          <div>
            <label htmlFor="act-code" className="block text-xs font-medium text-[#172337] dark:text-slate-200 mb-1.5">
              Department Activation Code
            </label>
            <div className="relative">
              <KeyRound className="w-4 h-4 text-[#697586] dark:text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                id="act-code"
                type="text"
                required
                value={activationCode}
                onChange={(e) => setActivationCode(e.target.value)}
                placeholder="e.g. LASU-2026-ACT"
                className="w-full min-h-[44px] pl-9 pr-3 py-2 text-sm font-mono-tabular border border-[#E5EAF0] dark:border-slate-700 rounded-lg bg-white dark:bg-[#09111E] text-[#172337] dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-[#4263EB]"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full min-h-[46px] px-4 py-2.5 rounded-lg bg-[#4263EB] hover:bg-[#3451C7] disabled:opacity-60 text-white text-sm font-medium inline-flex items-center justify-center gap-2 transition-colors"
          >
            <CheckCircle2 className="w-4 h-4" />
            <span>{loading ? 'Verifying Register...' : 'Verify & Activate Account'}</span>
          </button>
        </form>

        <p className="mt-5 text-xs text-[#697586] dark:text-slate-400">
          Are you a lecturer or department administrator? Ask your System Administrator to approve your email (<span className="font-medium text-[#172337] dark:text-slate-200">{email}</span>) under Lecturers & Staff Management.
        </p>
      </div>
    </div>
  );
}
