import type {
  AttendanceRecord,
  AttendanceSession,
  Course,
  CourseTimetableSlot,
  Enrolment,
  InstitutionSettings,
  LateCountPolicy,
} from '../types/lasu.ts';

export interface CourseAttendanceSummary {
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
  totalSessions: number; // alias of totalEligible for UI convenience
  effectiveScore: number;
  percentage: number | null;
  belowThreshold: boolean;
}

export function getLateWeight(policy: LateCountPolicy): number {
  if (policy === 'count_as_attended') return 1;
  if (policy === 'count_as_half') return 0.5;
  return 0;
}

export function getLatePolicyDescription(policy: LateCountPolicy): string {
  if (policy === 'count_as_attended') return 'Late arrivals count as full attendance (100%)';
  if (policy === 'count_as_half') return 'Late arrivals count as half attendance (50%)';
  return 'Late arrivals do not count toward attendance percentage (0%)';
}

export function calculateStudentCourseAttendance(params: {
  studentId: string;
  enrolment: Enrolment;
  course: Course;
  sessions: AttendanceSession[];
  records: AttendanceRecord[];
  settings: InstitutionSettings;
}): CourseAttendanceSummary {
  const { enrolment, course, sessions, records, settings } = params;
  const recordBySessionId = new Map<string, AttendanceRecord>();
  for (const r of records) {
    if (r.courseId === course.id) {
      recordBySessionId.set(r.sessionId, r);
    }
  }

  // Only completed sessions count; scheduled, live, and cancelled sessions are excluded.
  // Sessions that concluded before the student enrolled are excluded unless a record exists.
  const eligibleSessions = sessions.filter((s) => {
    if (s.courseId !== course.id || s.status !== 'completed') return false;
    if (recordBySessionId.has(s.id)) return true;
    const sessionTimestamp = s.closedAt || s.openedAt || s.createdAt;
    return sessionTimestamp >= enrolment.enrolledAt;
  });

  let presentCount = 0;
  let lateCount = 0;
  let missedCount = 0;
  let excusedCount = 0;

  for (const ses of eligibleSessions) {
    const rec = recordBySessionId.get(ses.id);
    if (!rec) {
      missedCount++;
      continue;
    }
    if (rec.status === 'present') presentCount++;
    else if (rec.status === 'late') lateCount++;
    else if (rec.status === 'excused') excusedCount++;
    else missedCount++;
  }

  const totalEligible = Math.max(0, eligibleSessions.length - excusedCount);
  const lateWeight = getLateWeight(settings.lateCountPolicy);
  const effectiveScore = presentCount + lateCount * lateWeight;
  const attendedCount = presentCount + (lateWeight > 0 ? lateCount : 0);

  const percentage =
    totalEligible > 0 ? Math.round((effectiveScore / totalEligible) * 1000) / 10 : null;

  return {
    courseId: course.id,
    courseCode: course.courseCode,
    courseTitle: course.courseTitle,
    lecturerName: course.lecturerName,
    semester: course.semester,
    timetableSlots: course.timetableSlots || [],
    attendedCount,
    presentCount,
    lateCount,
    missedCount,
    excusedCount,
    totalEligible,
    totalSessions: totalEligible,
    effectiveScore,
    percentage,
    belowThreshold: percentage !== null && percentage < settings.attendanceThreshold,
  };
}

export function calculateOverallStudentStanding(
  summaries: CourseAttendanceSummary[],
  settings: InstitutionSettings
): {
  overallPercentage: number | null;
  totalEligibleSessions: number;
  attendedTotal: number;
  presentTotal: number;
  lateTotal: number;
  missedTotal: number;
} {
  let totalEligibleSessions = 0;
  let effectiveTotal = 0;
  let presentTotal = 0;
  let lateTotal = 0;
  let missedTotal = 0;

  const lateWeight = getLateWeight(settings.lateCountPolicy);

  for (const item of summaries) {
    totalEligibleSessions += item.totalEligible;
    presentTotal += item.presentCount;
    lateTotal += item.lateCount;
    missedTotal += item.missedCount;
    effectiveTotal += item.presentCount + item.lateCount * lateWeight;
  }

  const overallPercentage =
    totalEligibleSessions > 0
      ? Math.round((effectiveTotal / totalEligibleSessions) * 1000) / 10
      : null;

  const attendedTotal = presentTotal + (lateWeight > 0 ? lateTotal : 0);

  return {
    overallPercentage,
    totalEligibleSessions,
    attendedTotal,
    presentTotal,
    lateTotal,
    missedTotal,
  };
}

export function calculateSessionEffectiveRate(
  session: AttendanceSession,
  policy: LateCountPolicy
): number {
  if (session.totalEnrolled <= 0) return 0;
  const lateWeight = getLateWeight(policy);
  const effective = session.presentCount + session.lateCount * lateWeight;
  return Math.round((effective / session.totalEnrolled) * 1000) / 10;
}
