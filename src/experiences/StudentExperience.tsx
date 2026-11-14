import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Home,
  BookOpen,
  QrCode,
  History,
  Bell,
  User,
  ArrowRight,
  AlertTriangle,
  CheckCheck,
  Clock,
  Calendar,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { ThemeSwitcher } from '../context/ThemeContext';
import { apiFetch } from '../lib/api';
import type {
  AppNotification,
  AttendanceRecord,
  AttendanceSession,
  CourseTimetableSlot,
  LateCountPolicy,
  StudentRecord,
} from '../types/lasu';
import { AppShell, type NavItem } from '../components/layout/AppShell';
import { EmptyState, SkeletonRows, StatusLabel } from '../components/ui/Common';

interface StudentCourseSummary {
  courseId: string;
  courseCode: string;
  courseTitle: string;
  lecturerName: string;
  semester: string;
  timetableSlots: CourseTimetableSlot[];
  attendedCount: number;
  presentCount: number;
  lateCount: number;
  missedCount: number;
  excusedCount: number;
  totalEligible: number;
  totalSessions: number;
  percentage: number | null;
  belowThreshold: boolean;
}

interface StudentDashboardData {
  student: StudentRecord;
  lateCountPolicy: LateCountPolicy;
  latePolicyDescription: string;
  attendanceThreshold: number;
  overallPercentage: number | null;
  attendedTotal: number;
  presentTotal: number;
  lateTotal: number;
  totalCompletedSessions: number;
  missedCount: number;
  courses: StudentCourseSummary[];
  recentRecords: Array<
    AttendanceRecord & {
      courseCode: string;
      courseTitle: string;
      lectureTitle: string;
      venue?: string;
      sessionDate: string;
      startTime: string;
    }
  >;
  allRecords: Array<
    AttendanceRecord & {
      courseCode: string;
      courseTitle: string;
      lectureTitle: string;
      venue?: string;
      sessionDate: string;
      startTime: string;
    }
  >;
  missedSessions: Array<
    AttendanceRecord & {
      courseCode: string;
      courseTitle: string;
      lectureTitle: string;
      venue?: string;
      sessionDate: string;
      startTime: string;
    }
  >;
  liveSessions: AttendanceSession[];
}

const MOBILE_TABS: NavItem[] = [
  { id: 'home', label: 'Home', icon: <Home className="w-5 h-5" /> },
  { id: 'courses', label: 'Courses', icon: <BookOpen className="w-5 h-5" /> },
  { id: 'checkin', label: 'Check In', icon: <QrCode className="w-5 h-5" /> },
  { id: 'history', label: 'History', icon: <History className="w-5 h-5" /> },
  { id: 'profile', label: 'Profile', icon: <User className="w-5 h-5" /> },
];

