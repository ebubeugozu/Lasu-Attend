import React, { useCallback, useEffect, useState } from 'react';
import {
  LayoutDashboard,
  Building2,
  BookOpen,
  Users,
  UserCheck,
  ClipboardList,
  BarChart3,
  Shield,
  Settings,
  Upload,
  Plus,
  Search,
  RefreshCw,
  Edit3,
  Trash2,
  Check,
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
import { apiFetch } from '../lib/api';
import type {
  AttendanceSession,
  AuditLog,
  Course,
  CourseTimetableSlot,
  DayOfWeek,
  Department,
  InstitutionSettings,
  LateCountPolicy,
  PlatformUser,
  StudentLevel,
  StudentRecord,
  UserRole,
} from '../types/lasu';
import { AppShell, type NavItem } from '../components/layout/AppShell';
import { Modal, SkeletonRows, StatusLabel } from '../components/ui/Common';
import { CsvImportModal } from '../components/modals/CsvImportModal';
import { LiveSessionPanel } from '../components/attendance/LiveSessionPanel';
import { ReportsAnalyticsView } from '../components/analytics/ReportsAnalyticsView';

interface AdminDashboardData {
  scope: 'institution' | 'department';
  summary: {
    totalStudents: number;
    activeStudents: number;
    pendingStudents: number;
    totalCourses: number;
    totalLecturers: number;
    totalSessionsHeld: number;
    liveSessions: number;
    averageAttendanceRate: number;
  };
  distribution: Array<{ name: string; value: number; color: string }>;
  sessionTrendSeries: Array<{
    sessionId: string;
    label: string;
    date: string;
    rate: number;
    present: number;
    late: number;
    absent: number;
  }>;
  departmentStats: Array<{
    departmentId: string;
    code: string;
    name: string;
    facultyName: string;
    studentCount: number;
    activeStudentCount: number;
    courseCount: number;
    sessionsHeld: number;
    averageRate: number;
  }>;
  recentSessions: AttendanceSession[];
  recentAuditLogs: AuditLog[];
}

interface InstitutionSettingsResponse extends InstitutionSettings {
  latePolicyDescription: string;
}

const DAYS_OF_WEEK: DayOfWeek[] = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const NAV_ITEMS: NavItem[] = [
  { id: 'overview', label: 'Overview', icon: <LayoutDashboard className="w-4 h-4" /> },
  { id: 'departments', label: 'Departments', icon: <Building2 className="w-4 h-4" /> },
  { id: 'courses', label: 'Courses', icon: <BookOpen className="w-4 h-4" /> },
  { id: 'students', label: 'Students', icon: <Users className="w-4 h-4" /> },
  { id: 'lecturers', label: 'Lecturers', icon: <UserCheck className="w-4 h-4" /> },
  { id: 'records', label: 'Attendance Records', icon: <ClipboardList className="w-4 h-4" /> },
  { id: 'reports', label: 'Reports & Analytics', icon: <BarChart3 className="w-4 h-4" /> },
  { id: 'audit', label: 'Audit Logs', icon: <Shield className="w-4 h-4" /> },
  { id: 'settings', label: 'Settings', icon: <Settings className="w-4 h-4" /> },
];

export function AdminExperience({ onOpenPresentation }: { onOpenPresentation: (sessionId: string) => void }) {
  const { user, systemStatus, firestoreReachable } = useAuth();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  const isSystemAdmin = user?.role === 'system_admin';
  const [activeNav, setActiveNav] = useState('overview');
  const [dashboard, setDashboard] = useState<AdminDashboardData | null>(null);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [sessions, setSessions] = useState<AttendanceSession[]>([]);
  const [selectedSession, setSelectedSession] = useState<AttendanceSession | null>(null);
  const [staffUsers, setStaffUsers] = useState<PlatformUser[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [auditActionFilter, setAuditActionFilter] = useState('');
  const [loading, setLoading] = useState(true);

  // Student Register state
  const [students, setStudents] = useState<StudentRecord[]>([]);
  const [studentTotal, setStudentTotal] = useState(0);
  const [studentPage, setStudentPage] = useState(1);
  const [studentSearch, setStudentSearch] = useState('');
  const [studentStatusFilter, setStudentStatusFilter] = useState('');
  const [csvModalOpen, setCsvModalOpen] = useState(false);

  // Create Department Modal
  const [deptModalOpen, setDeptModalOpen] = useState(false);
  const [deptName, setDeptName] = useState('');
  const [deptCode, setDeptCode] = useState('');
  const [deptFaculty, setDeptFaculty] = useState('Faculty of Engineering');

  // Create Course Modal
  const [courseModalOpen, setCourseModalOpen] = useState(false);
  const [courseCode, setCourseCode] = useState('');
  const [courseTitle, setCourseTitle] = useState('');
  const [courseDept, setCourseDept] = useState('');
  const [courseLevel, setCourseLevel] = useState<StudentLevel>('200L');
  const [courseLecturerUid, setCourseLecturerUid] = useState('');

  // Edit Course Schedule / Timetable Modal
  const [editCourse, setEditCourse] = useState<Course | null>(null);
  const [editCourseTitle, setEditCourseTitle] = useState('');
  const [editCourseSemester, setEditCourseSemester] = useState('');
  const [editCourseStatus, setEditCourseStatus] = useState<'active' | 'archived'>('active');
  const [editSlots, setEditSlots] = useState<CourseTimetableSlot[]>([]);
  const [savingCourse, setSavingCourse] = useState(false);
  const [courseEditError, setCourseEditError] = useState<string | null>(null);

  // Approve Staff Modal
  const [staffModalOpen, setStaffModalOpen] = useState(false);
  const [staffEmail, setStaffEmail] = useState('');
  const [staffName, setStaffName] = useState('');
  const [staffRole, setStaffRole] = useState<UserRole>('lecturer');
  const [staffDept, setStaffDept] = useState('');

  // Institution Policy Settings state
  const [instSettings, setInstSettings] = useState<InstitutionSettingsResponse | null>(null);
  const [policyValue, setPolicyValue] = useState<LateCountPolicy>('count_as_attended');
  const [thresholdValue, setThresholdValue] = useState(75);
  const [milestonesText, setMilestonesText] = useState('50, 75, 90, 100');
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsNotice, setSettingsNotice] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  const [resetNotice, setResetNotice] = useState<string | null>(null);

  const loadCore = useCallback(async () => {
    try {
      const [dash, depts, crs, ses, usrs, settingsRes] = await Promise.all([
        apiFetch<AdminDashboardData>('/api/dashboard/admin'),
        apiFetch<Department[]>('/api/departments'),
        apiFetch<Course[]>('/api/courses'),
        apiFetch<AttendanceSession[]>('/api/sessions'),
        apiFetch<PlatformUser[]>('/api/users'),
        apiFetch<InstitutionSettingsResponse>('/api/settings/institution'),
      ]);
      setDashboard(dash);
      setDepartments(depts);
      setCourses(crs);
      setSessions(ses);
      setStaffUsers(usrs);
      setInstSettings(settingsRes);
      setPolicyValue(settingsRes.lateCountPolicy);
      setThresholdValue(settingsRes.attendanceThreshold);
      setMilestonesText((settingsRes.milestonePercentages || [50, 75, 90, 100]).join(', '));
      if (!selectedSession && ses[0]) setSelectedSession(ses[0]);
      if (!courseDept && depts[0]) setCourseDept(depts[0].id);
      if (!staffDept && depts[0]) setStaffDept(depts[0].id);
    } finally {
      setLoading(false);
    }
  }, [selectedSession, courseDept, staffDept]);

  useEffect(() => {
    loadCore();
  }, [loadCore]);

  const loadStudents = useCallback(async () => {
    const q = new URLSearchParams({ page: String(studentPage), pageSize: '25' });
    if (studentSearch.trim()) q.set('search', studentSearch.trim());
    if (studentStatusFilter) q.set('status', studentStatusFilter);
    const res = await apiFetch<{ items: StudentRecord[]; total: number }>(`/api/students?${q.toString()}`);
    setStudents(res.items);
    setStudentTotal(res.total);
  }, [studentPage, studentSearch, studentStatusFilter]);

  const loadAudit = useCallback(async () => {
    const q = auditActionFilter ? `?action=${encodeURIComponent(auditActionFilter)}` : '';
    const logs = await apiFetch<AuditLog[]>(`/api/audit-logs${q}`);
    setAuditLogs(logs);
  }, [auditActionFilter]);

  useEffect(() => {
    if (activeNav === 'students') loadStudents();
    if (activeNav === 'audit') loadAudit();
  }, [activeNav, loadStudents, loadAudit]);

  const handleCreateDept = async (e: React.FormEvent) => {
    e.preventDefault();
    await apiFetch('/api/departments', {
      method: 'POST',
      body: JSON.stringify({ name: deptName, code: deptCode, facultyName: deptFaculty }),
    });
    setDeptName('');
    setDeptCode('');
    setDeptModalOpen(false);
    loadCore();
  };

  const handleCreateCourse = async (e: React.FormEvent) => {
    e.preventDefault();
    await apiFetch('/api/courses', {
      method: 'POST',
      body: JSON.stringify({
        courseCode,
        courseTitle,
        departmentId: courseDept,
        level: courseLevel,
        lecturerUid: courseLecturerUid || undefined,
      }),
    });
    setCourseCode('');
    setCourseTitle('');
    setCourseModalOpen(false);
    loadCore();
  };

  const openEditCourse = (c: Course) => {
    setEditCourse(c);
    setEditCourseTitle(c.courseTitle);
    setEditCourseSemester(c.semester);
    setEditCourseStatus(c.status);
    setEditSlots(c.timetableSlots ? c.timetableSlots.map((s) => ({ ...s })) : []);
    setCourseEditError(null);
  };

  const handleSaveCourseEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editCourse) return;
    setSavingCourse(true);
    setCourseEditError(null);
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
          status: editCourseStatus,
          timetableSlots: validSlots,
        }),
      });
      setEditCourse(null);
      await loadCore();
    } catch (err) {
      setCourseEditError(err instanceof Error ? err.message : 'Failed to update course.');
    } finally {
      setSavingCourse(false);
    }
  };

  const handleEnrolDeptCohort = async (c: Course) => {
    await apiFetch(`/api/courses/${c.id}/enrol`, {
      method: 'POST',
      body: JSON.stringify({ departmentId: c.departmentId, level: c.level }),
    });
    loadCore();
  };

  const handleApproveStaff = async (e: React.FormEvent) => {
    e.preventDefault();
    await apiFetch('/api/users/approve-staff', {
      method: 'POST',
      body: JSON.stringify({
        email: staffEmail,
        displayName: staffName,
        role: staffRole,
        departmentId: staffDept,
      }),
    });
    setStaffEmail('');
    setStaffName('');
    setStaffModalOpen(false);
    loadCore();
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingSettings(true);
    setSettingsNotice(null);
    setSettingsError(null);
    try {
      const parsedMilestones = milestonesText
        .split(/[,\s]+/)
        .map((v) => Number(v.trim()))
        .filter((n) => Number.isFinite(n) && n >= 10 && n <= 100);

      const updated = await apiFetch<InstitutionSettingsResponse>('/api/settings/institution', {
        method: 'PATCH',
        body: JSON.stringify({
          lateCountPolicy: policyValue,
          attendanceThreshold: Number(thresholdValue),
          milestonePercentages: parsedMilestones.length > 0 ? parsedMilestones : [50, 75, 90, 100],
        }),
      });
      setInstSettings(updated);
      setMilestonesText((updated.milestonePercentages || []).join(', '));
      setSettingsNotice('Attendance policy saved. All calculations and exports now reflect this configuration.');
      loadCore();
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : 'Failed to update attendance policy.');
    } finally {
      setSavingSettings(false);
    }
  };

  const handleResetDemo = async () => {
    await apiFetch('/api/admin/reset-demo', { method: 'POST' });
    setResetNotice('Demo dataset reset to clean baseline.');
    loadCore();
  };

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
        label: 'Import CSV Register',
        onClick: () => setCsvModalOpen(true),
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
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h1 className="text-2xl font-bold text-[#172337] dark:text-slate-100">
                    {dashboard.scope === 'institution' ? 'Institutional Overview' : `${user?.departmentName} Overview`}
                  </h1>
                  <p className="text-sm text-[#697586] dark:text-slate-400">
                    {dashboard.scope === 'institution'
                      ? 'Institution-wide attendance metrics and departmental compliance.'
                      : 'Department-scoped attendance metrics and staff activity.'}
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
                <div className="bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl p-5">
                  <p className="text-xs text-[#697586] dark:text-slate-400">Registered Students</p>
                  <p className="text-3xl font-bold font-mono-tabular text-[#172337] dark:text-slate-100 mt-2">
                    {dashboard.summary.totalStudents.toLocaleString()}
                  </p>
                  <p className="text-xs text-[#697586] dark:text-slate-400 mt-1 font-mono-tabular">
                    {dashboard.summary.activeStudents} active · {dashboard.summary.pendingStudents} pending
                  </p>
                </div>
                <div className="bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl p-5">
                  <p className="text-xs text-[#697586] dark:text-slate-400">Average Attendance Rate</p>
                  <p className="text-3xl font-bold font-mono-tabular text-[#172337] dark:text-slate-100 mt-2">
                    {dashboard.summary.averageAttendanceRate}%
                  </p>
                  <p className="text-xs text-[#697586] dark:text-slate-400 mt-1">
                    Across {dashboard.summary.totalSessionsHeld} completed sessions
                  </p>
                </div>
                <div className="bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl p-5">
                  <p className="text-xs text-[#697586] dark:text-slate-400">Active Courses</p>
                  <p className="text-3xl font-bold font-mono-tabular text-[#172337] dark:text-slate-100 mt-2">
                    {dashboard.summary.totalCourses}
                  </p>
                  <p className="text-xs text-[#697586] dark:text-slate-400 mt-1">
                    {dashboard.summary.totalLecturers} approved staff
                  </p>
                </div>
                <div className="bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl p-5">
                  <p className="text-xs text-[#697586] dark:text-slate-400">Live Lectures Now</p>
                  <p className="text-3xl font-bold font-mono-tabular text-[#4263EB] dark:text-blue-400 mt-2">
                    {dashboard.summary.liveSessions}
                  </p>
                  <p className="text-xs text-[#697586] dark:text-slate-400 mt-1">Real-time QR check-in active</p>
                </div>
              </div>

              {/* Phase 4 Theme-Aware Institutional Charts */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <div className="lg:col-span-2 bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl p-5">
                  <h2 className="text-base font-semibold text-[#172337] dark:text-slate-100">Session Trend</h2>
                  <p className="text-xs text-[#697586] dark:text-slate-400 mb-4">
                    Effective attendance rate across recent completed lectures
                  </p>
                  {dashboard.sessionTrendSeries.length === 0 ? (
                    <p className="py-12 text-center text-xs text-[#697586] dark:text-slate-400">
                      Complete a session to view institutional trend data.
                    </p>
                  ) : (
                    <div className="h-64">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={dashboard.sessionTrendSeries}>
                          <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
                          <XAxis dataKey="label" tick={{ fontSize: 11, fill: tickColor }} />
                          <YAxis domain={[0, 100]} unit="%" tick={{ fontSize: 11, fill: tickColor }} />
                          <Tooltip contentStyle={tooltipStyle} />
                          <Legend wrapperStyle={{ fontSize: '12px', color: tickColor }} />
                          <Line
                            type="monotone"
                            dataKey="rate"
                            name="Attendance Rate (%)"
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
                  <h2 className="text-base font-semibold text-[#172337] dark:text-slate-100">
                    Institutional Distribution
                  </h2>
                  <p className="text-xs text-[#697586] dark:text-slate-400 mb-4">
                    Present, Late, and Absent breakdown
                  </p>
                  {totalDistCount === 0 ? (
                    <div className="h-64 flex items-center justify-center text-xs text-[#697586] dark:text-slate-400">
                      No completed session records yet.
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
                            innerRadius={52}
                            outerRadius={80}
                            paddingAngle={2}
                          >
                            {dashboard.distribution.map((entry) => (
                              <Cell key={entry.name} fill={entry.color} />
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

              {dashboard.departmentStats.length > 0 && (
                <div className="bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl p-5">
                  <h2 className="text-base font-semibold text-[#172337] dark:text-slate-100">
                    Department Average Attendance
                  </h2>
                  <p className="text-xs text-[#697586] dark:text-slate-400 mb-4">
                    Weighted attendance performance across academic departments
                  </p>
                  <div className="h-60">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={dashboard.departmentStats}>
                        <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
                        <XAxis dataKey="code" tick={{ fontSize: 12, fill: axisDarkText }} />
                        <YAxis domain={[0, 100]} unit="%" tick={{ fontSize: 11, fill: tickColor }} />
                        <Tooltip contentStyle={tooltipStyle} />
                        <Bar dataKey="averageRate" name="Average Rate (%)" fill="#0F9D91" radius={[6, 6, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}

              {/* Department Breakdown */}
              <div className="bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl overflow-hidden">
                <div className="px-5 py-4 border-b border-[#E5EAF0] dark:border-slate-800 flex items-center justify-between">
                  <h2 className="text-base font-semibold text-[#172337] dark:text-slate-100">Department Breakdown</h2>
                  <button
                    type="button"
                    onClick={() => setActiveNav('departments')}
                    className="text-xs font-medium text-[#4263EB] dark:text-blue-400 hover:underline"
                  >
                    Manage departments
                  </button>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="bg-[#F6F8FB] dark:bg-[#09111E] border-b border-[#E5EAF0] dark:border-slate-800 text-xs text-[#697586] dark:text-slate-400">
                      <tr>
                        <th className="px-4 py-3 font-medium">Code</th>
                        <th className="px-4 py-3 font-medium">Department</th>
                        <th className="px-4 py-3 font-medium">Faculty</th>
                        <th className="px-4 py-3 font-medium text-right">Students</th>
                        <th className="px-4 py-3 font-medium text-right">Courses</th>
                        <th className="px-4 py-3 font-medium text-right">Sessions</th>
                        <th className="px-4 py-3 font-medium text-right">Avg Attendance</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#E5EAF0] dark:divide-slate-800">
                      {dashboard.departmentStats.map((d) => (
                        <tr key={d.departmentId} className="hover:bg-[#F6F8FB]/70 dark:hover:bg-slate-800/50">
                          <td className="px-4 py-3 font-mono-tabular font-semibold text-[#4263EB] dark:text-blue-400">
                            {d.code}
                          </td>
                          <td className="px-4 py-3 font-medium text-[#172337] dark:text-slate-100">{d.name}</td>
                          <td className="px-4 py-3 text-[#697586] dark:text-slate-400">{d.facultyName}</td>
                          <td className="px-4 py-3 text-right font-mono-tabular text-[#172337] dark:text-slate-200">
                            {d.studentCount}
                          </td>
                          <td className="px-4 py-3 text-right font-mono-tabular text-[#172337] dark:text-slate-200">
                            {d.courseCount}
                          </td>
                          <td className="px-4 py-3 text-right font-mono-tabular text-[#172337] dark:text-slate-200">
                            {d.sessionsHeld}
                          </td>
                          <td className="px-4 py-3 text-right font-mono-tabular font-semibold text-[#172337] dark:text-slate-100">
                            {d.averageRate}%
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* 2. DEPARTMENTS */}
      {activeNav === 'departments' && (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold text-[#172337] dark:text-slate-100">Academic Departments</h1>
              <p className="text-sm text-[#697586] dark:text-slate-400">
                Faculty structures supporting institutional expansion.
              </p>
            </div>
            {isSystemAdmin && (
              <button
                type="button"
                onClick={() => setDeptModalOpen(true)}
                className="min-h-[40px] px-4 py-2 rounded-lg bg-[#14243A] dark:bg-slate-800 hover:bg-[#0D1828] dark:hover:bg-slate-700 text-white text-sm font-medium inline-flex items-center gap-2"
              >
                <Plus className="w-4 h-4" />
                <span>Add Department</span>
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {departments.map((d) => (
              <div
                key={d.id}
                className="bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl p-5 flex items-center justify-between"
              >
                <div>
                  <p className="text-xs font-mono-tabular font-semibold text-[#4263EB] dark:text-blue-400">{d.code}</p>
                  <h2 className="text-base font-bold text-[#172337] dark:text-slate-100 mt-0.5">{d.name}</h2>
                  <p className="text-xs text-[#697586] dark:text-slate-400 mt-0.5">{d.facultyName}</p>
                </div>
                <StatusLabel status={d.status} />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 3. COURSES */}
      {activeNav === 'courses' && (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold text-[#172337] dark:text-slate-100">Course Directory</h1>
              <p className="text-sm text-[#697586] dark:text-slate-400">
                Manage courses, weekly lecture schedules, lecturer assignments, and student enrolments.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setCourseModalOpen(true)}
              className="min-h-[40px] px-4 py-2 rounded-lg bg-[#14243A] dark:bg-slate-800 hover:bg-[#0D1828] dark:hover:bg-slate-700 text-white text-sm font-medium inline-flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              <span>Create Course</span>
            </button>
          </div>

          <div className="bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-[#F6F8FB] dark:bg-[#09111E] border-b border-[#E5EAF0] dark:border-slate-800 text-xs text-[#697586] dark:text-slate-400">
                  <tr>
                    <th className="px-4 py-3 font-medium">Code</th>
                    <th className="px-4 py-3 font-medium">Course Title</th>
                    <th className="px-4 py-3 font-medium">Department</th>
                    <th className="px-4 py-3 font-medium">Lecturer</th>
                    <th className="px-4 py-3 font-medium">Timetable</th>
                    <th className="px-4 py-3 font-medium text-right">Enrolled</th>
                    <th className="px-4 py-3 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E5EAF0] dark:divide-slate-800">
                  {courses.map((c) => (
                    <tr key={c.id} className="hover:bg-[#F6F8FB]/70 dark:hover:bg-slate-800/50">
                      <td className="px-4 py-3 font-mono-tabular font-semibold text-[#4263EB] dark:text-blue-400">
                        {c.courseCode}
                      </td>
                      <td className="px-4 py-3 font-medium text-[#172337] dark:text-slate-100">{c.courseTitle}</td>
                      <td className="px-4 py-3 text-[#697586] dark:text-slate-400">{c.departmentName}</td>
                      <td className="px-4 py-3 text-[#172337] dark:text-slate-200">{c.lecturerName}</td>
                      <td className="px-4 py-3 text-xs text-[#697586] dark:text-slate-400">
                        {c.timetableSlots && c.timetableSlots.length > 0
                          ? c.timetableSlots.map((s) => `${s.dayOfWeek.slice(0, 3)} ${s.startTime}`).join(', ')
                          : 'Not set'}
                      </td>
                      <td className="px-4 py-3 text-right font-mono-tabular text-[#172337] dark:text-slate-100">
                        {c.enrolledCount}
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap space-x-3">
                        <button
                          type="button"
                          onClick={() => openEditCourse(c)}
                          className="text-xs font-medium text-[#172337] dark:text-slate-200 hover:underline inline-flex items-center gap-1"
                        >
                          <Edit3 className="w-3 h-3" />
                          <span>Edit Schedule</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleEnrolDeptCohort(c)}
                          className="text-xs font-medium text-[#4263EB] dark:text-blue-400 hover:underline"
                        >
                          Sync {c.level} cohort
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

      {/* 4. STUDENTS */}
      {activeNav === 'students' && (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold text-[#172337] dark:text-slate-100">Official Student Register</h1>
              <p className="text-sm text-[#697586] dark:text-slate-400 tabular-nums">
                {studentTotal} registered student(s)
              </p>
            </div>
            <button
              type="button"
              onClick={() => setCsvModalOpen(true)}
              className="min-h-[40px] px-4 py-2 rounded-lg bg-[#4263EB] hover:bg-[#3451C7] text-white text-sm font-medium inline-flex items-center gap-2"
            >
              <Upload className="w-4 h-4" />
              <span>Import CSV Register</span>
            </button>
          </div>

          <div className="flex flex-wrap gap-3">
            <div className="relative">
              <Search className="w-4 h-4 text-[#697586] dark:text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="search"
                value={studentSearch}
                onChange={(e) => {
                  setStudentSearch(e.target.value);
                  setStudentPage(1);
                }}
                placeholder="Search name or matric..."
                className="min-h-[38px] pl-9 pr-3 py-1.5 text-sm border border-[#E5EAF0] dark:border-slate-700 rounded-lg bg-white dark:bg-[#0F1A2B] text-[#172337] dark:text-slate-100 w-64"
              />
            </div>
            <select
              value={studentStatusFilter}
              onChange={(e) => {
                setStudentStatusFilter(e.target.value);
                setStudentPage(1);
              }}
              className="min-h-[38px] px-3 py-1.5 text-sm border border-[#E5EAF0] dark:border-slate-700 rounded-lg bg-white dark:bg-[#0F1A2B] text-[#172337] dark:text-slate-100"
            >
              <option value="">All account statuses</option>
              <option value="active">Active</option>
              <option value="pending_activation">Pending Activation</option>
              <option value="suspended">Suspended</option>
            </select>
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
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 font-medium">Activation Code</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E5EAF0] dark:divide-slate-800">
                  {students.map((s) => (
                    <tr key={s.id} className="hover:bg-[#F6F8FB]/70 dark:hover:bg-slate-800/50">
                      <td className="px-4 py-3 font-mono-tabular font-medium text-[#172337] dark:text-slate-100">
                        {s.matricNumber}
                      </td>
                      <td className="px-4 py-3 text-[#172337] dark:text-slate-200">{s.fullName}</td>
                      <td className="px-4 py-3 text-[#697586] dark:text-slate-400">{s.departmentName}</td>
                      <td className="px-4 py-3 font-mono-tabular text-[#697586] dark:text-slate-400">{s.level}</td>
                      <td className="px-4 py-3">
                        <StatusLabel status={s.accountStatus} />
                      </td>
                      <td className="px-4 py-3 font-mono-tabular text-xs text-[#4263EB] dark:text-blue-400">
                        {s.activationCode || '—'}
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

      {/* 5. LECTURERS & STAFF */}
      {activeNav === 'lecturers' && (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold text-[#172337] dark:text-slate-100">Lecturers & Administrators</h1>
              <p className="text-sm text-[#697586] dark:text-slate-400">
                Approve staff accounts and manage department-scoped permissions.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setStaffModalOpen(true)}
              className="min-h-[40px] px-4 py-2 rounded-lg bg-[#4263EB] hover:bg-[#3451C7] text-white text-sm font-medium inline-flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              <span>Approve Staff Account</span>
            </button>
          </div>

          <div className="bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-[#F6F8FB] dark:bg-[#09111E] border-b border-[#E5EAF0] dark:border-slate-800 text-xs text-[#697586] dark:text-slate-400">
                  <tr>
                    <th className="px-4 py-3 font-medium">Name</th>
                    <th className="px-4 py-3 font-medium">Email</th>
                    <th className="px-4 py-3 font-medium">Role</th>
                    <th className="px-4 py-3 font-medium">Department</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E5EAF0] dark:divide-slate-800">
                  {staffUsers
                    .filter((u) => u.role !== 'student')
                    .map((u) => (
                      <tr key={u.uid} className="hover:bg-[#F6F8FB]/70 dark:hover:bg-slate-800/50">
                        <td className="px-4 py-3 font-medium text-[#172337] dark:text-slate-100">{u.displayName}</td>
                        <td className="px-4 py-3 text-[#697586] dark:text-slate-400">{u.email}</td>
                        <td className="px-4 py-3 capitalize text-[#172337] dark:text-slate-200">
                          {u.role.replace('_', ' ')}
                        </td>
                        <td className="px-4 py-3 text-[#697586] dark:text-slate-400">
                          {u.departmentName || u.departmentId}
                        </td>
                        <td className="px-4 py-3">
                          <StatusLabel status={u.status} />
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* 6. ATTENDANCE RECORDS */}
      {activeNav === 'records' && (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold text-[#172337] dark:text-slate-100">
                Attendance Records & Corrections
              </h1>
              <p className="text-sm text-[#697586] dark:text-slate-400">
                Inspect session rosters and review manual adjustments.
              </p>
            </div>
            <select
              value={selectedSession?.id || ''}
              onChange={(e) => setSelectedSession(sessions.find((s) => s.id === e.target.value) || null)}
              className="min-h-[40px] px-3 py-2 text-sm border border-[#E5EAF0] dark:border-slate-700 rounded-lg bg-white dark:bg-[#0F1A2B] text-[#172337] dark:text-slate-100"
            >
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.courseCode} · {s.sessionDate} ({s.status})
                </option>
              ))}
            </select>
          </div>
          {selectedSession && (
            <LiveSessionPanel
              session={selectedSession}
              onOpenPresentation={onOpenPresentation}
              onSessionUpdated={(s) => {
                setSelectedSession(s);
                loadCore();
              }}
            />
          )}
        </div>
      )}

      {/* 7. REPORTS & ANALYTICS */}
      {activeNav === 'reports' && <ReportsAnalyticsView courses={courses} departments={departments} />}

      {/* 8. AUDIT LOGS */}
      {activeNav === 'audit' && (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold text-[#172337] dark:text-slate-100">
                Security & Attendance Audit Logs
              </h1>
              <p className="text-sm text-[#697586] dark:text-slate-400">
                Immutable record of check-ins, rejections, corrections, and role updates.
              </p>
            </div>
            <select
              value={auditActionFilter}
              onChange={(e) => setAuditActionFilter(e.target.value)}
              className="min-h-[40px] px-3 py-2 text-sm border border-[#E5EAF0] dark:border-slate-700 rounded-lg bg-white dark:bg-[#0F1A2B] text-[#172337] dark:text-slate-100"
            >
              <option value="">All Actions</option>
              <option value="SESSION_STARTED">Session Started</option>
              <option value="SESSION_CLOSED">Session Closed</option>
              <option value="STUDENT_CHECKIN_ACCEPTED">Check-In Accepted</option>
              <option value="DUPLICATE_CHECKIN_REJECTED">Duplicate Rejected</option>
              <option value="INVALID_TOKEN_REJECTED">Invalid Token Rejected</option>
              <option value="ATTENDANCE_MANUALLY_CORRECTED">Manual Corrections</option>
              <option value="STUDENT_REGISTER_IMPORTED">Register Imports</option>
              <option value="INSTITUTION_SETTINGS_UPDATED">Settings Updates</option>
            </select>
          </div>

          <div className="bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-[#F6F8FB] dark:bg-[#09111E] border-b border-[#E5EAF0] dark:border-slate-800 text-[#697586] dark:text-slate-400">
                  <tr>
                    <th className="px-4 py-3 font-medium">Timestamp</th>
                    <th className="px-4 py-3 font-medium">Actor</th>
                    <th className="px-4 py-3 font-medium">Action</th>
                    <th className="px-4 py-3 font-medium">Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E5EAF0] dark:divide-slate-800">
                  {auditLogs.map((log) => (
                    <tr key={log.id} className="hover:bg-[#F6F8FB]/70 dark:hover:bg-slate-800/50">
                      <td className="px-4 py-3 font-mono-tabular text-[#697586] dark:text-slate-400 whitespace-nowrap">
                        {new Date(log.createdAt).toLocaleString()}
                      </td>
                      <td className="px-4 py-3 font-medium text-[#172337] dark:text-slate-100 whitespace-nowrap">
                        {log.actorName} ({log.actorRole})
                      </td>
                      <td className="px-4 py-3 font-mono-tabular text-[#4263EB] dark:text-blue-400 whitespace-nowrap">
                        {log.action}
                      </td>
                      <td className="px-4 py-3 text-[#172337] dark:text-slate-200">{log.details}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* 9. SETTINGS */}
      {activeNav === 'settings' && (
        <div className="max-w-3xl space-y-6">
          <div>
            <h1 className="text-2xl font-bold text-[#172337] dark:text-slate-100">
              Institution & Platform Settings
            </h1>
            <p className="text-sm text-[#697586] dark:text-slate-400">
              Attendance calculation policy, appearance, Firebase integration status, and demo management.
            </p>
          </div>

          {resetNotice && (
            <div className="rounded-lg bg-[#16845B]/10 border border-[#16845B]/25 px-4 py-3 text-xs text-[#16845B] dark:text-emerald-400">
              {resetNotice}
            </div>
          )}

          {/* Appearance Card */}
          <div className="bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl p-6 flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold text-[#172337] dark:text-slate-100">Appearance</h2>
              <p className="text-xs text-[#697586] dark:text-slate-400 mt-0.5">
                Choose Light, Dark, or follow your operating system preference.
              </p>
            </div>
            <ThemeSwitcher variant="segmented" />
          </div>

          {/* Institutional Attendance Policy */}
          <form
            onSubmit={handleSaveSettings}
            className="bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl p-6 space-y-4"
          >
            <div>
              <h2 className="text-base font-semibold text-[#172337] dark:text-slate-100">
                Institutional Attendance Policy
              </h2>
              <p className="text-xs text-[#697586] dark:text-slate-400 mt-0.5">
                Controls how late arrivals affect attendance percentages, advisory thresholds, and student milestone notifications.
              </p>
            </div>

            {settingsNotice && (
              <div className="rounded-lg bg-[#16845B]/10 border border-[#16845B]/25 px-4 py-3 text-xs text-[#16845B] dark:text-emerald-400 flex items-center gap-2">
                <Check className="w-4 h-4 shrink-0" />
                <span>{settingsNotice}</span>
              </div>
            )}

            {settingsError && (
              <div className="rounded-lg bg-[#D84A4A]/10 border border-[#D84A4A]/25 px-4 py-3 text-xs text-[#D84A4A] dark:text-rose-400">
                {settingsError}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-[#172337] dark:text-slate-200 mb-1">
                  Late Check-In Weighting
                </label>
                <select
                  disabled={!isSystemAdmin}
                  value={policyValue}
                  onChange={(e) => setPolicyValue(e.target.value as LateCountPolicy)}
                  className="w-full min-h-[40px] px-3 py-2 text-sm border border-[#E5EAF0] dark:border-slate-700 rounded-lg bg-white dark:bg-[#09111E] text-[#172337] dark:text-slate-100 disabled:opacity-60"
                >
                  <option value="count_as_attended">Count Late as Attended (1.0x)</option>
                  <option value="count_as_half">Count Late as Half Attended (0.5x)</option>
                  <option value="count_as_absent">Count Late as Absent (0.0x)</option>
                </select>
                {instSettings?.latePolicyDescription && (
                  <p className="text-[11px] text-[#697586] dark:text-slate-400 mt-1">
                    {instSettings.latePolicyDescription}
                  </p>
                )}
              </div>

              <div>
                <label className="block text-xs font-medium text-[#172337] dark:text-slate-200 mb-1">
                  Attendance Advisory Threshold (%)
                </label>
                <input
                  type="number"
                  min={10}
                  max={100}
                  disabled={!isSystemAdmin}
                  value={thresholdValue}
                  onChange={(e) => setThresholdValue(Number(e.target.value))}
                  className="w-full min-h-[40px] px-3 py-2 text-sm font-mono-tabular border border-[#E5EAF0] dark:border-slate-700 rounded-lg bg-white dark:bg-[#09111E] text-[#172337] dark:text-slate-100 disabled:opacity-60"
                />
                <p className="text-[11px] text-[#697586] dark:text-slate-400 mt-1">
                  Default LASU requirement: 75%
                </p>
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-[#172337] dark:text-slate-200 mb-1">
                Student Milestone Notification Percentages
              </label>
              <input
                type="text"
                disabled={!isSystemAdmin}
                value={milestonesText}
                onChange={(e) => setMilestonesText(e.target.value)}
                placeholder="50, 75, 90, 100"
                className="w-full min-h-[40px] px-3 py-2 text-sm font-mono-tabular border border-[#E5EAF0] dark:border-slate-700 rounded-lg bg-white dark:bg-[#09111E] text-[#172337] dark:text-slate-100 disabled:opacity-60"
              />
              <p className="text-[11px] text-[#697586] dark:text-slate-400 mt-1">
                Comma-separated thresholds (10–100) that trigger deduplicated milestone notifications.
              </p>
            </div>

            {isSystemAdmin ? (
              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={savingSettings}
                  className="min-h-[40px] px-4 py-2 rounded-lg bg-[#4263EB] hover:bg-[#3451C7] disabled:opacity-60 text-white text-sm font-medium"
                >
                  {savingSettings ? 'Saving Policy...' : 'Save Policy Settings'}
                </button>
              </div>
            ) : (
              <p className="text-xs text-[#697586] dark:text-slate-400">
                Only System Administrators can modify institution-wide attendance policies.
              </p>
            )}
          </form>

          {/* Firebase & Persistence Diagnostics */}
          <div className="bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl p-6 space-y-4 text-sm">
            <h2 className="text-base font-semibold text-[#172337] dark:text-slate-100">
              Firebase & Persistence Status
            </h2>
            <div className="flex justify-between py-2 border-b border-[#E5EAF0] dark:border-slate-800">
              <span className="text-[#697586] dark:text-slate-400">Firebase Project ID</span>
              <span className="font-mono-tabular font-medium text-[#172337] dark:text-slate-100">
                {systemStatus?.firebaseProjectId || 'athletic-serenity-gkx2q'}
              </span>
            </div>
            <div className="flex justify-between py-2 border-b border-[#E5EAF0] dark:border-slate-800">
              <span className="text-[#697586] dark:text-slate-400">Firestore Database ID</span>
              <span className="font-mono-tabular font-medium text-[#172337] dark:text-slate-100">
                {systemStatus?.firestoreDatabaseId || 'ai-studio-e11bb378-4219-4cff-a61e-dd8da4971690'}
              </span>
            </div>
            <div className="flex justify-between py-2 border-b border-[#E5EAF0] dark:border-slate-800">
              <span className="text-[#697586] dark:text-slate-400">Firestore Client Connection</span>
              <span
                className={`font-medium ${
                  firestoreReachable ? 'text-[#16845B] dark:text-emerald-400' : 'text-[#D99020] dark:text-amber-400'
                }`}
              >
                {firestoreReachable ? 'Connected' : 'Offline'}
              </span>
            </div>
            <div className="flex justify-between py-2 border-b border-[#E5EAF0] dark:border-slate-800">
              <span className="text-[#697586] dark:text-slate-400">Active Storage Mode</span>
              <span className="font-mono-tabular font-medium text-[#172337] dark:text-slate-100">
                {systemStatus?.storageMode === 'firestore_admin'
                  ? 'firestore_admin (Persistent Cloud Firestore)'
                  : systemStatus?.storageMode === 'dev_sandbox_memory'
                    ? 'dev_sandbox_memory (Non-persistent Dev Sandbox)'
                    : 'unconfigured_error (HTTP 503 Guard Active)'}
              </span>
            </div>
            <div className="flex justify-between py-2 border-b border-[#E5EAF0] dark:border-slate-800">
              <span className="text-[#697586] dark:text-slate-400">Firebase Admin Service Account</span>
              <span className="font-medium text-[#172337] dark:text-slate-100 text-right max-w-sm">
                {systemStatus?.firebaseAdminConnected
                  ? 'Configured (Direct Firestore Admin Transactions Active)'
                  : systemStatus?.hasServiceAccount
                    ? `Configured but unreachable (${systemStatus.firestoreError || 'Check IAM permissions'})`
                    : 'Not configured (FIREBASE_SERVICE_ACCOUNT_JSON secret required for production)'}
              </span>
            </div>
            <div className="flex justify-between py-2">
              <span className="text-[#697586] dark:text-slate-400">QR Token Policy</span>
              <span className="font-mono-tabular text-[#172337] dark:text-slate-100">
                90s rotation · 15s grace window
              </span>
            </div>
          </div>

          {isSystemAdmin && systemStatus?.demoModeEnabled && (
            <div className="bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl p-6 flex items-center justify-between gap-4">
              <div>
                <h2 className="text-sm font-semibold text-[#172337] dark:text-slate-100">Reset Demo Environment</h2>
                <p className="text-xs text-[#697586] dark:text-slate-400 mt-0.5">
                  Restore the 800-student sample engineering dataset and sample sessions.
                </p>
              </div>
              <button
                type="button"
                onClick={handleResetDemo}
                className="min-h-[40px] px-4 py-2 rounded-lg border border-[#E5EAF0] dark:border-slate-700 hover:bg-[#F6F8FB] dark:hover:bg-slate-800 text-sm font-medium text-[#172337] dark:text-slate-100 inline-flex items-center gap-2 shrink-0"
              >
                <RefreshCw className="w-4 h-4" />
                <span>Reset Demo Data</span>
              </button>
            </div>
          )}
        </div>
      )}

      {/* Modals */}
      <CsvImportModal open={csvModalOpen} onClose={() => setCsvModalOpen(false)} onImported={loadStudents} />

      <Modal open={deptModalOpen} onClose={() => setDeptModalOpen(false)} title="Add Department">
        <form onSubmit={handleCreateDept} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-[#172337] dark:text-slate-200 mb-1">Faculty Name</label>
            <input
              type="text"
              required
              value={deptFaculty}
              onChange={(e) => setDeptFaculty(e.target.value)}
              className="w-full min-h-[40px] px-3 py-2 text-sm border border-[#E5EAF0] dark:border-slate-700 rounded-lg bg-white dark:bg-[#09111E] text-[#172337] dark:text-slate-100"
            />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-[#172337] dark:text-slate-200 mb-1">Code</label>
              <input
                type="text"
                required
                value={deptCode}
                onChange={(e) => setDeptCode(e.target.value)}
                placeholder="CVE"
                className="w-full min-h-[40px] px-3 py-2 text-sm border border-[#E5EAF0] dark:border-slate-700 rounded-lg bg-white dark:bg-[#09111E] text-[#172337] dark:text-slate-100"
              />
            </div>
            <div className="col-span-2">
              <label className="block text-xs font-medium text-[#172337] dark:text-slate-200 mb-1">
                Department Name
              </label>
              <input
                type="text"
                required
                value={deptName}
                onChange={(e) => setDeptName(e.target.value)}
                placeholder="Civil Engineering"
                className="w-full min-h-[40px] px-3 py-2 text-sm border border-[#E5EAF0] dark:border-slate-700 rounded-lg bg-white dark:bg-[#09111E] text-[#172337] dark:text-slate-100"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setDeptModalOpen(false)}
              className="px-4 py-2 text-sm border border-[#E5EAF0] dark:border-slate-700 rounded-lg text-[#172337] dark:text-slate-200"
            >
              Cancel
            </button>
            <button type="submit" className="px-4 py-2 text-sm font-medium text-white bg-[#4263EB] hover:bg-[#3451C7] rounded-lg">
              Save Department
            </button>
          </div>
        </form>
      </Modal>

      <Modal open={courseModalOpen} onClose={() => setCourseModalOpen(false)} title="Create Course">
        <form onSubmit={handleCreateCourse} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-[#172337] dark:text-slate-200 mb-1">Course Code</label>
              <input
                type="text"
                required
                value={courseCode}
                onChange={(e) => setCourseCode(e.target.value)}
                placeholder="ECE 205"
                className="w-full min-h-[40px] px-3 py-2 text-sm border border-[#E5EAF0] dark:border-slate-700 rounded-lg bg-white dark:bg-[#09111E] text-[#172337] dark:text-slate-100"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[#172337] dark:text-slate-200 mb-1">Level</label>
              <select
                value={courseLevel}
                onChange={(e) => setCourseLevel(e.target.value as StudentLevel)}
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
              value={courseTitle}
              onChange={(e) => setCourseTitle(e.target.value)}
              className="w-full min-h-[40px] px-3 py-2 text-sm border border-[#E5EAF0] dark:border-slate-700 rounded-lg bg-white dark:bg-[#09111E] text-[#172337] dark:text-slate-100"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-[#172337] dark:text-slate-200 mb-1">Department</label>
              <select
                value={courseDept}
                onChange={(e) => setCourseDept(e.target.value)}
                className="w-full min-h-[40px] px-3 py-2 text-sm border border-[#E5EAF0] dark:border-slate-700 rounded-lg bg-white dark:bg-[#09111E] text-[#172337] dark:text-slate-100"
              >
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.code} — {d.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-[#172337] dark:text-slate-200 mb-1">
                Assigned Lecturer
              </label>
              <select
                value={courseLecturerUid}
                onChange={(e) => setCourseLecturerUid(e.target.value)}
                className="w-full min-h-[40px] px-3 py-2 text-sm border border-[#E5EAF0] dark:border-slate-700 rounded-lg bg-white dark:bg-[#09111E] text-[#172337] dark:text-slate-100"
              >
                <option value="">Assign to me</option>
                {staffUsers
                  .filter((u) => u.role === 'lecturer' || u.role === 'department_admin')
                  .map((u) => (
                    <option key={u.uid} value={u.uid}>
                      {u.displayName}
                    </option>
                  ))}
              </select>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setCourseModalOpen(false)}
              className="px-4 py-2 text-sm border border-[#E5EAF0] dark:border-slate-700 rounded-lg text-[#172337] dark:text-slate-200"
            >
              Cancel
            </button>
            <button type="submit" className="px-4 py-2 text-sm font-medium text-white bg-[#4263EB] hover:bg-[#3451C7] rounded-lg">
              Create Course
            </button>
          </div>
        </form>
      </Modal>

      {/* Edit Course & Timetable Modal */}
      <Modal
        open={Boolean(editCourse)}
        onClose={() => setEditCourse(null)}
        title={`Edit Course & Timetable — ${editCourse?.courseCode || ''}`}
        subtitle="Manage weekly timetable slots, semester metadata, and course status."
        maxWidth="max-w-2xl"
      >
        <form onSubmit={handleSaveCourseEdit} className="space-y-4">
          {courseEditError && (
            <div className="rounded-lg bg-[#D84A4A]/10 border border-[#D84A4A]/25 px-3.5 py-2.5 text-xs text-[#D84A4A] dark:text-rose-400">
              {courseEditError}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-2">
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
              <label className="block text-xs font-medium text-[#172337] dark:text-slate-200 mb-1">Status</label>
              <select
                value={editCourseStatus}
                onChange={(e) => setEditCourseStatus(e.target.value as 'active' | 'archived')}
                className="w-full min-h-[40px] px-3 py-2 text-sm border border-[#E5EAF0] dark:border-slate-700 rounded-lg bg-white dark:bg-[#09111E] text-[#172337] dark:text-slate-100"
              >
                <option value="active">Active</option>
                <option value="archived">Archived</option>
              </select>
            </div>
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
                No timetable slots configured. Click "Add Slot" to configure day, time, and venue.
              </p>
            ) : (
              <div className="space-y-2.5 max-h-60 overflow-y-auto pr-1">
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
                      <label className="block text-[11px] text-[#697586] dark:text-slate-400 mb-1">Venue</label>
                      <input
                        type="text"
                        required
                        value={slot.venue}
                        onChange={(e) => {
                          const next = [...editSlots];
                          next[idx] = { ...slot, venue: e.target.value };
                          setEditSlots(next);
                        }}
                        placeholder="Engineering LT 1"
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
              disabled={savingCourse}
              className="px-4 py-2 text-sm font-medium text-white bg-[#4263EB] hover:bg-[#3451C7] disabled:opacity-60 rounded-lg"
            >
              {savingCourse ? 'Saving...' : 'Save Course'}
            </button>
          </div>
        </form>
      </Modal>

      <Modal open={staffModalOpen} onClose={() => setStaffModalOpen(false)} title="Approve Lecturer or Administrator">
        <form onSubmit={handleApproveStaff} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-[#172337] dark:text-slate-200 mb-1">Full Name</label>
            <input
              type="text"
              required
              value={staffName}
              onChange={(e) => setStaffName(e.target.value)}
              placeholder="Dr. Babatunde Fashola"
              className="w-full min-h-[40px] px-3 py-2 text-sm border border-[#E5EAF0] dark:border-slate-700 rounded-lg bg-white dark:bg-[#09111E] text-[#172337] dark:text-slate-100"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-[#172337] dark:text-slate-200 mb-1">
              Google / Institutional Email
            </label>
            <input
              type="email"
              required
              value={staffEmail}
              onChange={(e) => setStaffEmail(e.target.value)}
              placeholder="lecturer@lasu.edu.ng"
              className="w-full min-h-[40px] px-3 py-2 text-sm border border-[#E5EAF0] dark:border-slate-700 rounded-lg bg-white dark:bg-[#09111E] text-[#172337] dark:text-slate-100"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-[#172337] dark:text-slate-200 mb-1">Role</label>
              <select
                value={staffRole}
                onChange={(e) => setStaffRole(e.target.value as UserRole)}
                className="w-full min-h-[40px] px-3 py-2 text-sm border border-[#E5EAF0] dark:border-slate-700 rounded-lg bg-white dark:bg-[#09111E] text-[#172337] dark:text-slate-100"
              >
                <option value="lecturer">Lecturer</option>
                {isSystemAdmin && <option value="department_admin">Department Admin</option>}
                {isSystemAdmin && <option value="system_admin">System Admin</option>}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-[#172337] dark:text-slate-200 mb-1">Department</label>
              <select
                value={staffDept}
                onChange={(e) => setStaffDept(e.target.value)}
                className="w-full min-h-[40px] px-3 py-2 text-sm border border-[#E5EAF0] dark:border-slate-700 rounded-lg bg-white dark:bg-[#09111E] text-[#172337] dark:text-slate-100"
              >
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.code} — {d.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setStaffModalOpen(false)}
              className="px-4 py-2 text-sm border border-[#E5EAF0] dark:border-slate-700 rounded-lg text-[#172337] dark:text-slate-200"
            >
              Cancel
            </button>
            <button type="submit" className="px-4 py-2 text-sm font-medium text-white bg-[#4263EB] hover:bg-[#3451C7] rounded-lg">
              Approve Staff
            </button>
          </div>
        </form>
      </Modal>
    </AppShell>
  );
}
