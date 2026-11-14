import React, { useCallback, useEffect, useState } from 'react';
import {
  LayoutDashboard,
  BookOpen,
  Radio,
  History,
  Users,
  BarChart3,
  Settings,
  Plus,
  Play,
  ArrowRight,
  CheckCircle2,
  Circle,
  Search,
  Download,
  Calendar,
  Clock,
  MapPin,
  Edit3,
  Trash2,
} from 'lucide-react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
  Legend,
} from 'recharts';
import { useAuth } from '../context/AuthContext';
import { ThemeSwitcher, useTheme } from '../context/ThemeContext';
import { apiFetch, downloadReport } from '../lib/api';
import type {
  AttendanceSession,
  Course,
  CourseTimetableSlot,
  DayOfWeek,
  Department,
  StudentLevel,
  StudentRecord,
} from '../types/lasu';
import { AppShell, type NavItem } from '../components/layout/AppShell';
import { EmptyState, Modal, SkeletonRows, StatusLabel } from '../components/ui/Common';
import { StartAttendanceModal } from '../components/modals/StartAttendanceModal';
import { LiveSessionPanel } from '../components/attendance/LiveSessionPanel';
import { ReportsAnalyticsView } from '../components/analytics/ReportsAnalyticsView';

interface LecturerDashboardData {
  summary: {
    totalEnrolled: number;
    averageAttendanceRate: number;
    attendanceDelta: number | null;
    totalSessionsHeld: number;
    liveSessionCount: number;
    studentsRequiringAttention: number;
    attendanceThreshold?: number;
  };
  distribution: Array<{ name: string; value: number; color: string }>;
  trendSeries: Array<{ label: string; rate: number; present: number; late: number; absent: number }>;
  courseBreakdown: Array<{
    courseId: string;
    courseCode: string;
    courseTitle: string;
    enrolledCount: number;
    sessionsHeld: number;
    averageRate: number;
  }>;
  recentSessions: AttendanceSession[];
  atRiskStudents: Array<{
    studentId: string;
    studentName: string;
    matricNumber: string;
    attended: number;
    total: number;
    rate: number;
    courses: string[];
  }>;
  liveSessions: AttendanceSession[];
  courses: Course[];
  onboardingChecklist: {
    hasCourse: boolean;
    hasEnrolments: boolean;
    hasSession: boolean;
    hasCompletedReport: boolean;
  };
}

const DAYS_OF_WEEK: DayOfWeek[] = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const NAV_ITEMS: NavItem[] = [
  { id: 'overview', label: 'Overview', icon: <LayoutDashboard className="w-4 h-4" /> },
  { id: 'courses', label: 'My Courses', icon: <BookOpen className="w-4 h-4" /> },
  { id: 'live', label: 'Live Attendance', icon: <Radio className="w-4 h-4" /> },
  { id: 'history', label: 'Attendance History', icon: <History className="w-4 h-4" /> },
  { id: 'students', label: 'Students', icon: <Users className="w-4 h-4" /> },
  { id: 'reports', label: 'Reports & Analytics', icon: <BarChart3 className="w-4 h-4" /> },
  { id: 'settings', label: 'Settings', icon: <Settings className="w-4 h-4" /> },
];

