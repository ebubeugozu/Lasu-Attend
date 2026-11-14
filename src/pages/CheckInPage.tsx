import React, { useCallback, useEffect, useState } from 'react';
import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  RefreshCw,
  ArrowLeft,
  ShieldCheck,
  Clock,
  KeyRound,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { ThemeSwitcher } from '../context/ThemeContext';
import { ApiError, apiFetch } from '../lib/api';
import type { AttendanceRecord } from '../types/lasu';
import { BrandMark } from '../components/ui/Common';
import { LoginPage } from './LoginPage';
import { ActivationPage } from './ActivationPage';

interface LookupResponse {
  session: {
    id: string;
    courseId: string;
    courseCode: string;
    courseTitle: string;
    lectureTitle?: string;
    venue?: string;
    lecturerName: string;
    sessionDate: string;
    startTime: string;
    status: string;
    checkpointActive: boolean;
  };
  mode: 'checkin' | 'verify';
  tokenValid: boolean;
  tokenError: string | null;
  tokenErrorCode: string | null;
  studentActivated: boolean;
  isEnrolled: boolean;
  existingRecord: {
    status: string;
    checkInTime?: string;
    checkpointStatus: string;
    checkpointTime?: string;
  } | null;
}

export function CheckInPage({ onDone }: { onDone: () => void }) {
  const { ready, authenticated, needsActivation, user } = useAuth();
  const params = new URLSearchParams(window.location.search);
  const urlSessionId = params.get('s') || '';
  const urlToken = params.get('t') || '';
  const urlCode = params.get('code') || '';
  const urlMode = params.get('mode') === 'verify' ? 'verify' : 'checkin';

  const [manualCode, setManualCode] = useState(urlCode);
  const [activeQuery, setActiveQuery] = useState<{ s: string; t: string; code: string; mode: 'checkin' | 'verify' }>(() => ({
    s: urlSessionId,
    t: urlToken,
    code: urlCode,
    mode: urlMode,
  }));

  const [lookup, setLookup] = useState<LookupResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [successRecord, setSuccessRecord] = useState<{
    record: AttendanceRecord;
    courseCode: string;
    courseTitle: string;
    mode: 'checkin' | 'verify';
  } | null>(null);
  const [errorState, setErrorState] = useState<{ message: string; code?: string; retryable?: boolean } | null>(null);

  const performLookup = useCallback(async (q: { s: string; t: string; code: string; mode: 'checkin' | 'verify' }) => {
    if (!q.s && !q.code) return;
    setLoading(true);
    setErrorState(null);
    try {
      const qs = new URLSearchParams();
      if (q.s) qs.set('s', q.s);
      if (q.t) qs.set('t', q.t);
      if (q.code) qs.set('code', q.code);
      qs.set('mode', q.mode);
      const res = await apiFetch<LookupResponse>(`/api/checkin/lookup?${qs.toString()}`);
      setLookup(res);
    } catch (err) {
      if (err instanceof ApiError) {
        setErrorState({ message: err.message, code: err.code, retryable: err.status >= 500 });
      } else {
        setErrorState({ message: 'Network problem while contacting LASU Attend. Please retry.', code: 'NETWORK', retryable: true });
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (ready && authenticated && !needsActivation && (activeQuery.s || activeQuery.code)) {
      performLookup(activeQuery);
    }
  }, [ready, authenticated, needsActivation, activeQuery, performLookup]);

  if (!ready) {
    return (
      <div className="min-h-screen bg-[#F6F8FB] dark:bg-[#09111E] flex items-center justify-center p-6">
        <p className="text-sm text-[#697586] dark:text-slate-400">Checking authentication...</p>
      </div>
    );
  }

  if (!authenticated) {
    return <LoginPage redirectNotice="Sign in to complete your attendance check-in for this lecture." />;
  }

  if (needsActivation) {
    return (
      <div className="min-h-screen bg-[#F6F8FB] dark:bg-[#09111E] p-4 flex items-center justify-center">
        <ActivationPage onActivated={() => performLookup(activeQuery)} />
      </div>
    );
  }

  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualCode.trim()) return;
    setSuccessRecord(null);
    setLookup(null);
    setActiveQuery({ s: '', t: '', code: manualCode.trim().toUpperCase(), mode: 'checkin' });
  };

  const handleCheckIn = async () => {
    if (!lookup) return;
    setSubmitting(true);
    setErrorState(null);
    const endpoint = lookup.mode === 'verify' ? '/api/attendance/verify' : '/api/attendance/checkin';
    try {
      const res = await apiFetch<{
        ok: boolean;
        record: AttendanceRecord;
        courseCode: string;
        courseTitle: string;
      }>(endpoint, {
        method: 'POST',
        body: JSON.stringify({
          sessionId: lookup.session.id,
          token: activeQuery.t || undefined,
          shortCode: activeQuery.code || undefined,
        }),
      });
      setSuccessRecord({
        record: res.record,
        courseCode: res.courseCode,
        courseTitle: res.courseTitle,
        mode: lookup.mode,
      });
    } catch (err) {
      if (err instanceof ApiError) {
        setErrorState({
          message: err.message,
          code: err.code,
          retryable: err.status >= 500,
        });
      } else {
        setErrorState({
          message: 'Network error while submitting check-in. You can safely retry without creating duplicates.',
          code: 'NETWORK',
          retryable: true,
        });
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#F6F8FB] dark:bg-[#09111E] flex flex-col">
      {/* Compact Mobile Header */}
      <header className="sticky top-0 z-20 bg-white dark:bg-[#0F1A2B] border-b border-[#E5EAF0] dark:border-slate-800 px-3 sm:px-4 h-14 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={onDone}
          className="min-h-[40px] px-1.5 sm:px-2 inline-flex items-center gap-1.5 text-xs sm:text-sm font-medium text-[#172337] dark:text-slate-100 shrink-0"
        >
          <ArrowLeft className="w-4 h-4 shrink-0" />
          <span>Dashboard</span>
        </button>
        <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
          <BrandMark size={24} />
          <span className="text-xs sm:text-sm font-bold text-[#14243A] dark:text-white truncate">LASU Attend</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="hidden sm:inline text-xs font-mono-tabular text-[#697586] dark:text-slate-400">
            {user?.matricNumber || ''}
          </span>
          <ThemeSwitcher variant="compact" />
        </div>
      </header>

      <main className="flex-1 flex items-center justify-center p-4 md:p-6">
        <div className="w-full max-w-md space-y-4">
          {/* Manual Code Entry */}
          {!lookup && !loading && !successRecord && (
            <div className="bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-2xl p-6 space-y-5">
              <div>
                <h1 className="text-xl font-bold text-[#172337] dark:text-slate-100">Lecture Check-In</h1>
                <p className="text-sm text-[#697586] dark:text-slate-400 mt-1">
                  Scan the lecture hall QR code with your phone camera, or enter the fallback code shown on the projector.
                </p>
              </div>

              {errorState && (
                <div className="rounded-xl bg-[#D84A4A]/10 border border-[#D84A4A]/25 p-4 flex items-start gap-3">
                  <XCircle className="w-5 h-5 text-[#D84A4A] dark:text-rose-400 shrink-0 mt-0.5" />
                  <div className="text-sm text-[#D84A4A] dark:text-rose-400">
                    <p className="font-medium">{errorState.message}</p>
                    {errorState.retryable && (
                      <button
                        type="button"
                        onClick={() => performLookup(activeQuery)}
                        className="mt-2 inline-flex items-center gap-1.5 text-xs font-semibold underline"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                        Retry lookup
                      </button>
                    )}
                  </div>
                </div>
              )}

              <form onSubmit={handleManualSubmit} className="space-y-4">
                <div>
                  <label htmlFor="fallback-code" className="block text-xs font-medium text-[#172337] dark:text-slate-200 mb-1.5">
                    Fallback Session Code
                  </label>
                  <div className="relative">
                    <KeyRound className="w-4 h-4 text-[#697586] dark:text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                    <input
                      id="fallback-code"
                      type="text"
                      required
                      value={manualCode}
                      onChange={(e) => setManualCode(e.target.value.toUpperCase())}
                      placeholder="e.g. LASU-4K9M2P"
                      className="w-full min-h-[48px] pl-10 pr-4 text-base font-mono-tabular tracking-wider border border-[#E5EAF0] dark:border-slate-700 rounded-xl bg-white dark:bg-[#09111E] text-[#172337] dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-[#4263EB]"
                    />
                  </div>
                </div>
                <button
                  type="submit"
                  className="w-full min-h-[48px] rounded-xl bg-[#4263EB] hover:bg-[#3451C7] text-white text-sm font-semibold transition-colors"
                >
                  Find Lecture Session
                </button>
              </form>
            </div>
          )}

          {loading && (
            <div className="bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-2xl p-8 text-center">
              <p className="text-sm font-medium text-[#172337] dark:text-slate-100">Validating attendance session...</p>
            </div>
          )}

          {/* Success Confirmation */}
          {successRecord && (
            <div className="bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-2xl p-6 md:p-8 text-center space-y-5">
              <div className="w-14 h-14 rounded-full bg-[#16845B]/10 text-[#16845B] dark:text-emerald-400 flex items-center justify-center mx-auto">
                <CheckCircle2 className="w-8 h-8" />
              </div>
              <div>
                <p className="text-xs font-semibold text-[#16845B] dark:text-emerald-400">
                  {successRecord.mode === 'verify' ? 'Second Checkpoint Verified' : 'Check-In Confirmed'}
                </p>
                <h1 className="text-2xl font-bold text-[#172337] dark:text-slate-100 mt-1">
                  {successRecord.courseCode}
                </h1>
                <p className="text-sm text-[#697586] dark:text-slate-400 mt-0.5">{successRecord.courseTitle}</p>
              </div>

              <div className="bg-[#F6F8FB] dark:bg-[#09111E] border border-[#E5EAF0] dark:border-slate-800 rounded-xl p-4 text-left space-y-2.5 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <span className="text-[#697586] dark:text-slate-400">Student</span>
                  <span className="font-medium text-[#172337] dark:text-slate-100 break-words">{successRecord.record.studentName}</span>
                </div>
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <span className="text-[#697586] dark:text-slate-400">Matric Number</span>
                  <span className="font-mono-tabular font-medium text-[#172337] dark:text-slate-100">{successRecord.record.matricNumber}</span>
                </div>
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <span className="text-[#697586] dark:text-slate-400">Status</span>
                  <span
                    className={`font-semibold capitalize ${
                      successRecord.record.status === 'late'
                        ? 'text-[#D99020] dark:text-amber-400'
                        : 'text-[#16845B] dark:text-emerald-400'
                    }`}
                  >
                    {successRecord.record.status}
                  </span>
                </div>
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <span className="text-[#697586] dark:text-slate-400">Recorded Time</span>
                  <span className="font-mono-tabular text-[#172337] dark:text-slate-100">
                    {new Date(
                      (successRecord.mode === 'verify'
                        ? successRecord.record.checkpointTime
                        : successRecord.record.checkInTime) || Date.now()
                    ).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </span>
                </div>
              </div>

              <button
                type="button"
                onClick={onDone}
                className="w-full min-h-[48px] rounded-xl bg-[#14243A] dark:bg-[#4263EB] hover:bg-[#0D1828] dark:hover:bg-[#3451C7] text-white text-sm font-semibold transition-colors"
              >
                View My Attendance
              </button>
            </div>
          )}

          {/* Session Found & Ready */}
          {lookup && !loading && !successRecord && (
            <div className="bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-2xl p-6 space-y-5">
              <div>
                <div className="flex items-center gap-2 text-xs font-medium text-[#4263EB] dark:text-blue-400">
                  <ShieldCheck className="w-4 h-4" />
                  <span>{lookup.mode === 'verify' ? 'Second Verification Checkpoint' : 'Attendance Check-In'}</span>
                </div>
                <h1 className="text-xl font-bold text-[#172337] dark:text-slate-100 mt-1">
                  {lookup.session.courseCode} — {lookup.session.courseTitle}
                </h1>
                <p className="text-sm text-[#697586] dark:text-slate-400 mt-1">
                  {lookup.session.lectureTitle ? `${lookup.session.lectureTitle} · ` : ''}
                  {lookup.session.venue ? `${lookup.session.venue} · ` : ''}
                  {lookup.session.lecturerName}
                </p>
                <p className="text-xs text-[#697586] dark:text-slate-400 mt-1 font-mono-tabular">
                  {lookup.session.sessionDate} · Starts {lookup.session.startTime}
                </p>
              </div>

              {!lookup.studentActivated ? (
                <div className="rounded-xl bg-[#D99020]/10 border border-[#D99020]/30 p-4 text-sm text-[#172337] dark:text-slate-100 space-y-2">
                  <div className="flex items-center gap-2 font-semibold text-[#D99020] dark:text-amber-400">
                    <AlertTriangle className="w-4 h-4" />
                    <span>Student Account Required</span>
                  </div>
                  <p className="text-xs text-[#697586] dark:text-slate-400">
                    You are currently signed in as <span className="font-medium text-[#172337] dark:text-slate-200">{user?.role}</span>. Only enrolled, activated students can check in.
                  </p>
                </div>
              ) : !lookup.isEnrolled ? (
                <div className="rounded-xl bg-[#D84A4A]/10 border border-[#D84A4A]/25 p-4 text-sm text-[#D84A4A] dark:text-rose-400 space-y-1">
                  <p className="font-semibold">Not Enrolled in Course</p>
                  <p className="text-xs">
                    Matric number {user?.matricNumber} is not on the enrolment roster for {lookup.session.courseCode}.
                  </p>
                </div>
              ) : !lookup.tokenValid ? (
                <div className="rounded-xl bg-[#D84A4A]/10 border border-[#D84A4A]/25 p-4 text-sm text-[#D84A4A] dark:text-rose-400 space-y-2">
                  <p className="font-semibold">
                    {lookup.tokenErrorCode === 'SESSION_CLOSED' ? 'Session Closed' : 'Expired or Invalid QR Code'}
                  </p>
                  <p className="text-xs">{lookup.tokenError}</p>
                  <button
                    type="button"
                    onClick={() => {
                      setLookup(null);
                      setActiveQuery({ s: '', t: '', code: '', mode: 'checkin' });
                    }}
                    className="inline-flex items-center gap-1.5 text-xs font-semibold underline"
                  >
                    Enter New Fallback Code
                  </button>
                </div>
              ) : lookup.mode === 'checkin' && lookup.existingRecord ? (
                <div className="rounded-xl bg-[#16845B]/10 border border-[#16845B]/25 p-4 space-y-2">
                  <div className="flex items-center gap-2 text-sm font-semibold text-[#16845B] dark:text-emerald-400">
                    <CheckCircle2 className="w-4 h-4" />
                    <span>Already Checked In</span>
                  </div>
                  <p className="text-xs text-[#172337] dark:text-slate-200">
                    Recorded as <span className="font-semibold capitalize">{lookup.existingRecord.status}</span> at{' '}
                    <span className="font-mono-tabular">
                      {lookup.existingRecord.checkInTime
                        ? new Date(lookup.existingRecord.checkInTime).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                          })
                        : '—'}
                    </span>
                    .
                  </p>
                </div>
              ) : lookup.mode === 'verify' && !lookup.existingRecord ? (
                <div className="rounded-xl bg-[#D99020]/10 border border-[#D99020]/30 p-4 space-y-1">
                  <div className="flex items-center gap-2 text-sm font-semibold text-[#D99020] dark:text-amber-400">
                    <Clock className="w-4 h-4" />
                    <span>Initial Check-In Required First</span>
                  </div>
                  <p className="text-xs text-[#697586] dark:text-slate-400">
                    No initial check-in record was found for this session. Contact your lecturer if you checked in earlier.
                  </p>
                </div>
              ) : lookup.mode === 'verify' && lookup.existingRecord?.checkpointStatus === 'completed' ? (
                <div className="rounded-xl bg-[#0F9D91]/10 border border-[#0F9D91]/25 p-4 space-y-1">
                  <div className="flex items-center gap-2 text-sm font-semibold text-[#0F9D91] dark:text-teal-400">
                    <CheckCircle2 className="w-4 h-4" />
                    <span>Second Checkpoint Already Completed</span>
                  </div>
                  <p className="text-xs text-[#697586] dark:text-slate-400">
                    Your verification scan for this lecture has already been recorded.
                  </p>
                </div>
              ) : (
                <>
                  {errorState && (
                    <div className="rounded-xl bg-[#D84A4A]/10 border border-[#D84A4A]/25 p-4 text-xs text-[#D84A4A] dark:text-rose-400 space-y-2">
                      <p className="font-medium">{errorState.message}</p>
                      {errorState.retryable && (
                        <button
                          type="button"
                          onClick={handleCheckIn}
                          className="inline-flex items-center gap-1.5 font-semibold underline"
                        >
                          <RefreshCw className="w-3.5 h-3.5" />
                          Retry Safely
                        </button>
                      )}
                    </div>
                  )}

                  <button
                    type="button"
                    disabled={submitting}
                    onClick={handleCheckIn}
                    className={`w-full min-h-[52px] rounded-xl text-white text-base font-semibold transition-colors ${
                      lookup.mode === 'verify'
                        ? 'bg-[#0F9D91] hover:bg-[#0B8278]'
                        : 'bg-[#4263EB] hover:bg-[#3451C7]'
                    } disabled:opacity-60`}
                  >
                    {submitting
                      ? 'Submitting...'
                      : lookup.mode === 'verify'
                        ? 'Verify Attendance (2nd Checkpoint)'
                        : 'Check In Now'}
                  </button>
                  <p className="text-xs text-center text-[#697586] dark:text-slate-400">
                    Checking in as <span className="font-medium text-[#172337] dark:text-slate-200">{user?.displayName}</span> ·{' '}
                    <span className="font-mono-tabular">{user?.matricNumber}</span>
                  </p>
                </>
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
