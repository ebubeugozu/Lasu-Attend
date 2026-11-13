import React, { useCallback, useEffect, useMemo, useState } from 'react';
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
import { Download, AlertTriangle, Search } from 'lucide-react';
import type { Course, Department } from '../../types/lasu';
import { useTheme } from '../../context/ThemeContext';
import { apiFetch, downloadReport } from '../../lib/api';
import { EmptyState, SkeletonRows } from '../ui/Common';

interface AnalyticsResponse {
  lateCountPolicy?: string;
  summary: {
    averageRate: number;
    presentCount: number;
    lateCount: number;
    absentCount: number;
    excusedCount?: number;
    enrolledCount: number;
    sessionsCount: number;
  };
  distribution: Array<{ name: string; value: number; color: string }>;
  sessionSeries: Array<{
    sessionId: string;
    label: string;
    courseCode: string;
    date: string;
    present: number;
    late: number;
    absent: number;
    totalEnrolled: number;
    rate: number;
  }>;
  studentHistogram: Array<{ range: string; count: number }>;
  courseComparison: Array<{
    courseId: string;
    courseCode: string;
    courseTitle: string;
    enrolledCount: number;
    sessionsHeld: number;
    averageRate: number;
  }>;
  lowAttendanceStudents: Array<{
    studentId: string;
    studentName: string;
    matricNumber: string;
    present: number;
    late: number;
    absent: number;
    total: number;
    rate: number;
  }>;
  lowAttendanceSessions: Array<{
    sessionId: string;
    label: string;
    date: string;
    rate: number;
  }>;
}