export function LecturerExperience({ onOpenPresentation }: { onOpenPresentation: (sessionId: string) => void }) {
  const { user, systemStatus, firestoreReachable } = useAuth();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  const [activeNav, setActiveNav] = useState('overview');
  const [dashboard, setDashboard] = useState<LecturerDashboardData | null>(null);
  const [sessions, setSessions] = useState<AttendanceSession[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [selectedSession, setSelectedSession] = useState<AttendanceSession | null>(null);
  const [startModalOpen, setStartModalOpen] = useState(false);
  const [startDefaultCourseId, setStartDefaultCourseId] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  // History Export state
  const [historyExporting, setHistoryExporting] = useState<string | null>(null);
  const [historyExportError, setHistoryExportError] = useState<string | null>(null);

  // Course creation modal
  const [createCourseOpen, setCreateCourseOpen] = useState(false);
  const [newCourseCode, setNewCourseCode] = useState('');
  const [newCourseTitle, setNewCourseTitle] = useState('');
  const [newCourseDept, setNewCourseDept] = useState('');
  const [newCourseLevel, setNewCourseLevel] = useState<StudentLevel>('200L');

  // Edit Course Schedule / Timetable modal
  const [editCourse, setEditCourse] = useState<Course | null>(null);
  const [editCourseTitle, setEditCourseTitle] = useState('');
  const [editCourseSemester, setEditCourseSemester] = useState('');
  const [editSlots, setEditSlots] = useState<CourseTimetableSlot[]>([]);
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);

  // Enrol modal
  const [enrolCourse, setEnrolCourse] = useState<Course | null>(null);
  const [enrolMatrics, setEnrolMatrics] = useState('');
  const [enrolNotice, setEnrolNotice] = useState<string | null>(null);

  // Students tab state
  const [students, setStudents] = useState<StudentRecord[]>([]);
  const [studentTotal, setStudentTotal] = useState(0);
  const [studentPage, setStudentPage] = useState(1);
  const [studentSearch, setStudentSearch] = useState('');
  const [studentCourseFilter, setStudentCourseFilter] = useState('');

  const loadLecturerData = useCallback(async () => {
    try {
      const [dash, sesList, deptList] = await Promise.all([
        apiFetch<LecturerDashboardData>('/api/dashboard/lecturer'),
        apiFetch<AttendanceSession[]>('/api/sessions'),
        apiFetch<Department[]>('/api/departments'),
      ]);
      setDashboard(dash);
      setSessions(sesList);
      setDepartments(deptList);
      if (!newCourseDept && deptList[0]) setNewCourseDept(deptList[0].id);
      if (!selectedSession && dash.liveSessions[0]) {
        setSelectedSession(dash.liveSessions[0]);
      }
    } finally {
      setLoading(false);
    }
  }, [newCourseDept, selectedSession]);

  useEffect(() => {
    loadLecturerData();
  }, [loadLecturerData]);

  const loadStudents = useCallback(async () => {
    const q = new URLSearchParams({ page: String(studentPage), pageSize: '25' });
    if (studentSearch.trim()) q.set('search', studentSearch.trim());
    if (studentCourseFilter) q.set('courseId', studentCourseFilter);
    const res = await apiFetch<{ items: StudentRecord[]; total: number }>(`/api/students?${q.toString()}`);
    setStudents(res.items);
    setStudentTotal(res.total);
  }, [studentPage, studentSearch, studentCourseFilter]);

  useEffect(() => {
    if (activeNav === 'students') {
      loadStudents();
    }
  }, [activeNav, loadStudents]);

  const openStartForCourse = (courseId?: string) => {
    setStartDefaultCourseId(courseId);
    setStartModalOpen(true);
  };

  const openEditSchedule = (c: Course) => {
    setEditCourse(c);
    setEditCourseTitle(c.courseTitle);
    setEditCourseSemester(c.semester);
    setEditSlots(
      c.timetableSlots && c.timetableSlots.length > 0
        ? c.timetableSlots.map((s) => ({ ...s }))
        : []
    );
    setScheduleError(null);
  };

  const handleSaveSchedule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editCourse) return;
    setSavingSchedule(true);
    setScheduleError(null);
    try {
      const validSlots = editSlots
        .map((s) => ({
          ...s,
          venue: s.venue.trim(),
          startTime: s.startTime.trim(),
          endTime: s.endTime.trim() || s.startTime.trim(),
        }))
        .filter((s) => s.venue.length > 0 && s.startTime.length > 0);

      await apiFetch(`/api/courses/${editCourse.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          courseTitle: editCourseTitle.trim(),
          semester: editCourseSemester.trim(),
          timetableSlots: validSlots,
        }),
      });
      setEditCourse(null);
      await loadLecturerData();
    } catch (err) {
      setScheduleError(err instanceof Error ? err.message : 'Failed to update course schedule.');
    } finally {
      setSavingSchedule(false);
    }
  };

  const handleCreateCourse = async (e: React.FormEvent) => {
    e.preventDefault();
    await apiFetch('/api/courses', {
      method: 'POST',
      body: JSON.stringify({
        courseCode: newCourseCode,
        courseTitle: newCourseTitle,
        departmentId: newCourseDept,
        level: newCourseLevel,
      }),
    });
    setNewCourseCode('');
    setNewCourseTitle('');
    setCreateCourseOpen(false);
    loadLecturerData();
  };

  const handleEnrolSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!enrolCourse) return;
    const matrics = enrolMatrics
      .split(/[\s,;\n]+/)
      .map((m) => m.trim())
      .filter(Boolean);
    const res = await apiFetch<{ added: number; enrolledCount: number }>(`/api/courses/${enrolCourse.id}/enrol`, {
      method: 'POST',
      body: JSON.stringify({ matricNumbers: matrics }),
    });
    setEnrolNotice(`Added ${res.added} students (total enrolled: ${res.enrolledCount}).`);
    setEnrolMatrics('');
    loadLecturerData();
  };

  const handleHistoryExport = async (format: 'pdf' | 'csv' | 'xls') => {
    setHistoryExporting(format);
    setHistoryExportError(null);
    try {
      await downloadReport({ format });
    } catch (err) {
      setHistoryExportError(err instanceof Error ? err.message : 'Failed to download report.');
    } finally {
      setHistoryExporting(null);
    }
  };

  const courses = dashboard?.courses || [];
  const threshold = dashboard?.summary.attendanceThreshold ?? 75;
  const gridColor = isDark ? '#1E293B' : '#E5EAF0';
  const tickColor = isDark ? '#94A3B8' : '#697586';
  const axisDarkText = isDark ? '#E2E8F0' : '#172337';
  const tooltipStyle: React.CSSProperties = {
    backgroundColor: isDark ? '#0F1A2B' : '#FFFFFF',
    borderColor: isDark ? '#334155' : '#E5EAF0',
    borderRadius: '0.5rem',
    color: isDark ? '#F1F5F9' : '#172337',
    fontSize: '12px',
  };
  const totalDistCount = (dashboard?.distribution || []).reduce((acc, d) => acc + d.value, 0);

  return (
    <AppShell
      navItems={NAV_ITEMS}
      activeNav={activeNav}
      onSelectNav={setActiveNav}
      primaryAction={{
        label: 'Start Attendance',
        onClick: () => openStartForCourse(),
      }}
    >
      {/* 1. OVERVIEW */}
      {activeNav === 'overview' && (
        <div className="space-y-6">
          {loading || !dashboard ? (
            <div className="bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl p-6">
              <SkeletonRows rows={6} />
            </div>
          ) : (
            <>
              {/* Live Session Banner */}
              {dashboard.liveSessions.length > 0 && (
                <div className="bg-[#14243A] text-white rounded-xl p-5 flex flex-col md:flex-row md:items-center justify-between gap-4 border border-white/10">
                  <div>
                    <p className="text-xs font-medium text-[#0F9D91]">Active Lecture Check-In</p>
                    <h2 className="text-lg font-bold mt-0.5">
                      {dashboard.liveSessions[0].courseCode} — {dashboard.liveSessions[0].courseTitle}
                    </h2>
                    <p className="text-xs text-[#B8C4D4] mt-0.5 font-mono-tabular">
                      {dashboard.liveSessions[0].venue ? `${dashboard.liveSessions[0].venue} · ` : ''}
                      {dashboard.liveSessions[0].presentCount + dashboard.liveSessions[0].lateCount} of{' '}
                      {dashboard.liveSessions[0].totalEnrolled} students checked in
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2.5">
                    <button
                      type="button"
                      onClick={() => onOpenPresentation(dashboard.liveSessions[0].id)}
                      className="min-h-[40px] px-4 py-2 rounded-lg bg-[#4263EB] hover:bg-[#3451C7] text-sm font-medium text-white"
                    >
                      Project QR Screen
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedSession(dashboard.liveSessions[0]);
                        setActiveNav('live');
                      }}
                      className="min-h-[40px] px-4 py-2 rounded-lg bg-white/10 hover:bg-white/15 text-sm font-medium text-white"
                    >
                      Monitor Live Roster
                    </button>
                  </div>
                </div>
              )}

              {/* 4 Summary Cards */}
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
                <div className="bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl p-5">
                  <p className="text-xs font-medium text-[#697586] dark:text-slate-400">Total Enrolled Students</p>
                  <p className="text-3xl font-bold font-mono-tabular text-[#172337] dark:text-slate-100 mt-2">
                    {dashboard.summary.totalEnrolled.toLocaleString()}
                  </p>
                  <p className="text-xs text-[#697586] dark:text-slate-400 mt-1.5">
                    Across {courses.length} active course(s)
                  </p>
                </div>

                <div className="bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl p-5">
                  <p className="text-xs font-medium text-[#697586] dark:text-slate-400">Average Attendance Rate</p>
                  <p className="text-3xl font-bold font-mono-tabular text-[#172337] dark:text-slate-100 mt-2">
                    {dashboard.summary.averageAttendanceRate}%
                  </p>
                  <p className="text-xs mt-1.5 text-[#697586] dark:text-slate-400">
                    {dashboard.summary.attendanceDelta !== null ? (
                      <span
                        className={
                          dashboard.summary.attendanceDelta >= 0
                            ? 'text-[#16845B] dark:text-emerald-400 font-medium'
                            : 'text-[#D84A4A] dark:text-rose-400 font-medium'
                        }
                      >
                        {dashboard.summary.attendanceDelta >= 0 ? '+' : ''}
                        {dashboard.summary.attendanceDelta}% vs previous session
                      </span>
                    ) : (
                      'Computed from completed sessions'
                    )}
                  </p>
                </div>

                <div className="bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl p-5">
                  <p className="text-xs font-medium text-[#697586] dark:text-slate-400">Total Sessions Held</p>
                  <p className="text-3xl font-bold font-mono-tabular text-[#172337] dark:text-slate-100 mt-2">
                    {dashboard.summary.totalSessionsHeld}
                  </p>
                  <p className="text-xs text-[#697586] dark:text-slate-400 mt-1.5">
                    {dashboard.summary.liveSessionCount > 0
                      ? `${dashboard.summary.liveSessionCount} session live now`
                      : 'No live session running'}
                  </p>
                </div>

                <div className="bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl p-5">
                  <p className="text-xs font-medium text-[#697586] dark:text-slate-400">Students Requiring Attention</p>
                  <p className="text-3xl font-bold font-mono-tabular text-[#D99020] dark:text-amber-400 mt-2">
                    {dashboard.summary.studentsRequiringAttention}
                  </p>
                  <p className="text-xs text-[#697586] dark:text-slate-400 mt-1.5">
                    Below {threshold}% attendance threshold
                  </p>
                </div>
              </div>

              {/* Quick Actions & Onboarding Checklist */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <div className="lg:col-span-2 bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl p-5 flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <h2 className="text-sm font-semibold text-[#172337] dark:text-slate-100">Quick Actions</h2>
                    <p className="text-xs text-[#697586] dark:text-slate-400 mt-0.5">
                      Launch a lecture check-in or inspect course records
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2.5">
                    <button
                      type="button"
                      onClick={() => openStartForCourse()}
                      className="min-h-[40px] px-4 py-2 rounded-lg bg-[#4263EB] hover:bg-[#3451C7] text-white text-xs font-medium inline-flex items-center gap-1.5"
                    >
                      <Play className="w-3.5 h-3.5 fill-current" />
                      <span>Start Attendance</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveNav('courses')}
                      className="min-h-[40px] px-3.5 py-2 rounded-lg border border-[#E5EAF0] dark:border-slate-700 hover:bg-[#F6F8FB] dark:hover:bg-slate-800 text-xs font-medium text-[#172337] dark:text-slate-200"
                    >
                      Manage Courses
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveNav('reports')}
                      className="min-h-[40px] px-3.5 py-2 rounded-lg border border-[#E5EAF0] dark:border-slate-700 hover:bg-[#F6F8FB] dark:hover:bg-slate-800 text-xs font-medium text-[#172337] dark:text-slate-200"
                    >
                      View Reports
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveNav('students')}
                      className="min-h-[40px] px-3.5 py-2 rounded-lg border border-[#E5EAF0] dark:border-slate-700 hover:bg-[#F6F8FB] dark:hover:bg-slate-800 text-xs font-medium text-[#172337] dark:text-slate-200"
                    >
                      Manage Students
                    </button>
                  </div>
                </div>

                <div className="bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl p-5">
                  <h2 className="text-sm font-semibold text-[#172337] dark:text-slate-100 mb-3">Setup Checklist</h2>
                  <div className="space-y-2 text-xs">
                    {[
                      { done: dashboard.onboardingChecklist.hasCourse, label: 'Confirm or add a course' },
                      { done: dashboard.onboardingChecklist.hasEnrolments, label: 'Confirm student enrolment' },
                      { done: dashboard.onboardingChecklist.hasSession, label: 'Start first attendance session' },
                      { done: dashboard.onboardingChecklist.hasCompletedReport, label: 'Review completed session report' },
                    ].map((step) => (
                      <div key={step.label} className="flex items-center gap-2">
                        {step.done ? (
                          <CheckCircle2 className="w-4 h-4 text-[#16845B] dark:text-emerald-400 shrink-0" />
                        ) : (
                          <Circle className="w-4 h-4 text-[#697586] dark:text-slate-500 shrink-0" />
                        )}
                        <span className={step.done ? 'text-[#172337] dark:text-slate-200' : 'text-[#697586] dark:text-slate-400'}>
                          {step.label}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Analytics Section: Trend + Distribution + Course Comparison */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <div className="lg:col-span-2 bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl p-5">
                  <h2 className="text-base font-semibold text-[#172337] dark:text-slate-100">
                    Attendance Trend Across Recent Sessions
                  </h2>
                  <p className="text-xs text-[#697586] dark:text-slate-400 mb-4">
                    Attendance percentage per completed lecture
                  </p>
                  {dashboard.trendSeries.length === 0 ? (
                    <p className="py-12 text-center text-xs text-[#697586] dark:text-slate-400">
                      Complete a session to plot trend lines.
                    </p>
                  ) : (
                    <div className="h-64">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={dashboard.trendSeries}>
                          <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
                          <XAxis dataKey="label" tick={{ fontSize: 11, fill: tickColor }} />
                          <YAxis domain={[0, 100]} unit="%" tick={{ fontSize: 11, fill: tickColor }} />
                          <Tooltip contentStyle={tooltipStyle} />
                          <Line
                            type="monotone"
                            dataKey="rate"
                            name="Attendance (%)"
                            stroke="#4263EB"
                            strokeWidth={2.5}
                            dot={{ r: 4, fill: '#4263EB' }}
                          />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </div>

                <div className="bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl p-5">
                  <h2 className="text-base font-semibold text-[#172337] dark:text-slate-100">Present, Late & Absent</h2>
                  <p className="text-xs text-[#697586] dark:text-slate-400 mb-4">
                    Cumulative distribution across sessions
                  </p>
                  {totalDistCount === 0 ? (
                    <div className="h-64 flex items-center justify-center text-xs text-[#697586] dark:text-slate-400">
                      No completed session attendance yet.
                    </div>
                  ) : (
                    <div className="h-64">
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie
                            data={dashboard.distribution}
                            dataKey="value"
                            nameKey="name"
                            cx="50%"
                            cy="45%"
                            innerRadius={50}
                            outerRadius={78}
                            paddingAngle={2}
                          >
                            {dashboard.distribution.map((d) => (
                              <Cell key={d.name} fill={d.color} />
                            ))}
                          </Pie>
                          <Tooltip contentStyle={tooltipStyle} />
                          <Legend wrapperStyle={{ fontSize: '12px', color: tickColor }} />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </div>
              </div>

              {dashboard.courseBreakdown.length > 1 && (
                <div className="bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl p-5">
                  <h2 className="text-base font-semibold text-[#172337] dark:text-slate-100">Attendance by Course</h2>
                  <p className="text-xs text-[#697586] dark:text-slate-400 mb-4">
                    Average attendance rate across your courses
                  </p>
                  <div className="h-56">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={dashboard.courseBreakdown}>
                        <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
                        <XAxis dataKey="courseCode" tick={{ fontSize: 12, fill: axisDarkText }} />
                        <YAxis domain={[0, 100]} unit="%" tick={{ fontSize: 11, fill: tickColor }} />
                        <Tooltip contentStyle={tooltipStyle} />
                        <Bar dataKey="averageRate" name="Average Rate (%)" fill="#0F9D91" radius={[6, 6, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}

              {/* Recent Sessions + Students Requiring Attention */}
              <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
                <div className="xl:col-span-2 bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl overflow-hidden">
                  <div className="px-5 py-4 border-b border-[#E5EAF0] dark:border-slate-800 flex items-center justify-between">
                    <h2 className="text-base font-semibold text-[#172337] dark:text-slate-100">
                      Recent Attendance Sessions
                    </h2>
                    <button
                      type="button"
                      onClick={() => setActiveNav('history')}
                      className="text-xs font-medium text-[#4263EB] dark:text-blue-400 hover:underline"
                    >
                      View all
                    </button>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead className="bg-[#F6F8FB] dark:bg-[#09111E] border-b border-[#E5EAF0] dark:border-slate-800 text-xs text-[#697586] dark:text-slate-400">
                        <tr>
                          <th className="px-4 py-3 font-medium">Course</th>
                          <th className="px-4 py-3 font-medium">Date</th>
                          <th className="px-4 py-3 font-medium text-right">Rate</th>
                          <th className="px-4 py-3 font-medium text-right">Present</th>
                          <th className="px-4 py-3 font-medium text-right">Absent</th>
                          <th className="px-4 py-3 font-medium">Status</th>
                          <th className="px-4 py-3 font-medium text-right">Action</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#E5EAF0] dark:divide-slate-800">
                        {dashboard.recentSessions.map((s) => {
                          const rate =
                            s.totalEnrolled > 0
                              ? Math.round(((s.presentCount + s.lateCount) / s.totalEnrolled) * 100)
                              : 0;
                          return (
                            <tr key={s.id} className="hover:bg-[#F6F8FB]/70 dark:hover:bg-slate-800/50">
                              <td className="px-4 py-3">
                                <p className="font-semibold text-[#172337] dark:text-slate-100">{s.courseCode}</p>
                                <p className="text-xs text-[#697586] dark:text-slate-400 truncate max-w-[180px]">
                                  {s.lectureTitle}
                                </p>
                              </td>
                              <td className="px-4 py-3 font-mono-tabular text-xs text-[#697586] dark:text-slate-400 whitespace-nowrap">
                                {s.sessionDate}
                              </td>
                              <td className="px-4 py-3 text-right font-mono-tabular font-medium text-[#172337] dark:text-slate-100">
                                {s.status === 'live' ? '—' : `${rate}%`}
                              </td>
                              <td className="px-4 py-3 text-right font-mono-tabular text-[#16845B] dark:text-emerald-400">
                                {s.presentCount + s.lateCount}
                              </td>
                              <td className="px-4 py-3 text-right font-mono-tabular text-[#D84A4A] dark:text-rose-400">
                                {s.status === 'live' ? '—' : s.absentCount}
                              </td>
                              <td className="px-4 py-3">
                                <StatusLabel status={s.status} />
                              </td>
                              <td className="px-4 py-3 text-right">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setSelectedSession(s);
                                    setActiveNav('live');
                                  }}
                                  className="text-xs font-medium text-[#4263EB] dark:text-blue-400 hover:underline whitespace-nowrap"
                                >
                                  View details
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Students Requiring Attention */}
                <div className="bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl overflow-hidden flex flex-col">
                  <div className="px-5 py-4 border-b border-[#E5EAF0] dark:border-slate-800 flex items-center justify-between">
                    <h2 className="text-base font-semibold text-[#172337] dark:text-slate-100">
                      Students Requiring Attention
                    </h2>
                    <button
                      type="button"
                      onClick={() => setActiveNav('reports')}
                      className="text-xs font-medium text-[#4263EB] dark:text-blue-400 hover:underline inline-flex items-center gap-1"
                    >
                      <span>Detailed report</span>
                      <ArrowRight className="w-3 h-3" />
                    </button>
                  </div>
                  <div className="divide-y divide-[#E5EAF0] dark:divide-slate-800 flex-1">
                    {dashboard.atRiskStudents.length === 0 ? (
                      <p className="p-6 text-xs text-[#697586] dark:text-slate-400">
                        No students currently below the {threshold}% attendance threshold.
                      </p>
                    ) : (
                      dashboard.atRiskStudents.map((st) => (
                        <div key={st.studentId} className="px-5 py-3 flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-[#172337] dark:text-slate-100 truncate">
                              {st.studentName}
                            </p>
                            <p className="text-xs text-[#697586] dark:text-slate-400 font-mono-tabular">
                              {st.matricNumber} · {st.attended}/{st.total} sessions
                            </p>
                          </div>
                          <span className="font-mono-tabular text-sm font-semibold text-[#D84A4A] dark:text-rose-400 shrink-0">
                            {st.rate}%
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* 2. MY COURSES */}
      {activeNav === 'courses' && (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold text-[#172337] dark:text-slate-100">My Courses</h1>
              <p className="text-sm text-[#697586] dark:text-slate-400">
                Manage course enrolments, weekly timetable schedules, and launch lecture attendance sessions.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setCreateCourseOpen(true)}
              className="min-h-[40px] px-4 py-2 rounded-lg bg-[#14243A] dark:bg-slate-800 hover:bg-[#0D1828] dark:hover:bg-slate-700 text-white text-sm font-medium inline-flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              <span>Add Course</span>
            </button>
          </div>

          {courses.length === 0 ? (
            <EmptyState
              title="No courses assigned yet"
              description="Add a course to enrol students and start taking dynamic QR attendance."
              actionLabel="Add First Course"
              onAction={() => setCreateCourseOpen(true)}
            />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              {courses.map((c) => (
                <div
                  key={c.id}
                  className="bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl p-6 flex flex-col justify-between gap-5"
                >
                  <div>
                    <div className="flex items-center justify-between gap-2 text-xs text-[#697586] dark:text-slate-400">
                      <span className="font-mono-tabular font-semibold text-[#4263EB] dark:text-blue-400">
                        {c.courseCode}
                      </span>
                      <span>
                        {c.level} · {c.departmentName}
                      </span>
                    </div>
                    <h2 className="text-lg font-bold text-[#172337] dark:text-slate-100 mt-1.5">{c.courseTitle}</h2>
                    <p className="text-xs text-[#697586] dark:text-slate-400 mt-1">
                      {c.semester} ·{' '}
                      <span className="font-mono-tabular font-medium text-[#172337] dark:text-slate-200">
                        {c.enrolledCount}
                      </span>{' '}
                      students enrolled
                    </p>

                    {/* Configured Weekly Timetable Slots */}
                    <div className="mt-3 pt-3 border-t border-[#E5EAF0] dark:border-slate-800 space-y-1.5">
                      {c.timetableSlots && c.timetableSlots.length > 0 ? (
                        c.timetableSlots.map((slot, idx) => (
                          <div
                            key={`${slot.dayOfWeek}-${slot.startTime}-${idx}`}
                            className="flex flex-wrap items-center gap-3 text-xs text-[#697586] dark:text-slate-400"
                          >
                            <span className="inline-flex items-center gap-1 font-medium text-[#172337] dark:text-slate-200">
                              <Calendar className="w-3.5 h-3.5 text-[#4263EB] dark:text-blue-400" />
                              {slot.dayOfWeek}
                            </span>
                            <span className="inline-flex items-center gap-1 font-mono-tabular">
                              <Clock className="w-3.5 h-3.5" />
                              {slot.startTime}–{slot.endTime}
                            </span>
                            <span className="inline-flex items-center gap-1">
                              <MapPin className="w-3.5 h-3.5 text-[#0F9D91] dark:text-teal-400" />
                              {slot.venue}
                            </span>
                          </div>
                        ))
                      ) : (
                        <p className="text-[11px] text-[#697586] dark:text-slate-500">
                          No weekly lecture timetable configured yet.
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2.5 pt-4 border-t border-[#E5EAF0] dark:border-slate-800">
                    <button
                      type="button"
                      onClick={() => openStartForCourse(c.id)}
                      className="min-h-[40px] px-4 py-2 rounded-lg bg-[#4263EB] hover:bg-[#3451C7] text-white text-xs font-medium inline-flex items-center gap-1.5"
                    >
                      <Play className="w-3.5 h-3.5 fill-current" />
                      <span>Start Attendance</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => openEditSchedule(c)}
                      className="min-h-[40px] px-3.5 py-2 rounded-lg border border-[#E5EAF0] dark:border-slate-700 hover:bg-[#F6F8FB] dark:hover:bg-slate-800 text-xs font-medium text-[#172337] dark:text-slate-200 inline-flex items-center gap-1.5"
                    >
                      <Edit3 className="w-3.5 h-3.5" />
                      <span>Edit Schedule</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setEnrolCourse(c);
                        setEnrolNotice(null);
                      }}
                      className="min-h-[40px] px-3.5 py-2 rounded-lg border border-[#E5EAF0] dark:border-slate-700 hover:bg-[#F6F8FB] dark:hover:bg-slate-800 text-xs font-medium text-[#172337] dark:text-slate-200"
                    >
                      Enrol Students
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setStudentCourseFilter(c.id);
                        setActiveNav('students');
                      }}
                      className="min-h-[40px] px-3.5 py-2 rounded-lg border border-[#E5EAF0] dark:border-slate-700 hover:bg-[#F6F8FB] dark:hover:bg-slate-800 text-xs font-medium text-[#172337] dark:text-slate-200"
                    >
                      View Roster
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 3. LIVE ATTENDANCE */}
      {activeNav === 'live' && (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold text-[#172337] dark:text-slate-100">Live Attendance</h1>
              <p className="text-sm text-[#697586] dark:text-slate-400">
                Monitor check-ins, manage second checkpoints, and project the rotating QR code.
              </p>
            </div>
            <div className="w-full sm:w-auto flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5">
              <select
                value={selectedSession?.id || ''}
                onChange={(e) => {
                  const found = sessions.find((s) => s.id === e.target.value) || null;
                  setSelectedSession(found);
                }}
                aria-label="Select session"
                className="min-h-[40px] px-3 py-2 text-sm border border-[#E5EAF0] dark:border-slate-700 rounded-lg bg-white dark:bg-[#0F1A2B] text-[#172337] dark:text-slate-100 w-full sm:max-w-xs"
              >
                <option value="">Select a session...</option>
                {sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    [{s.status.toUpperCase()}] {s.courseCode} · {s.sessionDate}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => openStartForCourse()}
                className="min-h-[40px] px-4 py-2 rounded-lg bg-[#4263EB] hover:bg-[#3451C7] text-white text-sm font-medium whitespace-nowrap"
              >
                New Session
              </button>
            </div>
          </div>

          {selectedSession ? (
            <LiveSessionPanel
              session={selectedSession}
              onOpenPresentation={onOpenPresentation}
              onSessionUpdated={(updated) => {
                setSelectedSession(updated);
                loadLecturerData();
              }}
            />
          ) : (
            <EmptyState
              title="No active attendance session selected"
              description="Start a new lecture attendance session or select an existing session from the dropdown above."
              actionLabel="Start Attendance Session"
              onAction={() => openStartForCourse()}
            />
          )}
        </div>
      )}

      {/* 4. ATTENDANCE HISTORY */}
      {activeNav === 'history' && (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold text-[#172337] dark:text-slate-100">Attendance History</h1>
              <p className="text-sm text-[#697586] dark:text-slate-400">
                Inspect past lecture sessions, verify checkpoints, and export formatted reports.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={Boolean(historyExporting)}
                onClick={() => handleHistoryExport('pdf')}
                className="min-h-[40px] px-3.5 py-2 rounded-lg bg-[#4263EB] hover:bg-[#3451C7] disabled:opacity-60 text-sm font-medium text-white inline-flex items-center gap-2"
              >
                <Download className="w-4 h-4" />
                <span>{historyExporting === 'pdf' ? 'Generating PDF...' : 'Export PDF'}</span>
              </button>
              <button
                type="button"
                disabled={Boolean(historyExporting)}
                onClick={() => handleHistoryExport('csv')}
                className="min-h-[40px] px-3.5 py-2 rounded-lg border border-[#E5EAF0] dark:border-slate-700 bg-white dark:bg-[#14243A] hover:bg-[#F6F8FB] dark:hover:bg-slate-800 disabled:opacity-60 text-sm font-medium text-[#172337] dark:text-slate-100 inline-flex items-center gap-2"
              >
                <Download className="w-4 h-4" />
                <span>Export CSV</span>
              </button>
              <button
                type="button"
                disabled={Boolean(historyExporting)}
                onClick={() => handleHistoryExport('xls')}
                className="min-h-[40px] px-3.5 py-2 rounded-lg bg-[#14243A] dark:bg-slate-800 hover:bg-[#0D1828] dark:hover:bg-slate-700 disabled:opacity-60 text-sm font-medium text-white inline-flex items-center gap-2"
              >
                <Download className="w-4 h-4" />
                <span>Export Excel</span>
              </button>
            </div>
          </div>

          {historyExportError && (
            <div className="rounded-lg bg-[#D84A4A]/10 border border-[#D84A4A]/25 px-4 py-3 text-xs text-[#D84A4A] dark:text-rose-400">
              {historyExportError}
            </div>
          )}

          <div className="bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-[#F6F8FB] dark:bg-[#09111E] border-b border-[#E5EAF0] dark:border-slate-800 text-xs text-[#697586] dark:text-slate-400">
                  <tr>
                    <th className="px-4 py-3 font-medium">Course</th>
                    <th className="px-4 py-3 font-medium">Lecture Title</th>
                    <th className="px-4 py-3 font-medium">Date & Time</th>
                    <th className="px-4 py-3 font-medium text-right">Present</th>
                    <th className="px-4 py-3 font-medium text-right">Late</th>
                    <th className="px-4 py-3 font-medium text-right">Absent</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 font-medium text-right">Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E5EAF0] dark:divide-slate-800">
                  {sessions.map((s) => (
                    <tr key={s.id} className="hover:bg-[#F6F8FB]/70 dark:hover:bg-slate-800/50">
                      <td className="px-4 py-3 font-semibold text-[#172337] dark:text-slate-100">{s.courseCode}</td>
                      <td className="px-4 py-3 text-[#172337] dark:text-slate-200">{s.lectureTitle || '—'}</td>
                      <td className="px-4 py-3 font-mono-tabular text-xs text-[#697586] dark:text-slate-400">
                        {s.sessionDate} · {s.startTime}
                      </td>
                      <td className="px-4 py-3 text-right font-mono-tabular text-[#16845B] dark:text-emerald-400">
                        {s.presentCount}
                      </td>
                      <td className="px-4 py-3 text-right font-mono-tabular text-[#D99020] dark:text-amber-400">
                        {s.lateCount}
                      </td>
                      <td className="px-4 py-3 text-right font-mono-tabular text-[#D84A4A] dark:text-rose-400">
                        {s.status === 'live' ? '—' : s.absentCount}
                      </td>
                      <td className="px-4 py-3">
                        <StatusLabel status={s.status} />
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedSession(s);
                            setActiveNav('live');
                          }}
                          className="text-xs font-medium text-[#4263EB] dark:text-blue-400 hover:underline"
                        >
                          Open Roster
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* 5. STUDENTS */}
      {activeNav === 'students' && (
        <div className="space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold text-[#172337] dark:text-slate-100">Enrolled Students</h1>
              <p className="text-sm text-[#697586] dark:text-slate-400 tabular-nums">
                {studentTotal} students across your courses
              </p>
            </div>
            <div className="w-full sm:w-auto flex flex-col sm:flex-row sm:flex-wrap gap-2.5">
              <div className="relative w-full sm:w-56">
                <Search className="w-4 h-4 text-[#697586] dark:text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="search"
                  value={studentSearch}
                  onChange={(e) => {
                    setStudentSearch(e.target.value);
                    setStudentPage(1);
                  }}
                  placeholder="Search name or matric..."
                  className="min-h-[38px] pl-9 pr-3 py-1.5 text-sm border border-[#E5EAF0] dark:border-slate-700 rounded-lg bg-white dark:bg-[#0F1A2B] text-[#172337] dark:text-slate-100 w-full"
                />
              </div>
              <select
                value={studentCourseFilter}
                onChange={(e) => {
                  setStudentCourseFilter(e.target.value);
                  setStudentPage(1);
                }}
                className="min-h-[38px] px-3 py-1.5 text-sm border border-[#E5EAF0] dark:border-slate-700 rounded-lg bg-white dark:bg-[#0F1A2B] text-[#172337] dark:text-slate-100 w-full sm:w-auto"
              >
                <option value="">All My Courses</option>
                {courses.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.courseCode}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-[#F6F8FB] dark:bg-[#09111E] border-b border-[#E5EAF0] dark:border-slate-800 text-xs text-[#697586] dark:text-slate-400">
                  <tr>
                    <th className="px-4 py-3 font-medium">Matric No.</th>
                    <th className="px-4 py-3 font-medium">Full Name</th>
                    <th className="px-4 py-3 font-medium">Department</th>
                    <th className="px-4 py-3 font-medium">Level</th>
                    <th className="px-4 py-3 font-medium">Account Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E5EAF0] dark:divide-slate-800">
                  {students.map((st) => (
                    <tr key={st.id} className="hover:bg-[#F6F8FB]/70 dark:hover:bg-slate-800/50">
                      <td className="px-4 py-3 font-mono-tabular font-medium text-[#172337] dark:text-slate-100">
                        {st.matricNumber}
                      </td>
                      <td className="px-4 py-3 text-[#172337] dark:text-slate-200">{st.fullName}</td>
                      <td className="px-4 py-3 text-[#697586] dark:text-slate-400">{st.departmentName}</td>
                      <td className="px-4 py-3 font-mono-tabular text-[#697586] dark:text-slate-400">{st.level}</td>
                      <td className="px-4 py-3">
                        <StatusLabel status={st.accountStatus} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="px-4 py-3 border-t border-[#E5EAF0] dark:border-slate-800 flex items-center justify-between text-xs text-[#697586] dark:text-slate-400">
              <span className="tabular-nums">Page {studentPage}</span>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={studentPage <= 1}
                  onClick={() => setStudentPage((p) => Math.max(1, p - 1))}
                  className="px-3 py-1.5 rounded border border-[#E5EAF0] dark:border-slate-700 disabled:opacity-40 hover:bg-[#F6F8FB] dark:hover:bg-slate-800"
                >
                  Previous
                </button>
                <button
                  type="button"
                  disabled={studentPage * 25 >= studentTotal}
                  onClick={() => setStudentPage((p) => p + 1)}
                  className="px-3 py-1.5 rounded border border-[#E5EAF0] dark:border-slate-700 disabled:opacity-40 hover:bg-[#F6F8FB] dark:hover:bg-slate-800"
                >
                  Next
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 6. REPORTS & ANALYTICS */}
      {activeNav === 'reports' && <ReportsAnalyticsView courses={courses} departments={departments} />}

      {/* 7. SETTINGS */}
      {activeNav === 'settings' && (
        <div className="max-w-2xl space-y-6">
          <div>
            <h1 className="text-2xl font-bold text-[#172337] dark:text-slate-100">Lecturer Settings</h1>
            <p className="text-sm text-[#697586] dark:text-slate-400">
              Appearance preferences, account details, and QR attendance configuration.
            </p>
          </div>

          <div className="bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl p-6 flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold text-[#172337] dark:text-slate-100">Appearance</h2>
              <p className="text-xs text-[#697586] dark:text-slate-400 mt-0.5">
                Choose Light, Dark, or follow your device system setting.
              </p>
            </div>
            <ThemeSwitcher variant="segmented" />
          </div>

          <div className="bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl p-5 sm:p-6 space-y-2 text-sm">
            <div className="flex flex-col sm:flex-row sm:justify-between gap-1 py-2 border-b border-[#E5EAF0] dark:border-slate-800">
              <span className="text-[#697586] dark:text-slate-400">Lecturer Name</span>
              <span className="font-medium text-[#172337] dark:text-slate-100 break-words">{user?.displayName}</span>
            </div>
            <div className="flex flex-col sm:flex-row sm:justify-between gap-1 py-2 border-b border-[#E5EAF0] dark:border-slate-800">
              <span className="text-[#697586] dark:text-slate-400">Email</span>
              <span className="font-medium text-[#172337] dark:text-slate-100 break-all">{user?.email}</span>
            </div>
            <div className="flex flex-col sm:flex-row sm:justify-between gap-1 py-2 border-b border-[#E5EAF0] dark:border-slate-800">
              <span className="text-[#697586] dark:text-slate-400">Default QR Rotation Interval</span>
              <span className="font-mono-tabular font-medium text-[#172337] dark:text-slate-100">
                90 seconds (15s grace period)
              </span>
            </div>
            <div className="flex flex-col sm:flex-row sm:justify-between gap-1 py-2 border-b border-[#E5EAF0] dark:border-slate-800">
              <span className="text-[#697586] dark:text-slate-400">Firestore Client Connection</span>
              <span
                className={`font-medium ${
                  firestoreReachable ? 'text-[#16845B] dark:text-emerald-400' : 'text-[#D99020] dark:text-amber-400'
                }`}
              >
                {firestoreReachable ? 'Connected' : 'Offline'}
              </span>
            </div>
            <div className="flex flex-col sm:flex-row sm:justify-between gap-1 py-2">
              <span className="text-[#697586] dark:text-slate-400">Backend Persistence Mode</span>
              <span className="font-medium text-[#172337] dark:text-slate-100 sm:text-right">
                {systemStatus?.storageMode === 'firestore_admin'
                  ? 'Cloud Firestore (Admin SDK)'
                  : systemStatus?.storageMode === 'dev_sandbox_memory'
                    ? 'Development Sandbox (In-Memory)'
                    : 'Database Configuration Required'}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Modals */}
      <StartAttendanceModal
        open={startModalOpen}
        onClose={() => setStartModalOpen(false)}
        courses={courses}
        defaultCourseId={startDefaultCourseId}
        onStarted={(session) => {
          setSelectedSession(session);
          loadLecturerData();
          setActiveNav('live');
        }}
      />

      <Modal open={createCourseOpen} onClose={() => setCreateCourseOpen(false)} title="Create Course">
        <form onSubmit={handleCreateCourse} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-[#172337] dark:text-slate-200 mb-1">Course Code</label>
              <input
                type="text"
                required
                value={newCourseCode}
                onChange={(e) => setNewCourseCode(e.target.value)}
                placeholder="e.g. MEC 204"
                className="w-full min-h-[40px] px-3 py-2 text-sm border border-[#E5EAF0] dark:border-slate-700 rounded-lg bg-white dark:bg-[#09111E] text-[#172337] dark:text-slate-100"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[#172337] dark:text-slate-200 mb-1">Level</label>
              <select
                value={newCourseLevel}
                onChange={(e) => setNewCourseLevel(e.target.value as StudentLevel)}
                className="w-full min-h-[40px] px-3 py-2 text-sm border border-[#E5EAF0] dark:border-slate-700 rounded-lg bg-white dark:bg-[#09111E] text-[#172337] dark:text-slate-100"
              >
                <option value="100L">100L</option>
                <option value="200L">200L</option>
                <option value="300L">300L</option>
                <option value="400L">400L</option>
                <option value="500L">500L</option>
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-[#172337] dark:text-slate-200 mb-1">Course Title</label>
            <input
              type="text"
              required
              value={newCourseTitle}
              onChange={(e) => setNewCourseTitle(e.target.value)}
              placeholder="e.g. Fluid Mechanics I"
              className="w-full min-h-[40px] px-3 py-2 text-sm border border-[#E5EAF0] dark:border-slate-700 rounded-lg bg-white dark:bg-[#09111E] text-[#172337] dark:text-slate-100"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-[#172337] dark:text-slate-200 mb-1">Department</label>
            <select
              value={newCourseDept}
              onChange={(e) => setNewCourseDept(e.target.value)}
              className="w-full min-h-[40px] px-3 py-2 text-sm border border-[#E5EAF0] dark:border-slate-700 rounded-lg bg-white dark:bg-[#09111E] text-[#172337] dark:text-slate-100"
            >
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.code} — {d.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setCreateCourseOpen(false)}
              className="px-4 py-2 text-sm border border-[#E5EAF0] dark:border-slate-700 rounded-lg text-[#172337] dark:text-slate-200"
            >
              Cancel
            </button>
            <button type="submit" className="px-4 py-2 text-sm font-medium text-white bg-[#4263EB] hover:bg-[#3451C7] rounded-lg">
              Save Course
            </button>
          </div>
        </form>
      </Modal>

      {/* Edit Course Schedule & Timetable Modal */}
      <Modal
        open={Boolean(editCourse)}
        onClose={() => setEditCourse(null)}
        title={`Edit Course & Timetable — ${editCourse?.courseCode || ''}`}
        subtitle="Configure official weekly lecture days, times, and hall venues for student reminders."
        maxWidth="max-w-2xl"
      >
        <form onSubmit={handleSaveSchedule} className="space-y-4">
          {scheduleError && (
            <div className="rounded-lg bg-[#D84A4A]/10 border border-[#D84A4A]/25 px-3.5 py-2.5 text-xs text-[#D84A4A] dark:text-rose-400">
              {scheduleError}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-[#172337] dark:text-slate-200 mb-1">Course Title</label>
              <input
                type="text"
                required
                value={editCourseTitle}
                onChange={(e) => setEditCourseTitle(e.target.value)}
                className="w-full min-h-[40px] px-3 py-2 text-sm border border-[#E5EAF0] dark:border-slate-700 rounded-lg bg-white dark:bg-[#09111E] text-[#172337] dark:text-slate-100"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[#172337] dark:text-slate-200 mb-1">Semester</label>
              <input
                type="text"
                required
                value={editCourseSemester}
                onChange={(e) => setEditCourseSemester(e.target.value)}
                className="w-full min-h-[40px] px-3 py-2 text-sm border border-[#E5EAF0] dark:border-slate-700 rounded-lg bg-white dark:bg-[#09111E] text-[#172337] dark:text-slate-100"
              />
            </div>
          </div>

          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold text-[#172337] dark:text-slate-200">
                Weekly Lecture Slots ({editSlots.length})
              </label>
              <button
                type="button"
                onClick={() =>
                  setEditSlots((prev) => [
                    ...prev,
                    { dayOfWeek: 'Monday', startTime: '09:00', endTime: '11:00', venue: '' },
                  ])
                }
                className="px-3 py-1.5 rounded-lg border border-[#E5EAF0] dark:border-slate-700 hover:bg-[#F6F8FB] dark:hover:bg-slate-800 text-xs font-medium text-[#4263EB] dark:text-blue-400 inline-flex items-center gap-1"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add Slot</span>
              </button>
            </div>

            {editSlots.length === 0 ? (
              <p className="text-xs text-[#697586] dark:text-slate-400 py-3 px-3 rounded-lg bg-[#F6F8FB] dark:bg-[#09111E] border border-dashed border-[#E5EAF0] dark:border-slate-700">
                No timetable slots added. Click "Add Slot" to set a lecture day, time, and hall venue.
              </p>
            ) : (
              <div className="space-y-2.5 max-h-64 overflow-y-auto pr-1">
                {editSlots.map((slot, idx) => (
                  <div
                    key={idx}
                    className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-end p-3 rounded-lg bg-[#F6F8FB] dark:bg-[#09111E] border border-[#E5EAF0] dark:border-slate-800"
                  >
                    <div className="sm:col-span-3">
                      <label className="block text-[11px] text-[#697586] dark:text-slate-400 mb-1">Day</label>
                      <select
                        value={slot.dayOfWeek}
                        onChange={(e) => {
                          const next = [...editSlots];
                          next[idx] = { ...slot, dayOfWeek: e.target.value as DayOfWeek };
                          setEditSlots(next);
                        }}
                        className="w-full min-h-[36px] px-2 py-1 text-xs border border-[#E5EAF0] dark:border-slate-700 rounded bg-white dark:bg-[#0F1A2B] text-[#172337] dark:text-slate-100"
                      >
                        {DAYS_OF_WEEK.map((d) => (
                          <option key={d} value={d}>
                            {d}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="sm:col-span-2">
                      <label className="block text-[11px] text-[#697586] dark:text-slate-400 mb-1">Start</label>
                      <input
                        type="time"
                        required
                        value={slot.startTime}
                        onChange={(e) => {
                          const next = [...editSlots];
                          next[idx] = { ...slot, startTime: e.target.value };
                          setEditSlots(next);
                        }}
                        className="w-full min-h-[36px] px-2 py-1 text-xs font-mono-tabular border border-[#E5EAF0] dark:border-slate-700 rounded bg-white dark:bg-[#0F1A2B] text-[#172337] dark:text-slate-100"
                      />
                    </div>
                    <div className="sm:col-span-2">
                      <label className="block text-[11px] text-[#697586] dark:text-slate-400 mb-1">End</label>
                      <input
                        type="time"
                        required
                        value={slot.endTime}
                        onChange={(e) => {
                          const next = [...editSlots];
                          next[idx] = { ...slot, endTime: e.target.value };
                          setEditSlots(next);
                        }}
                        className="w-full min-h-[36px] px-2 py-1 text-xs font-mono-tabular border border-[#E5EAF0] dark:border-slate-700 rounded bg-white dark:bg-[#0F1A2B] text-[#172337] dark:text-slate-100"
                      />
                    </div>
                    <div className="sm:col-span-4">
                      <label className="block text-[11px] text-[#697586] dark:text-slate-400 mb-1">Hall / Venue</label>
                      <input
                        type="text"
                        required
                        value={slot.venue}
                        onChange={(e) => {
                          const next = [...editSlots];
                          next[idx] = { ...slot, venue: e.target.value };
                          setEditSlots(next);
                        }}
                        placeholder="e.g. Engineering LT 1"
                        className="w-full min-h-[36px] px-2.5 py-1 text-xs border border-[#E5EAF0] dark:border-slate-700 rounded bg-white dark:bg-[#0F1A2B] text-[#172337] dark:text-slate-100"
                      />
                    </div>
                    <div className="sm:col-span-1 flex justify-end">
                      <button
                        type="button"
                        aria-label="Remove timetable slot"
                        onClick={() => setEditSlots((prev) => prev.filter((_, i) => i !== idx))}
                        className="min-w-[36px] min-h-[36px] flex items-center justify-center rounded border border-[#E5EAF0] dark:border-slate-700 text-[#D84A4A] dark:text-rose-400 hover:bg-[#D84A4A]/10"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setEditCourse(null)}
              className="px-4 py-2 text-sm border border-[#E5EAF0] dark:border-slate-700 rounded-lg text-[#172337] dark:text-slate-200"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={savingSchedule}
              className="px-4 py-2 text-sm font-medium text-white bg-[#4263EB] hover:bg-[#3451C7] disabled:opacity-60 rounded-lg"
            >
              {savingSchedule ? 'Saving...' : 'Save Schedule'}
            </button>
          </div>
        </form>
      </Modal>

      <Modal
        open={Boolean(enrolCourse)}
        onClose={() => setEnrolCourse(null)}
        title={`Enrol Students — ${enrolCourse?.courseCode || ''}`}
        subtitle="Enter matriculation numbers separated by commas, spaces, or new lines."
      >
        <form onSubmit={handleEnrolSubmit} className="space-y-4">
          {enrolNotice && (
            <div className="rounded-lg bg-[#16845B]/10 border border-[#16845B]/25 px-3.5 py-2.5 text-xs text-[#16845B] dark:text-emerald-400">
              {enrolNotice}
            </div>
          )}
          <textarea
            rows={4}
            required
            value={enrolMatrics}
            onChange={(e) => setEnrolMatrics(e.target.value)}
            placeholder="230591001, 230591002, 230591999"
            className="w-full px-3 py-2 text-sm font-mono-tabular border border-[#E5EAF0] dark:border-slate-700 rounded-lg bg-white dark:bg-[#09111E] text-[#172337] dark:text-slate-100"
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setEnrolCourse(null)}
              className="px-4 py-2 text-sm border border-[#E5EAF0] dark:border-slate-700 rounded-lg text-[#172337] dark:text-slate-200"
            >
              Close
            </button>
            <button type="submit" className="px-4 py-2 text-sm font-medium text-white bg-[#4263EB] hover:bg-[#3451C7] rounded-lg">
              Enrol Students
            </button>
          </div>
        </form>
      </Modal>
    </AppShell>
  );
}
