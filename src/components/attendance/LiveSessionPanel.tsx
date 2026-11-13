import React, { useCallback, useEffect, useState } from 'react';
import {
  Maximize2,
  ShieldCheck,
  StopCircle,
  Search,
  Download,
  Edit3,
  AlertTriangle,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
} from 'lucide-react';
import type { AttendanceSession, AttendanceStatus, FailedAttempt } from '../../types/lasu';
import { apiFetch, downloadReport } from '../../lib/api';
import { useLiveQR } from '../../hooks/useLiveQR';
import { InfoTooltip, Modal, SkeletonRows, StatusLabel } from '../ui/Common';

interface RosterRow {
  studentId: string;
  matricNumber: string;
  studentName: string;
  departmentName: string;
  status: 'present' | 'late' | 'absent' | 'excused' | 'not_checked_in';
  checkInTime: string | null;
  checkpointStatus: 'none' | 'completed' | 'missed';
  checkpointTime: string | null;
  correctionReason: string | null;
}

export function LiveSessionPanel({
  session: initialSession,
  onOpenPresentation,
  onSessionUpdated,
}: {
  session: AttendanceSession;
  onOpenPresentation: (sessionId: string) => void;
  onSessionUpdated: (session: AttendanceSession) => void;
}) {
  const [session, setSession] = useState<AttendanceSession>(initialSession);
  const isLive = session.status === 'live';
  const { payload, qrDataUrl, secondsRemaining, wsConnected } = useLiveQR(session.id, isLive);

  const [rows, setRows] = useState<RosterRow[]>([]);
  const [failedAttempts, setFailedAttempts] = useState<FailedAttempt[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [checkpointFilter, setCheckpointFilter] = useState('');
  const [sortBy, setSortBy] = useState('matricNumber');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [loading, setLoading] = useState(true);
  const [actionBusy, setActionBusy] = useState(false);

  // Manual Correction Modal State
  const [correctingRow, setCorrectingRow] = useState<RosterRow | null>(null);
  const [newStatus, setNewStatus] = useState<AttendanceStatus>('present');
  const [correctionReason, setCorrectionReason] = useState('');
  const [correctionError, setCorrectionError] = useState<string | null>(null);

  useEffect(() => {
    setSession(initialSession);
  }, [initialSession]);

  const fetchRoster = useCallback(async () => {
    try {
      const q = new URLSearchParams({
        page: String(page),
        pageSize: '25',
        sortBy,
        sortDir,
      });
      if (search.trim()) q.set('search', search.trim());
      if (statusFilter) q.set('status', statusFilter);
      if (checkpointFilter) q.set('checkpoint', checkpointFilter);

      const res = await apiFetch<{
        session: AttendanceSession;
        items: RosterRow[];
        total: number;
        totalPages: number;
        failedAttempts: FailedAttempt[];
      }>(`/api/sessions/${session.id}/roster?${q.toString()}`);

      setSession(res.session);
      setRows(res.items);
      setTotal(res.total);
      setTotalPages(res.totalPages);
      setFailedAttempts(res.failedAttempts);
    } finally {
      setLoading(false);
    }
  }, [session.id, page, sortBy, sortDir, search, statusFilter, checkpointFilter]);

  useEffect(() => {
    fetchRoster();
  }, [fetchRoster]);

  // Refresh roster cleanly when live QR payload counts change via WebSocket
  useEffect(() => {
    if (!isLive || !payload) return;
    const t = setTimeout(() => {
      fetchRoster();
    }, 350);
    return () => clearTimeout(t);
  }, [isLive, payload?.checkedInCount, payload?.verifiedCount, fetchRoster]);

  const handleStartSession = async () => {
    setActionBusy(true);
    try {
      const res = await apiFetch<{ session: AttendanceSession }>(`/api/sessions/${session.id}/start`, { method: 'POST' });
      setSession(res.session);
      onSessionUpdated(res.session);
      fetchRoster();
    } finally {
      setActionBusy(false);
    }
  };

  const handleToggleCheckpoint = async () => {
    setActionBusy(true);
    try {
      const endpoint = session.checkpointActive
        ? `/api/sessions/${session.id}/checkpoint/stop`
        : `/api/sessions/${session.id}/checkpoint`;
      const res = await apiFetch<{ session: AttendanceSession }>(endpoint, { method: 'POST' });
      setSession(res.session);
      onSessionUpdated(res.session);
    } finally {
      setActionBusy(false);
    }
  };

  const handleCloseSession = async () => {
    setActionBusy(true);
    try {
      const res = await apiFetch<{ session: AttendanceSession }>(`/api/sessions/${session.id}/close`, {
        method: 'POST',
      });
      setSession(res.session);
      onSessionUpdated(res.session);
      fetchRoster();
    } finally {
      setActionBusy(false);
    }
  };

  const submitCorrection = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!correctingRow) return;
    setCorrectionError(null);
    setActionBusy(true);
    try {
      const res = await apiFetch<{ session: AttendanceSession }>('/api/attendance/correct', {
        method: 'POST',
        body: JSON.stringify({
          sessionId: session.id,
          studentId: correctingRow.studentId,
          newStatus,
          reason: correctionReason,
        }),
      });
      setSession(res.session);
      onSessionUpdated(res.session);
      setCorrectingRow(null);
      setCorrectionReason('');
      fetchRoster();
    } catch (err) {
      setCorrectionError(err instanceof Error ? err.message : 'Failed to save correction.');
    } finally {
      setActionBusy(false);
    }
  };

  const toggleSort = (field: string) => {
    if (sortBy === field) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortBy(field);
      setSortDir('asc');
    }
    setPage(1);
  };

  const checkedInCount = payload && isLive ? payload.checkedInCount : session.presentCount + session.lateCount;
  const verifiedCount = payload && isLive ? payload.verifiedCount : session.verifiedCount;
  const remainingCount = Math.max(0, session.totalEnrolled - checkedInCount);
  const progressPct = session.totalEnrolled > 0 ? Math.min(100, Math.round((checkedInCount / session.totalEnrolled) * 100)) : 0;

  return (
    <div className="space-y-6">
      {/* Session Header + Action Controls */}
      <div className="bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl p-5 md:p-6 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2.5 text-xs text-[#697586] dark:text-slate-400">
            <StatusLabel status={session.status} />
            <span aria-hidden="true">·</span>
            <span className="font-mono-tabular">{session.sessionDate}</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono-tabular">{session.startTime}</span>
            {session.venue && (
              <>
                <span aria-hidden="true">·</span>
                <span>{session.venue}</span>
              </>
            )}
            {isLive && (
              <>
                <span aria-hidden="true">·</span>
                <span className="text-[#4263EB] dark:text-blue-400 font-medium">
                  {wsConnected ? 'Live sync active' : 'Syncing'}
                </span>
              </>
            )}
          </div>
          <h2 className="text-xl font-bold text-[#172337] dark:text-slate-100 mt-1">
            {session.courseCode} — {session.courseTitle}
          </h2>
          {session.lectureTitle && <p className="text-sm text-[#697586] dark:text-slate-400 mt-0.5">{session.lectureTitle}</p>}
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {session.status === 'scheduled' && (
            <button
              type="button"
              disabled={actionBusy}
              onClick={handleStartSession}
              className="min-h-[40px] px-4 py-2 rounded-lg bg-[#4263EB] hover:bg-[#3451C7] text-white text-sm font-medium transition-colors"
            >
              Start Live QR
            </button>
          )}

          {isLive && (
            <>
              <button
                type="button"
                onClick={() => onOpenPresentation(session.id)}
                className="min-h-[40px] px-3.5 py-2 rounded-lg bg-[#14243A] hover:bg-[#0D1828] dark:bg-[#4263EB] dark:hover:bg-[#3451C7] text-white text-sm font-medium inline-flex items-center gap-2 transition-colors whitespace-nowrap"
              >
                <Maximize2 className="w-4 h-4" />
                <span>Full-Screen Display</span>
              </button>

              <button
                type="button"
                disabled={actionBusy}
                onClick={handleToggleCheckpoint}
                className={`min-h-[40px] px-3.5 py-2 rounded-lg text-sm font-medium inline-flex items-center gap-2 border transition-colors whitespace-nowrap ${
                  session.checkpointActive
                    ? 'bg-[#0F9D91] text-white border-[#0F9D91]'
                    : 'bg-white dark:bg-[#14243A] text-[#172337] dark:text-slate-100 border-[#E5EAF0] dark:border-slate-700 hover:bg-[#F6F8FB] dark:hover:bg-slate-800'
                }`}
              >
                <ShieldCheck className="w-4 h-4" />
                <span>{session.checkpointActive ? 'Stop 2nd Checkpoint' : 'Verify Attendance (2nd Checkpoint)'}</span>
              </button>

              <button
                type="button"
                disabled={actionBusy}
                onClick={handleCloseSession}
                className="min-h-[40px] px-3.5 py-2 rounded-lg bg-[#D84A4A] hover:bg-[#BE3B3B] text-white text-sm font-medium inline-flex items-center gap-2 transition-colors whitespace-nowrap"
              >
                <StopCircle className="w-4 h-4" />
                <span>End Session</span>
              </button>
            </>
          )}

          {session.status === 'completed' && (
            <>
              <button
                type="button"
                onClick={() => downloadReport({ sessionId: session.id, format: 'pdf' })}
                className="min-h-[40px] px-3.5 py-2 rounded-lg bg-[#14243A] dark:bg-[#4263EB] hover:bg-[#0D1828] dark:hover:bg-[#3451C7] text-sm font-medium text-white inline-flex items-center gap-2"
              >
                <Download className="w-4 h-4" />
                <span>Export PDF</span>
              </button>
              <button
                type="button"
                onClick={() => downloadReport({ sessionId: session.id, format: 'csv' })}
                className="min-h-[40px] px-3.5 py-2 rounded-lg border border-[#E5EAF0] dark:border-slate-700 bg-white dark:bg-[#14243A] hover:bg-[#F6F8FB] dark:hover:bg-slate-800 text-sm font-medium text-[#172337] dark:text-slate-200 inline-flex items-center gap-2"
              >
                <Download className="w-4 h-4" />
                <span>Export CSV</span>
              </button>
              <button
                type="button"
                onClick={() => downloadReport({ sessionId: session.id, format: 'xls' })}
                className="min-h-[40px] px-3.5 py-2 rounded-lg border border-[#E5EAF0] dark:border-slate-700 bg-white dark:bg-[#14243A] hover:bg-[#F6F8FB] dark:hover:bg-slate-800 text-sm font-medium text-[#172337] dark:text-slate-200 inline-flex items-center gap-2"
              >
                <Download className="w-4 h-4" />
                <span>Export Excel</span>
              </button>
            </>
          )}
        </div>
      </div>

      {/* Live Metrics + QR Preview Row */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Metrics & Progress */}
        <div className={`${isLive ? 'xl:col-span-2' : 'xl:col-span-3'} bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl p-5 md:p-6 space-y-5`}>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-4">
            <div>
              <p className="text-xs text-[#697586] dark:text-slate-400">Enrolled</p>
              <p className="text-2xl font-bold font-mono-tabular text-[#172337] dark:text-slate-100 mt-1">{session.totalEnrolled}</p>
            </div>
            <div>
              <p className="text-xs text-[#16845B] dark:text-emerald-400">Checked In</p>
              <p className="text-2xl font-bold font-mono-tabular text-[#16845B] dark:text-emerald-400 mt-1">{checkedInCount}</p>
            </div>
            <div>
              <p className="text-xs text-[#697586] dark:text-slate-400">{isLive ? 'Not Yet Checked In' : 'Final Absent'}</p>
              <p className={`text-2xl font-bold font-mono-tabular mt-1 ${isLive ? 'text-[#172337] dark:text-slate-100' : 'text-[#D84A4A] dark:text-rose-400'}`}>
                {isLive ? remainingCount : session.absentCount}
              </p>
            </div>
            <div>
              <p className="text-xs text-[#D99020] dark:text-amber-400">Late Arrivals</p>
              <p className="text-2xl font-bold font-mono-tabular text-[#D99020] dark:text-amber-400 mt-1">{session.lateCount}</p>
            </div>
            <div>
              <p className="text-xs text-[#0F9D91] dark:text-teal-400">
                2nd Checkpoint
                <InfoTooltip text="Optional second verification scan triggered mid-lecture. Confirms a second scan event without claiming continuous physical presence." />
              </p>
              <p className="text-2xl font-bold font-mono-tabular text-[#0F9D91] dark:text-teal-400 mt-1">{verifiedCount}</p>
            </div>
            <div>
              <p className="text-xs text-[#D84A4A] dark:text-rose-400">Failed Attempts</p>
              <p className="text-2xl font-bold font-mono-tabular text-[#D84A4A] dark:text-rose-400 mt-1">{session.failedAttemptCount || 0}</p>
            </div>
          </div>

          <div className="pt-2 border-t border-[#E5EAF0] dark:border-slate-800">
            <div className="flex items-center justify-between text-xs text-[#697586] dark:text-slate-400 mb-1.5">
              <span>Session check-in progress</span>
              <span className="font-mono-tabular font-semibold text-[#172337] dark:text-slate-100">{progressPct}%</span>
            </div>
            <div className="w-full h-2.5 bg-[#F6F8FB] dark:bg-[#09111E] border border-[#E5EAF0] dark:border-slate-800 rounded-full overflow-hidden">
              <div className="h-full bg-[#16845B] transition-all duration-300" style={{ width: `${progressPct}%` }} />
            </div>
          </div>
        </div>

        {/* Live QR Card */}
        {isLive && payload && (
          <div className="bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl p-5 flex items-center gap-5">
            <div className="shrink-0 bg-white border border-[#E5EAF0] rounded-lg p-2">
              {qrDataUrl ? (
                <img src={qrDataUrl} alt="Live attendance QR" className="w-28 h-28 object-contain" />
              ) : (
                <div className="w-28 h-28 bg-[#F6F8FB] animate-pulse rounded" />
              )}
            </div>
            <div className="min-w-0 flex-1 space-y-2">
              <div>
                <p className="text-xs font-medium text-[#4263EB] dark:text-blue-400">
                  {payload.mode === 'verify' ? '2nd Checkpoint Active' : 'Active QR Token'}
                </p>
                <p className="text-lg font-bold font-mono-tabular text-[#172337] dark:text-slate-100 tracking-wider">
                  {payload.shortCode}
                </p>
                <p className="text-xs text-[#697586] dark:text-slate-400 font-mono-tabular">
                  Rotates in {secondsRemaining}s · {payload.graceSeconds}s grace
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <a
                  href={`/present/${session.id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs font-medium text-[#4263EB] dark:text-blue-400 hover:underline inline-flex items-center gap-1"
                >
                  <span>Open screen tab</span>
                  <ExternalLink className="w-3 h-3" />
                </a>
                <a
                  href={`/checkin?s=${encodeURIComponent(session.id)}&t=${encodeURIComponent(payload.token)}&mode=${payload.mode}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs font-medium text-[#0F9D91] dark:text-teal-400 hover:underline inline-flex items-center gap-1"
                >
                  <span>Test check-in URL</span>
                  <ExternalLink className="w-3 h-3" />
                </a>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Student Roster Table */}
      <div className="bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="p-4 md:p-5 border-b border-[#E5EAF0] dark:border-slate-800 flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-[#172337] dark:text-slate-100">Student Attendance Roster</h3>
            <p className="text-xs text-[#697586] dark:text-slate-400 tabular-nums">{total} matching students</p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <div className="relative">
              <Search className="w-4 h-4 text-[#697586] dark:text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="search"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
                placeholder="Search name or matric..."
                className="min-h-[38px] pl-9 pr-3 py-1.5 text-sm border border-[#E5EAF0] dark:border-slate-700 rounded-lg bg-white dark:bg-[#09111E] text-[#172337] dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-[#4263EB] w-56"
              />
            </div>

            <select
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value);
                setPage(1);
              }}
              aria-label="Filter by status"
              className="min-h-[38px] px-3 py-1.5 text-sm border border-[#E5EAF0] dark:border-slate-700 rounded-lg bg-white dark:bg-[#09111E] text-[#172337] dark:text-slate-100"
            >
              <option value="">All statuses</option>
              <option value="present">Present</option>
              <option value="late">Late</option>
              {isLive ? (
                <option value="not_checked_in">Not yet checked in</option>
              ) : (
                <option value="absent">Absent</option>
              )}
              <option value="excused">Excused</option>
            </select>

            <select
              value={checkpointFilter}
              onChange={(e) => {
                setCheckpointFilter(e.target.value);
                setPage(1);
              }}
              aria-label="Filter by second checkpoint"
              className="min-h-[38px] px-3 py-1.5 text-sm border border-[#E5EAF0] dark:border-slate-700 rounded-lg bg-white dark:bg-[#09111E] text-[#172337] dark:text-slate-100"
            >
              <option value="">All checkpoints</option>
              <option value="completed">2nd Check Verified</option>
              <option value="missed">2nd Check Missed</option>
              <option value="none">No checkpoint</option>
            </select>
          </div>
        </div>

        {loading ? (
          <SkeletonRows rows={6} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-[#F6F8FB] dark:bg-[#09111E] border-b border-[#E5EAF0] dark:border-slate-800 text-xs text-[#697586] dark:text-slate-400">
                <tr>
                  <th className="px-4 py-3 font-medium">
                    <button type="button" onClick={() => toggleSort('matricNumber')} className="inline-flex items-center gap-1 hover:text-[#172337] dark:hover:text-slate-200">
                      <span>Matric No.</span>
                      <ArrowUpDown className="w-3.5 h-3.5" />
                    </button>
                  </th>
                  <th className="px-4 py-3 font-medium">
                    <button type="button" onClick={() => toggleSort('studentName')} className="inline-flex items-center gap-1 hover:text-[#172337] dark:hover:text-slate-200">
                      <span>Student Name</span>
                      <ArrowUpDown className="w-3.5 h-3.5" />
                    </button>
                  </th>
                  <th className="px-4 py-3 font-medium">
                    <button type="button" onClick={() => toggleSort('checkInTime')} className="inline-flex items-center gap-1 hover:text-[#172337] dark:hover:text-slate-200">
                      <span>Check-in Time</span>
                      <ArrowUpDown className="w-3.5 h-3.5" />
                    </button>
                  </th>
                  <th className="px-4 py-3 font-medium">
                    <button type="button" onClick={() => toggleSort('status')} className="inline-flex items-center gap-1 hover:text-[#172337] dark:hover:text-slate-200">
                      <span>Status</span>
                      <ArrowUpDown className="w-3.5 h-3.5" />
                    </button>
                  </th>
                  <th className="px-4 py-3 font-medium">2nd Checkpoint</th>
                  <th className="px-4 py-3 font-medium text-right">Correction</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E5EAF0] dark:divide-slate-800">
                {rows.map((r) => (
                  <tr key={r.studentId} className="hover:bg-[#F6F8FB]/70 dark:hover:bg-slate-800/50 transition-colors">
                    <td className="px-4 py-3 font-mono-tabular font-medium text-[#172337] dark:text-slate-100 whitespace-nowrap">
                      {r.matricNumber}
                    </td>
                    <td className="px-4 py-3 text-[#172337] dark:text-slate-200">
                      <div>{r.studentName}</div>
                      {r.correctionReason && (
                        <div className="text-xs text-[#697586] dark:text-slate-400 mt-0.5">Note: {r.correctionReason}</div>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono-tabular text-xs text-[#697586] dark:text-slate-400 whitespace-nowrap">
                      {r.checkInTime
                        ? new Date(r.checkInTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
                        : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <StatusLabel status={r.status} />
                    </td>
                    <td className="px-4 py-3">
                      {r.checkpointStatus === 'completed' ? (
                        <StatusLabel status="completed_checkpoint" />
                      ) : r.checkpointStatus === 'missed' ? (
                        <StatusLabel status="missed_checkpoint" />
                      ) : (
                        <StatusLabel status="none" />
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => {
                          setCorrectingRow(r);
                          setNewStatus(r.status === 'not_checked_in' ? 'present' : r.status);
                          setCorrectionReason(r.correctionReason || '');
                          setCorrectionError(null);
                        }}
                        className="inline-flex items-center gap-1 text-xs font-medium text-[#4263EB] dark:text-blue-400 hover:underline"
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                        <span>Adjust</span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        <div className="px-4 py-3 border-t border-[#E5EAF0] dark:border-slate-800 flex items-center justify-between text-xs text-[#697586] dark:text-slate-400">
          <span className="tabular-nums">
            Page {page} of {totalPages}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="min-h-[34px] px-3 rounded-lg border border-[#E5EAF0] dark:border-slate-700 bg-white dark:bg-[#09111E] text-[#172337] dark:text-slate-200 disabled:opacity-40 inline-flex items-center gap-1"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
              <span>Previous</span>
            </button>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              className="min-h-[34px] px-3 rounded-lg border border-[#E5EAF0] dark:border-slate-700 bg-white dark:bg-[#09111E] text-[#172337] dark:text-slate-200 disabled:opacity-40 inline-flex items-center gap-1"
            >
              <span>Next</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Failed Check-In Attempts requiring attention */}
      {failedAttempts.length > 0 && (
        <div className="bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl p-5">
          <div className="flex items-center gap-2 text-sm font-semibold text-[#172337] dark:text-slate-100 mb-3">
            <AlertTriangle className="w-4 h-4 text-[#D99020] dark:text-amber-400" />
            <span>Recent Rejected Check-In Attempts ({failedAttempts.length})</span>
          </div>
          <div className="divide-y divide-[#E5EAF0] dark:divide-slate-800 text-xs">
            {failedAttempts.slice(0, 8).map((f) => (
              <div key={f.id} className="py-2.5 flex flex-wrap items-center justify-between gap-2">
                <span className="text-[#172337] dark:text-slate-200">{f.reason}</span>
                <span className="font-mono-tabular text-[#697586] dark:text-slate-400">
                  {f.code} · {new Date(f.attemptedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Manual Correction Modal */}
      <Modal
        open={Boolean(correctingRow)}
        onClose={() => setCorrectingRow(null)}
        title="Manual Attendance Correction"
        subtitle={correctingRow ? `${correctingRow.studentName} (${correctingRow.matricNumber})` : undefined}
      >
        <form onSubmit={submitCorrection} className="space-y-4">
          {correctionError && (
            <div className="rounded-lg bg-[#D84A4A]/10 border border-[#D84A4A]/25 px-3.5 py-2.5 text-xs text-[#D84A4A] dark:text-rose-400">
              {correctionError}
            </div>
          )}

          <div>
            <label htmlFor="corr-status" className="block text-xs font-medium text-[#172337] dark:text-slate-200 mb-1.5">
              Corrected Attendance Status
            </label>
            <select
              id="corr-status"
              value={newStatus}
              onChange={(e) => setNewStatus(e.target.value as AttendanceStatus)}
              className="w-full min-h-[42px] px-3 py-2 text-sm border border-[#E5EAF0] dark:border-slate-700 rounded-lg bg-white dark:bg-[#09111E] text-[#172337] dark:text-slate-100"
            >
              <option value="present">Present</option>
              <option value="late">Late</option>
              <option value="excused">Excused</option>
              <option value="absent">Absent</option>
            </select>
          </div>

          <div>
            <label htmlFor="corr-reason" className="block text-xs font-medium text-[#172337] dark:text-slate-200 mb-1.5">
              Mandatory Reason (Logged to Audit Trail)
            </label>
            <textarea
              id="corr-reason"
              required
              minLength={4}
              rows={3}
              value={correctionReason}
              onChange={(e) => setCorrectionReason(e.target.value)}
              placeholder="e.g. Student phone battery failed during scan; verified seat attendance manually."
              className="w-full px-3 py-2 text-sm border border-[#E5EAF0] dark:border-slate-700 rounded-lg bg-white dark:bg-[#09111E] text-[#172337] dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-[#4263EB]"
            />
          </div>

          <div className="flex justify-end gap-3 pt-2 border-t border-[#E5EAF0] dark:border-slate-800">
            <button
              type="button"
              onClick={() => setCorrectingRow(null)}
              className="px-4 py-2 text-sm font-medium text-[#697586] dark:text-slate-300 border border-[#E5EAF0] dark:border-slate-700 rounded-lg"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={actionBusy}
              className="px-5 py-2 text-sm font-medium text-white bg-[#4263EB] hover:bg-[#3451C7] rounded-lg disabled:opacity-60"
            >
              Save & Log Audit Entry
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