export function ReportsAnalyticsView({
  courses,
  departments,
}: {
  courses: Course[];
  departments?: Department[];
}) {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  const [departmentId, setDepartmentId] = useState('');
  const [courseId, setCourseId] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [studentQuery, setStudentQuery] = useState('');
  const [riskThreshold, setRiskThreshold] = useState(75);
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const visibleCourses = useMemo(
    () => (departmentId ? courses.filter((c) => c.departmentId === departmentId) : courses),
    [courses, departmentId]
  );

  useEffect(() => {
    if (courseId && !visibleCourses.some((c) => c.id === courseId)) {
      setCourseId('');
    }
  }, [visibleCourses, courseId]);

  const loadAnalytics = useCallback(async () => {
    setLoading(true);
    try {
      const q = new URLSearchParams({ riskThreshold: String(riskThreshold) });
      if (departmentId) q.set('departmentId', departmentId);
      if (courseId) q.set('courseId', courseId);
      if (dateFrom) q.set('dateFrom', dateFrom);
      if (dateTo) q.set('dateTo', dateTo);
      if (statusFilter) q.set('status', statusFilter);
      if (studentQuery.trim()) q.set('student', studentQuery.trim());
      const res = await apiFetch<AnalyticsResponse>(`/api/reports/analytics?${q.toString()}`);
      setData(res);
    } finally {
      setLoading(false);
    }
  }, [departmentId, courseId, dateFrom, dateTo, statusFilter, studentQuery, riskThreshold]);

  useEffect(() => {
    loadAnalytics();
  }, [loadAnalytics]);

  const handleExport = async (format: 'pdf' | 'csv' | 'xls') => {
    setExporting(format);
    setExportError(null);
    try {
      await downloadReport({
        departmentId: departmentId || undefined,
        courseId: courseId || undefined,
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
        status: statusFilter || undefined,
        student: studentQuery.trim() || undefined,
        format,
      });
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Failed to export report.');
    } finally {
      setExporting(null);
    }
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

  const totalDistValue = (data?.distribution || []).reduce((acc, d) => acc + d.value, 0);

  return (
    <div className="space-y-6">
      {/* Header & Exports */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-[#172337] dark:text-slate-100">Reports & Analytics</h1>
          <p className="text-sm text-[#697586] dark:text-slate-400 mt-0.5">
            Track attendance patterns, session outcomes, and students requiring academic follow-up.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            disabled={Boolean(exporting)}
            onClick={() => handleExport('pdf')}
            className="min-h-[40px] px-3.5 py-2 rounded-lg bg-[#4263EB] hover:bg-[#3451C7] disabled:opacity-60 text-white text-sm font-medium inline-flex items-center gap-2"
          >
            <Download className="w-4 h-4" />
            <span>{exporting === 'pdf' ? 'Generating PDF...' : 'Export PDF'}</span>
          </button>
          <button
            type="button"
            disabled={Boolean(exporting)}
            onClick={() => handleExport('csv')}
            className="min-h-[40px] px-3.5 py-2 rounded-lg border border-[#E5EAF0] dark:border-slate-700 bg-white dark:bg-[#14243A] hover:bg-[#F6F8FB] dark:hover:bg-slate-800 disabled:opacity-60 text-sm font-medium text-[#172337] dark:text-slate-100 inline-flex items-center gap-2"
          >
            <Download className="w-4 h-4" />
            <span>Export CSV</span>
          </button>
          <button
            type="button"
            disabled={Boolean(exporting)}
            onClick={() => handleExport('xls')}
            className="min-h-[40px] px-3.5 py-2 rounded-lg bg-[#14243A] dark:bg-slate-800 hover:bg-[#0D1828] dark:hover:bg-slate-700 disabled:opacity-60 text-white text-sm font-medium inline-flex items-center gap-2"
          >
            <Download className="w-4 h-4" />
            <span>Export Excel (.xls)</span>
          </button>
        </div>
      </div>

      {exportError && (
        <div className="rounded-lg bg-[#D84A4A]/10 border border-[#D84A4A]/25 px-4 py-3 text-xs text-[#D84A4A] dark:text-rose-400">
          {exportError}
        </div>
      )}

      {/* Unified Filters Bar */}
      <div className="bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        {departments && departments.length > 1 && (
          <div>
            <label className="block text-xs font-medium text-[#697586] dark:text-slate-400 mb-1">Department</label>
            <select
              value={departmentId}
              onChange={(e) => setDepartmentId(e.target.value)}
              className="w-full min-h-[38px] px-3 py-1.5 text-sm border border-[#E5EAF0] dark:border-slate-700 rounded-lg bg-white dark:bg-[#09111E] text-[#172337] dark:text-slate-100"
            >
              <option value="">All Departments</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.code} — {d.name}
                </option>
              ))}
            </select>
          </div>
        )}

        <div>
          <label className="block text-xs font-medium text-[#697586] dark:text-slate-400 mb-1">Course</label>
          <select
            value={courseId}
            onChange={(e) => setCourseId(e.target.value)}
            className="w-full min-h-[38px] px-3 py-1.5 text-sm border border-[#E5EAF0] dark:border-slate-700 rounded-lg bg-white dark:bg-[#09111E] text-[#172337] dark:text-slate-100"
          >
            <option value="">All Authorised Courses</option>
            {visibleCourses.map((c) => (
              <option key={c.id} value={c.id}>
                {c.courseCode} — {c.courseTitle}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs font-medium text-[#697586] dark:text-slate-400 mb-1">From Date</label>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="w-full min-h-[38px] px-3 py-1.5 text-sm font-mono-tabular border border-[#E5EAF0] dark:border-slate-700 rounded-lg bg-white dark:bg-[#09111E] text-[#172337] dark:text-slate-100"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-[#697586] dark:text-slate-400 mb-1">To Date</label>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="w-full min-h-[38px] px-3 py-1.5 text-sm font-mono-tabular border border-[#E5EAF0] dark:border-slate-700 rounded-lg bg-white dark:bg-[#09111E] text-[#172337] dark:text-slate-100"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-[#697586] dark:text-slate-400 mb-1">Status</label>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="w-full min-h-[38px] px-3 py-1.5 text-sm border border-[#E5EAF0] dark:border-slate-700 rounded-lg bg-white dark:bg-[#09111E] text-[#172337] dark:text-slate-100"
          >
            <option value="">All Statuses</option>
            <option value="present">Present</option>
            <option value="late">Late</option>
            <option value="absent">Absent</option>
            <option value="excused">Excused</option>
          </select>
        </div>

        <div>
          <label className="block text-xs font-medium text-[#697586] dark:text-slate-400 mb-1">Student Filter</label>
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-[#697586] dark:text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="search"
              value={studentQuery}
              onChange={(e) => setStudentQuery(e.target.value)}
              placeholder="Name or matric..."
              className="w-full min-h-[38px] pl-8 pr-3 py-1.5 text-sm border border-[#E5EAF0] dark:border-slate-700 rounded-lg bg-white dark:bg-[#09111E] text-[#172337] dark:text-slate-100"
            />
          </div>
        </div>

        <div className={departments && departments.length > 1 ? 'sm:col-span-2 lg:col-span-3 xl:col-span-6' : ''}>
          <div className="flex items-center justify-between text-xs font-medium text-[#697586] dark:text-slate-400 mb-1">
            <span>Attention Threshold ({riskThreshold}%)</span>
            {(departmentId || courseId || dateFrom || dateTo || statusFilter || studentQuery) && (
              <button
                type="button"
                onClick={() => {
                  setDepartmentId('');
                  setCourseId('');
                  setDateFrom('');
                  setDateTo('');
                  setStatusFilter('');
                  setStudentQuery('');
                }}
                className="text-[#4263EB] dark:text-blue-400 hover:underline"
              >
                Reset filters
              </button>
            )}
          </div>
          <input
            type="range"
            min={50}
            max={90}
            step={5}
            value={riskThreshold}
            onChange={(e) => setRiskThreshold(Number(e.target.value))}
            className="w-full mt-1 accent-[#4263EB]"
          />
        </div>
      </div>

      {loading || !data ? (
        <div className="bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl p-6">
          <SkeletonRows rows={6} />
        </div>
      ) : data.summary.sessionsCount === 0 ? (
        <EmptyState
          title="No completed sessions match these filters"
          description="Adjust the department, course, or date filters, or complete an attendance session to generate analytics."
        />
      ) : (
        <>
          {/* Summary KPIs */}
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
            <div className="bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl p-4">
              <p className="text-xs text-[#697586] dark:text-slate-400">Average Attendance</p>
              <p className="text-2xl font-bold font-mono-tabular text-[#172337] dark:text-slate-100 mt-1">
                {data.summary.averageRate}%
              </p>
            </div>
            <div className="bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl p-4">
              <p className="text-xs text-[#16845B] dark:text-emerald-400">Present Records</p>
              <p className="text-2xl font-bold font-mono-tabular text-[#16845B] dark:text-emerald-400 mt-1">
                {data.summary.presentCount.toLocaleString()}
              </p>
            </div>
            <div className="bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl p-4">
              <p className="text-xs text-[#D99020] dark:text-amber-400">Late Records</p>
              <p className="text-2xl font-bold font-mono-tabular text-[#D99020] dark:text-amber-400 mt-1">
                {data.summary.lateCount.toLocaleString()}
              </p>
            </div>
            <div className="bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl p-4">
              <p className="text-xs text-[#D84A4A] dark:text-rose-400">Absent Records</p>
              <p className="text-2xl font-bold font-mono-tabular text-[#D84A4A] dark:text-rose-400 mt-1">
                {data.summary.absentCount.toLocaleString()}
              </p>
            </div>
            <div className="bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl p-4">
              <p className="text-xs text-[#697586] dark:text-slate-400">Completed Sessions</p>
              <p className="text-2xl font-bold font-mono-tabular text-[#172337] dark:text-slate-100 mt-1">
                {data.summary.sessionsCount}
              </p>
            </div>
          </div>

          {/* Charts Grid: Trend Line + Distribution Doughnut */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl p-5">
              <h2 className="text-base font-semibold text-[#172337] dark:text-slate-100">
                Attendance Rate Trend Across Sessions
              </h2>
              <p className="text-xs text-[#697586] dark:text-slate-400 mb-4">
                Weighted attendance percentage across matching completed lectures
              </p>
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={data.sessionSeries}>
                    <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
                    <XAxis dataKey="label" tick={{ fontSize: 11, fill: tickColor }} />
                    <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: tickColor }} unit="%" />
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
            </div>

            <div className="bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl p-5">
              <h2 className="text-base font-semibold text-[#172337] dark:text-slate-100">
                Overall Attendance Distribution
              </h2>
              <p className="text-xs text-[#697586] dark:text-slate-400 mb-4">
                Share of Present, Late, and Absent records
              </p>
              {totalDistValue === 0 ? (
                <div className="h-72 flex items-center justify-center text-xs text-[#697586] dark:text-slate-400">
                  No records match the current filters.
                </div>
              ) : (
                <div className="h-72">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={data.distribution}
                        dataKey="value"
                        nameKey="name"
                        cx="50%"
                        cy="45%"
                        innerRadius={56}
                        outerRadius={86}
                        paddingAngle={2}
                      >
                        {data.distribution.map((entry) => (
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

          {/* Charts Grid: Attendance by Session + Student Histogram */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl p-5">
              <h2 className="text-base font-semibold text-[#172337] dark:text-slate-100">
                Attendance Breakdown by Session
              </h2>
              <p className="text-xs text-[#697586] dark:text-slate-400 mb-4">
                Headcount composition for each completed lecture
              </p>
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data.sessionSeries}>
                    <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
                    <XAxis dataKey="label" tick={{ fontSize: 11, fill: tickColor }} />
                    <YAxis tick={{ fontSize: 11, fill: tickColor }} />
                    <Tooltip contentStyle={tooltipStyle} />
                    <Legend wrapperStyle={{ fontSize: '12px', color: tickColor }} />
                    <Bar dataKey="present" name="Present" stackId="a" fill="#16845B" />
                    <Bar dataKey="late" name="Late" stackId="a" fill="#D99020" />
                    <Bar dataKey="absent" name="Absent" stackId="a" fill="#D84A4A" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl p-5">
              <h2 className="text-base font-semibold text-[#172337] dark:text-slate-100">
                Student Attendance Distribution
              </h2>
              <p className="text-xs text-[#697586] dark:text-slate-400 mb-4">
                Number of students grouped by attendance percentage band
              </p>
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data.studentHistogram}>
                    <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
                    <XAxis dataKey="range" tick={{ fontSize: 12, fill: tickColor }} />
                    <YAxis tick={{ fontSize: 11, fill: tickColor }} />
                    <Tooltip contentStyle={tooltipStyle} />
                    <Bar
                      dataKey="count"
                      name="Students"
                      fill={isDark ? '#4263EB' : '#14243A'}
                      radius={[6, 6, 0, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          {/* Course Comparison Chart */}
          {data.courseComparison.length > 1 && (
            <div className="bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl p-5">
              <h2 className="text-base font-semibold text-[#172337] dark:text-slate-100">Course Comparison</h2>
              <p className="text-xs text-[#697586] dark:text-slate-400 mb-4">
                Average attendance rate across authorised courses
              </p>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data.courseComparison} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
                    <XAxis type="number" domain={[0, 100]} unit="%" tick={{ fontSize: 11, fill: tickColor }} />
                    <YAxis type="category" dataKey="courseCode" width={88} tick={{ fontSize: 12, fill: axisDarkText }} />
                    <Tooltip contentStyle={tooltipStyle} />
                    <Bar dataKey="averageRate" name="Average Attendance (%)" fill="#0F9D91" radius={[0, 6, 6, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Students Below Threshold */}
          <div className="bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl overflow-hidden">
            <div className="p-5 border-b border-[#E5EAF0] dark:border-slate-800 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-base font-semibold text-[#172337] dark:text-slate-100">
                  Students Below {riskThreshold}% Attendance ({data.lowAttendanceStudents.length})
                </h2>
                <p className="text-xs text-[#697586] dark:text-slate-400 mt-0.5">
                  Advisory list for academic outreach. Analytics do not apply automatic penalties.
                </p>
              </div>
              {data.lowAttendanceSessions.length > 0 && (
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[#D99020] dark:text-amber-400">
                  <AlertTriangle className="w-4 h-4" />
                  <span>{data.lowAttendanceSessions.length} session(s) below {riskThreshold}%</span>
                </span>
              )}
            </div>

            {data.lowAttendanceStudents.length === 0 ? (
              <p className="p-6 text-sm text-[#697586] dark:text-slate-400">
                No students fall below {riskThreshold}% under the active filters.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-[#F6F8FB] dark:bg-[#09111E] border-b border-[#E5EAF0] dark:border-slate-800 text-xs text-[#697586] dark:text-slate-400">
                    <tr>
                      <th className="px-4 py-3 font-medium">Matric No.</th>
                      <th className="px-4 py-3 font-medium">Student Name</th>
                      <th className="px-4 py-3 font-medium text-right">Present</th>
                      <th className="px-4 py-3 font-medium text-right">Late</th>
                      <th className="px-4 py-3 font-medium text-right">Absent</th>
                      <th className="px-4 py-3 font-medium text-right">Attendance Rate</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#E5EAF0] dark:divide-slate-800">
                    {data.lowAttendanceStudents.map((st) => (
                      <tr key={st.studentId} className="hover:bg-[#F6F8FB]/70 dark:hover:bg-slate-800/50">
                        <td className="px-4 py-3 font-mono-tabular font-medium text-[#172337] dark:text-slate-100">
                          {st.matricNumber}
                        </td>
                        <td className="px-4 py-3 text-[#172337] dark:text-slate-200">{st.studentName}</td>
                        <td className="px-4 py-3 text-right font-mono-tabular text-[#16845B] dark:text-emerald-400">
                          {st.present}
                        </td>
                        <td className="px-4 py-3 text-right font-mono-tabular text-[#D99020] dark:text-amber-400">
                          {st.late}
                        </td>
                        <td className="px-4 py-3 text-right font-mono-tabular text-[#D84A4A] dark:text-rose-400">
                          {st.absent}
                        </td>
                        <td className="px-4 py-3 text-right font-mono-tabular font-semibold text-[#D84A4A] dark:text-rose-400">
                          {st.rate}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