export function StudentExperience({ onOpenCheckIn }: { onOpenCheckIn: (code?: string) => void }) {
  const { logout } = useAuth();
  const [activeNav, setActiveNav] = useState('home');
  const [data, setData] = useState<StudentDashboardData | null>(null);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [notifCategory, setNotifCategory] = useState<string>('');
  const [notifRefreshKey, setNotifRefreshKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [historyFilterCourse, setHistoryFilterCourse] = useState('');
  const [fallbackCode, setFallbackCode] = useState('');

  const loadStudentData = useCallback(async () => {
    try {
      const [dash, notifs] = await Promise.all([
        apiFetch<StudentDashboardData>('/api/dashboard/student'),
        apiFetch<AppNotification[]>('/api/notifications'),
      ]);
      setData(dash);
      setNotifications(notifs);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStudentData();
  }, [loadStudentData]);

  const unreadCount = useMemo(() => notifications.filter((n) => !n.read).length, [notifications]);
  const upcomingNotifications = useMemo(
    () => notifications.filter((n) => n.category === 'upcoming_class').slice(0, 3),
    [notifications]
  );

  const navItems: NavItem[] = useMemo(
    () => [
      { id: 'home', label: 'Home', icon: <Home className="w-4 h-4" /> },
      { id: 'courses', label: 'My Courses', icon: <BookOpen className="w-4 h-4" /> },
      { id: 'checkin', label: 'My Attendance', icon: <QrCode className="w-4 h-4" /> },
      { id: 'history', label: 'Attendance History', icon: <History className="w-4 h-4" /> },
      {
        id: 'notifications',
        label: 'Notifications',
        icon: <Bell className="w-4 h-4" />,
        badgeCount: unreadCount,
      },
      { id: 'profile', label: 'Profile', icon: <User className="w-4 h-4" /> },
    ],
    [unreadCount]
  );

  const markNotifRead = async (id: string) => {
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
    await apiFetch(`/api/notifications/${id}/read`, { method: 'POST' }).catch(() => {});
    setNotifRefreshKey((k) => k + 1);
  };

  const markAllNotifsRead = async () => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    await apiFetch('/api/notifications/read-all', { method: 'POST' }).catch(() => {});
    setNotifRefreshKey((k) => k + 1);
  };

  const filteredNotifications = useMemo(() => {
    if (!notifCategory) return notifications;
    return notifications.filter((n) => (n.category || 'info') === notifCategory);
  }, [notifications, notifCategory]);

  const getPercentageBarClass = (pct: number | null, threshold: number) => {
    if (pct === null) return 'bg-slate-300 dark:bg-slate-700';
    if (pct >= threshold) return 'bg-[#16845B]';
    if (pct >= Math.max(50, threshold - 15)) return 'bg-[#D99020]';
    return 'bg-[#D84A4A]';
  };

  return (
    <AppShell
      navItems={navItems}
      mobileBottomTabs={MOBILE_TABS}
      activeNav={activeNav}
      onSelectNav={setActiveNav}
      onOpenNotifications={() => setActiveNav('notifications')}
      notificationsRefreshKey={notifRefreshKey}
      primaryAction={{
        label: 'Check In',
        onClick: () => onOpenCheckIn(),
      }}
    >
      {loading || !data ? (
        <div className="bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl p-6">
          <SkeletonRows rows={5} />
        </div>
      ) : (
        <>
          {/* 1. HOME */}
          {activeNav === 'home' && (
            <div className="space-y-6">
              {/* Live Session Alert for Student's Enrolled Courses */}
              {data.liveSessions.length > 0 && (
                <div className="bg-[#14243A] text-white rounded-xl p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 border border-white/10">
                  <div>
                    <p className="text-xs font-medium text-[#0F9D91]">Attendance Open Now</p>
                    <h2 className="text-lg font-bold mt-0.5">
                      {data.liveSessions[0].courseCode} — {data.liveSessions[0].courseTitle}
                    </h2>
                    <p className="text-xs text-[#B8C4D4] mt-0.5">
                      {data.liveSessions[0].venue ? `${data.liveSessions[0].venue} · ` : ''}
                      Scan the QR code projected in the lecture hall or enter the session code.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => onOpenCheckIn()}
                    className="min-h-[44px] px-4 py-2.5 rounded-lg bg-[#4263EB] hover:bg-[#3451C7] text-sm font-medium text-white whitespace-nowrap"
                  >
                    Open Check-In
                  </button>
                </div>
              )}

              {/* Overall Progress Summary */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
                <div className="lg:col-span-2 bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl p-6 space-y-4">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                      <p className="text-xs font-medium text-[#697586] dark:text-slate-400">
                        Overall Attendance Standing
                      </p>
                      <h1 className="text-3xl font-bold font-mono-tabular text-[#172337] dark:text-slate-100 mt-1">
                        {data.overallPercentage === null ? 'No completed sessions yet' : `${data.overallPercentage}%`}
                      </h1>
                      <p className="text-xs text-[#697586] dark:text-slate-400 mt-1 font-mono-tabular">
                        {data.totalCompletedSessions > 0
                          ? `${data.presentTotal} present · ${data.lateTotal} late · ${data.missedCount} missed (${data.totalCompletedSessions} completed)`
                          : 'Percentages appear once your enrolled courses complete a lecture session.'}
                      </p>
                    </div>
                    <div className="text-left sm:text-right">
                      <span className="text-xs font-mono-tabular text-[#697586] dark:text-slate-400 block">
                        Matric: {data.student.matricNumber}
                      </span>
                      <span className="text-[11px] text-[#697586] dark:text-slate-400 mt-0.5 block">
                        Target: {data.attendanceThreshold}%
                      </span>
                    </div>
                  </div>

                  <div className="w-full h-3 bg-[#F6F8FB] dark:bg-[#09111E] border border-[#E5EAF0] dark:border-slate-800 rounded-full overflow-hidden">
                    <div
                      className={`h-full transition-all ${getPercentageBarClass(
                        data.overallPercentage,
                        data.attendanceThreshold
                      )}`}
                      style={{ width: `${Math.min(100, data.overallPercentage ?? 0)}%` }}
                    />
                  </div>
                  <p className="text-[11px] text-[#697586] dark:text-slate-400">{data.latePolicyDescription}</p>
                </div>

                <div className="bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl p-6 flex flex-col justify-between">
                  <div>
                    <p className="text-xs font-medium text-[#697586] dark:text-slate-400">Missed Sessions</p>
                    <p className="text-3xl font-bold font-mono-tabular text-[#172337] dark:text-slate-100 mt-1">
                      {data.missedCount}
                    </p>
                    <p className="text-xs text-[#697586] dark:text-slate-400 mt-1">
                      Across {data.courses.length} enrolled course(s)
                    </p>
                  </div>
                  <div className="mt-4 flex flex-wrap items-center gap-4">
                    {data.missedCount > 0 && (
                      <button
                        type="button"
                        onClick={() => setActiveNav('history')}
                        className="inline-flex items-center gap-1.5 text-xs font-medium text-[#4263EB] dark:text-blue-400 hover:underline"
                      >
                        <span>Review missed lectures</span>
                        <ArrowRight className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setActiveNav('notifications')}
                      className="inline-flex items-center gap-1.5 text-xs font-medium text-[#0F9D91] dark:text-teal-400 hover:underline"
                    >
                      <Bell className="w-3.5 h-3.5" />
                      <span>Alerts ({unreadCount} unread)</span>
                    </button>
                  </div>
                </div>
              </div>

              {/* Upcoming Classes from Timetable / Scheduled Sessions */}
              {upcomingNotifications.length > 0 && (
                <div className="bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl p-5 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Calendar className="w-4 h-4 text-[#4263EB] dark:text-blue-400" />
                      <h2 className="text-sm font-semibold text-[#172337] dark:text-slate-100">
                        Upcoming Classes & Reminders
                      </h2>
                    </div>
                    <button
                      type="button"
                      onClick={() => setActiveNav('notifications')}
                      className="text-xs font-medium text-[#4263EB] dark:text-blue-400 hover:underline"
                    >
                      All notifications
                    </button>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    {upcomingNotifications.map((n) => (
                      <div
                        key={n.id}
                        className="border border-[#E5EAF0] dark:border-slate-800 rounded-lg p-3.5 bg-[#F6F8FB]/60 dark:bg-[#09111E]"
                      >
                        <p className="text-xs font-semibold text-[#172337] dark:text-slate-100">{n.title}</p>
                        <p className="text-xs text-[#697586] dark:text-slate-400 mt-1 leading-relaxed">{n.message}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Course Attendance Progress Cards */}
              <div className="bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl p-6 space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-base font-semibold text-[#172337] dark:text-slate-100">Enrolled Courses</h2>
                  <button
                    type="button"
                    onClick={() => setActiveNav('courses')}
                    className="text-xs font-medium text-[#4263EB] dark:text-blue-400 hover:underline"
                  >
                    See all
                  </button>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {data.courses.map((c) => (
                    <div
                      key={c.courseId}
                      className="border border-[#E5EAF0] dark:border-slate-800 rounded-xl p-4 space-y-2.5 bg-white dark:bg-[#09111E]/50"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-xs font-mono-tabular font-semibold text-[#4263EB] dark:text-blue-400">
                            {c.courseCode}
                          </p>
                          <p className="text-sm font-semibold text-[#172337] dark:text-slate-100 truncate">
                            {c.courseTitle}
                          </p>
                          <p className="text-xs text-[#697586] dark:text-slate-400 mt-0.5">{c.lecturerName}</p>
                        </div>
                        <span className="text-lg font-bold font-mono-tabular text-[#172337] dark:text-slate-100 shrink-0">
                          {c.percentage === null ? '—' : `${c.percentage}%`}
                        </span>
                      </div>
                      <div className="w-full h-2 bg-[#F6F8FB] dark:bg-slate-800 rounded-full overflow-hidden">
                        <div
                          className={`h-full ${getPercentageBarClass(c.percentage, data.attendanceThreshold)}`}
                          style={{ width: `${Math.min(100, c.percentage ?? 0)}%` }}
                        />
                      </div>
                      <p className="text-xs text-[#697586] dark:text-slate-400 font-mono-tabular">
                        {c.totalEligible === 0
                          ? 'No completed sessions yet'
                          : `${c.presentCount} present · ${c.lateCount} late · ${c.missedCount} missed (${c.totalEligible} held)`}
                      </p>
                    </div>
                  ))}
                </div>
              </div>

              {/* Recent Attendance Records */}
              <div className="bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl overflow-hidden">
                <div className="px-5 py-4 border-b border-[#E5EAF0] dark:border-slate-800">
                  <h2 className="text-base font-semibold text-[#172337] dark:text-slate-100">
                    Recent Personal Attendance
                  </h2>
                </div>
                {data.recentRecords.length === 0 ? (
                  <p className="p-6 text-sm text-[#697586] dark:text-slate-400">No attendance records recorded yet.</p>
                ) : (
                  <div className="divide-y divide-[#E5EAF0] dark:divide-slate-800">
                    {data.recentRecords.slice(0, 6).map((r) => (
                      <div key={r.id} className="px-5 py-3.5 flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <p className="text-sm font-semibold text-[#172337] dark:text-slate-100">
                            {r.courseCode} · {r.lectureTitle || r.courseTitle}
                          </p>
                          <p className="text-xs text-[#697586] dark:text-slate-400 font-mono-tabular mt-0.5">
                            {r.sessionDate}
                            {r.venue ? ` · ${r.venue}` : ''}
                            {r.checkInTime
                              ? ` · Checked in ${new Date(r.checkInTime).toLocaleTimeString([], {
                                  hour: '2-digit',
                                  minute: '2-digit',
                                })}`
                              : ''}
                          </p>
                        </div>
                        <StatusLabel status={r.status} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 2. MY COURSES */}
          {activeNav === 'courses' && (
            <div className="space-y-5">
              <div>
                <h1 className="text-2xl font-bold text-[#172337] dark:text-slate-100">My Enrolled Courses</h1>
                <p className="text-sm text-[#697586] dark:text-slate-400">
                  Verified course attendance breakdown ({data.latePolicyDescription.toLowerCase()}).
                </p>
              </div>
              {data.courses.length === 0 ? (
                <EmptyState
                  title="No enrolled courses found"
                  description="Contact your department administrator if your course registrations are missing."
                />
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {data.courses.map((c) => (
                    <div
                      key={c.courseId}
                      className="bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl p-5 space-y-3"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-xs font-mono-tabular font-semibold text-[#4263EB] dark:text-blue-400">
                            {c.courseCode}
                          </p>
                          <h2 className="text-base font-bold text-[#172337] dark:text-slate-100 mt-0.5">
                            {c.courseTitle}
                          </h2>
                          <p className="text-xs text-[#697586] dark:text-slate-400 mt-0.5">
                            {c.lecturerName} · {c.semester}
                          </p>
                        </div>
                        <div className="text-right shrink-0">
                          <span className="text-xl font-bold font-mono-tabular text-[#172337] dark:text-slate-100">
                            {c.percentage === null ? '—' : `${c.percentage}%`}
                          </span>
                          {c.belowThreshold && (
                            <p className="text-[11px] font-medium text-[#D84A4A] dark:text-rose-400">
                              Below {data.attendanceThreshold}%
                            </p>
                          )}
                        </div>
                      </div>

                      <div className="w-full h-2.5 bg-[#F6F8FB] dark:bg-slate-800 border border-[#E5EAF0] dark:border-slate-700 rounded-full overflow-hidden">
                        <div
                          className={`h-full ${getPercentageBarClass(c.percentage, data.attendanceThreshold)}`}
                          style={{ width: `${Math.min(100, c.percentage ?? 0)}%` }}
                        />
                      </div>

                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-1 text-xs font-mono-tabular">
                        <div>
                          <span className="text-[#697586] dark:text-slate-400 block text-[11px]">Present</span>
                          <span className="font-semibold text-[#16845B] dark:text-emerald-400">{c.presentCount}</span>
                        </div>
                        <div>
                          <span className="text-[#697586] dark:text-slate-400 block text-[11px]">Late</span>
                          <span className="font-semibold text-[#D99020] dark:text-amber-400">{c.lateCount}</span>
                        </div>
                        <div>
                          <span className="text-[#697586] dark:text-slate-400 block text-[11px]">Missed</span>
                          <span className="font-semibold text-[#D84A4A] dark:text-rose-400">{c.missedCount}</span>
                        </div>
                        <div>
                          <span className="text-[#697586] dark:text-slate-400 block text-[11px]">Eligible</span>
                          <span className="font-semibold text-[#172337] dark:text-slate-100">{c.totalEligible}</span>
                        </div>
                      </div>

                      {c.timetableSlots && c.timetableSlots.length > 0 && (
                        <div className="pt-2.5 border-t border-[#E5EAF0] dark:border-slate-800 space-y-1">
                          {c.timetableSlots.map((slot, idx) => (
                            <p
                              key={idx}
                              className="text-xs text-[#697586] dark:text-slate-400 flex items-center gap-1.5"
                            >
                              <Clock className="w-3.5 h-3.5 text-[#0F9D91] shrink-0" />
                              <span>
                                {slot.dayOfWeek} {slot.startTime}–{slot.endTime} · {slot.venue}
                              </span>
                            </p>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 3. MY ATTENDANCE / CHECK-IN */}
          {activeNav === 'checkin' && (
            <div className="max-w-lg mx-auto space-y-5">
              <div className="bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl p-6 space-y-4">
                <h1 className="text-xl font-bold text-[#172337] dark:text-slate-100">Mark Lecture Attendance</h1>
                <p className="text-sm text-[#697586] dark:text-slate-400">
                  Point your phone&apos;s normal camera at the projected QR code in the lecture hall to open the check-in page automatically. If your camera cannot scan from your seat, enter the fallback code below.
                </p>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    onOpenCheckIn(fallbackCode.trim().toUpperCase());
                  }}
                  className="space-y-3"
                >
                  <input
                    type="text"
                    value={fallbackCode}
                    onChange={(e) => setFallbackCode(e.target.value.toUpperCase())}
                    placeholder="Enter fallback code (e.g. LASU-4K9M2P)"
                    className="w-full min-h-[46px] px-3.5 py-2 text-base font-mono-tabular border border-[#E5EAF0] dark:border-slate-700 rounded-xl bg-white dark:bg-[#09111E] text-[#172337] dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-[#4263EB]"
                  />
                  <button
                    type="submit"
                    className="w-full min-h-[46px] rounded-xl bg-[#4263EB] hover:bg-[#3451C7] text-white text-sm font-semibold transition-colors"
                  >
                    Continue to Check-In
                  </button>
                </form>
              </div>

              {data.missedSessions.length > 0 && (
                <div className="bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl p-5 space-y-3">
                  <div className="flex items-center gap-2 text-sm font-semibold text-[#D99020] dark:text-amber-400">
                    <AlertTriangle className="w-4 h-4" />
                    <span>Missed Lectures ({data.missedSessions.length})</span>
                  </div>
                  <div className="divide-y divide-[#E5EAF0] dark:divide-slate-800 text-xs">
                    {data.missedSessions.slice(0, 5).map((m) => (
                      <div key={m.id} className="py-2.5 flex justify-between gap-2">
                        <span className="text-[#172337] dark:text-slate-200">
                          {m.courseCode} · {m.lectureTitle || m.courseTitle}
                        </span>
                        <span className="font-mono-tabular text-[#697586] dark:text-slate-400">{m.sessionDate}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* 4. ATTENDANCE HISTORY */}
          {activeNav === 'history' && (
            <div className="space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h1 className="text-2xl font-bold text-[#172337] dark:text-slate-100">My Attendance History</h1>
                  <p className="text-sm text-[#697586] dark:text-slate-400">Your private, verified attendance records.</p>
                </div>
                <select
                  value={historyFilterCourse}
                  onChange={(e) => setHistoryFilterCourse(e.target.value)}
                  className="min-h-[40px] px-3 py-1.5 text-sm border border-[#E5EAF0] dark:border-slate-700 rounded-lg bg-white dark:bg-[#09111E] text-[#172337] dark:text-slate-100 w-full sm:w-auto"
                >
                  <option value="">All Courses</option>
                  {data.courses.map((c) => (
                    <option key={c.courseId} value={c.courseId}>
                      {c.courseCode}
                    </option>
                  ))}
                </select>
              </div>

              <div className="bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl overflow-hidden divide-y divide-[#E5EAF0] dark:divide-slate-800">
                {data.allRecords.filter((r) => !historyFilterCourse || r.courseId === historyFilterCourse).length ===
                0 ? (
                  <p className="p-6 text-sm text-[#697586] dark:text-slate-400">
                    No attendance records match this course filter.
                  </p>
                ) : (
                  data.allRecords
                    .filter((r) => !historyFilterCourse || r.courseId === historyFilterCourse)
                    .map((r) => (
                      <div key={r.id} className="p-4 flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <p className="text-sm font-semibold text-[#172337] dark:text-slate-100">
                            {r.courseCode} — {r.lectureTitle || r.courseTitle}
                          </p>
                          <p className="text-xs text-[#697586] dark:text-slate-400 font-mono-tabular mt-0.5">
                            {r.sessionDate}
                            {r.venue ? ` · ${r.venue}` : ''}
                            {r.checkInTime
                              ? ` · Checked in ${new Date(r.checkInTime).toLocaleTimeString([], {
                                  hour: '2-digit',
                                  minute: '2-digit',
                                })}`
                              : ''}
                            {r.checkpointStatus === 'completed' ? ' · 2nd checkpoint verified' : ''}
                          </p>
                          {r.correctionReason && (
                            <p className="text-xs text-[#4263EB] dark:text-blue-400 mt-0.5">
                              Update note: {r.correctionReason}
                            </p>
                          )}
                        </div>
                        <StatusLabel status={r.status} />
                      </div>
                    ))
                )}
              </div>
            </div>
          )}

          {/* 5. NOTIFICATION CENTRE */}
          {activeNav === 'notifications' && (
            <div className="max-w-3xl space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h1 className="text-2xl font-bold text-[#172337] dark:text-slate-100">Notifications</h1>
                  <p className="text-sm text-[#697586] dark:text-slate-400">
                    Upcoming classes from configured course timetables, attendance milestones, and record updates.
                  </p>
                </div>
                {unreadCount > 0 && (
                  <button
                    type="button"
                    onClick={markAllNotifsRead}
                    className="min-h-[40px] px-3.5 py-2 rounded-lg border border-[#E5EAF0] dark:border-slate-700 bg-white dark:bg-[#14243A] hover:bg-[#F6F8FB] dark:hover:bg-slate-800 text-xs font-medium text-[#172337] dark:text-slate-100 inline-flex items-center gap-1.5"
                  >
                    <CheckCheck className="w-4 h-4 text-[#4263EB] dark:text-blue-400" />
                    <span>Mark all read ({unreadCount})</span>
                  </button>
                )}
              </div>

              <div className="flex flex-wrap gap-2">
                {[
                  { id: '', label: 'All' },
                  { id: 'upcoming_class', label: 'Upcoming Classes' },
                  { id: 'milestone', label: 'Milestones' },
                  { id: 'attendance_update', label: 'Attendance Updates' },
                ].map((tab) => {
                  const active = notifCategory === tab.id;
                  return (
                    <button
                      key={tab.id || 'all'}
                      type="button"
                      onClick={() => setNotifCategory(tab.id)}
                      className={`min-h-[36px] px-3.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                        active
                          ? 'bg-[#14243A] dark:bg-[#4263EB] text-white border-[#14243A] dark:border-[#4263EB]'
                          : 'bg-white dark:bg-[#0F1A2B] text-[#697586] dark:text-slate-300 border-[#E5EAF0] dark:border-slate-700 hover:bg-[#F6F8FB] dark:hover:bg-slate-800'
                      }`}
                    >
                      {tab.label}
                    </button>
                  );
                })}
              </div>

              {filteredNotifications.length === 0 ? (
                <EmptyState
                  title="No notifications in this category"
                  description="Class reminders appear when course timetables or scheduled sessions exist, and milestones trigger automatically as sessions complete."
                />
              ) : (
                <div className="bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl divide-y divide-[#E5EAF0] dark:divide-slate-800 overflow-hidden">
                  {filteredNotifications.map((n) => (
                    <div
                      key={n.id}
                      className={`p-4 md:p-5 flex items-start justify-between gap-4 ${
                        n.read ? 'opacity-75' : 'bg-[#4263EB]/[0.03] dark:bg-blue-500/10'
                      }`}
                    >
                      <div className="space-y-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                          <span
                            className={`font-semibold ${
                              n.type === 'warning'
                                ? 'text-[#D99020] dark:text-amber-400'
                                : n.type === 'success'
                                  ? 'text-[#16845B] dark:text-emerald-400'
                                  : 'text-[#4263EB] dark:text-blue-400'
                            }`}
                          >
                            {n.category === 'upcoming_class'
                              ? 'Upcoming Class'
                              : n.category === 'milestone'
                                ? 'Attendance Milestone'
                                : n.category === 'attendance_update'
                                  ? 'Attendance Update'
                                  : 'Notice'}
                          </span>
                          <span className="text-[#697586] dark:text-slate-400 font-mono-tabular">
                            {new Date(n.createdAt).toLocaleString([], {
                              month: 'short',
                              day: 'numeric',
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </span>
                        </div>
                        <p className="text-sm font-semibold text-[#172337] dark:text-slate-100">{n.title}</p>
                        <p className="text-xs text-[#697586] dark:text-slate-400 leading-relaxed">{n.message}</p>
                      </div>
                      {!n.read && (
                        <button
                          type="button"
                          onClick={() => markNotifRead(n.id)}
                          className="shrink-0 text-xs font-medium text-[#4263EB] dark:text-blue-400 hover:underline whitespace-nowrap"
                        >
                          Mark read
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 6. PROFILE */}
          {activeNav === 'profile' && (
            <div className="max-w-xl space-y-5">
              <div>
                <h1 className="text-2xl font-bold text-[#172337] dark:text-slate-100">Student Profile</h1>
                <p className="text-sm text-[#697586] dark:text-slate-400">
                  Your official register identity and display preferences.
                </p>
              </div>
              <div className="bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl p-5 sm:p-6 space-y-2 text-sm">
                <div className="flex flex-col sm:flex-row sm:justify-between gap-1 py-2 border-b border-[#E5EAF0] dark:border-slate-800">
                  <span className="text-[#697586] dark:text-slate-400">Full Name</span>
                  <span className="font-medium text-[#172337] dark:text-slate-100 break-words">{data.student.fullName}</span>
                </div>
                <div className="flex flex-col sm:flex-row sm:justify-between gap-1 py-2 border-b border-[#E5EAF0] dark:border-slate-800">
                  <span className="text-[#697586] dark:text-slate-400">Matriculation Number</span>
                  <span className="font-mono-tabular font-semibold text-[#172337] dark:text-slate-100">
                    {data.student.matricNumber}
                  </span>
                </div>
                <div className="flex flex-col sm:flex-row sm:justify-between gap-1 py-2 border-b border-[#E5EAF0] dark:border-slate-800">
                  <span className="text-[#697586] dark:text-slate-400">Department</span>
                  <span className="font-medium text-[#172337] dark:text-slate-100 break-words">{data.student.departmentName}</span>
                </div>
                <div className="flex flex-col sm:flex-row sm:justify-between gap-1 py-2 border-b border-[#E5EAF0] dark:border-slate-800">
                  <span className="text-[#697586] dark:text-slate-400">Faculty</span>
                  <span className="font-medium text-[#172337] dark:text-slate-100 break-words">{data.student.facultyName}</span>
                </div>
                <div className="flex flex-col sm:flex-row sm:justify-between gap-1 py-2 border-b border-[#E5EAF0] dark:border-slate-800">
                  <span className="text-[#697586] dark:text-slate-400">Level</span>
                  <span className="font-mono-tabular font-medium text-[#172337] dark:text-slate-100">
                    {data.student.level}
                  </span>
                </div>
                <div className="flex flex-col sm:flex-row sm:justify-between gap-1 py-2">
                  <span className="text-[#697586] dark:text-slate-400">Account Status</span>
                  <StatusLabel status={data.student.accountStatus} />
                </div>
              </div>

              <div className="bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl p-6 flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h2 className="text-sm font-semibold text-[#172337] dark:text-slate-100">Appearance</h2>
                  <p className="text-xs text-[#697586] dark:text-slate-400 mt-0.5">
                    Switch between Light, Dark, or your device&apos;s System theme.
                  </p>
                </div>
                <ThemeSwitcher variant="segmented" />
              </div>

              <button
                type="button"
                onClick={logout}
                className="w-full sm:w-auto min-h-[44px] px-5 py-2.5 rounded-lg border border-[#D84A4A]/40 text-[#D84A4A] dark:text-rose-400 hover:bg-[#D84A4A]/10 text-sm font-medium"
              >
                Sign Out
              </button>
            </div>
          )}
        </>
      )}
    </AppShell>
  );
}
