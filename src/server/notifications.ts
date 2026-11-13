import type {
  AppNotification,
  AttendanceRecord,
  AttendanceSession,
  Course,
  Enrolment,
  InstitutionSettings,
  StudentRecord,
} from '../types/lasu.ts';
import { calculateStudentCourseAttendance } from './attendanceMath.ts';

const LAGOS_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

function getLagosDateInfo(offsetDays = 0): { dateStr: string; dayOfWeek: string; currentMinutes: number } {
  const target = new Date(Date.now() + offsetDays * 86_400_000);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Lagos',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(target);
  const lookup = (type: string) => parts.find((p) => p.type === type)?.value || '';
  const dateStr = `${lookup('year')}-${lookup('month')}-${lookup('day')}`;
  const dayOfWeek = lookup('weekday') || LAGOS_DAYS[target.getDay()];
  const hour = Number(lookup('hour') || 0);
  const minute = Number(lookup('minute') || 0);
  return { dateStr, dayOfWeek, currentMinutes: hour * 60 + minute };
}

function parseHHMM(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((n) => Number(n));
  if (Number.isNaN(h) || Number.isNaN(m)) return 0;
  return h * 60 + m;
}

/**
 * Generates deduplicated upcoming class notifications strictly from configured
 * course timetable slots and scheduled/live attendance sessions. Never invents schedules.
 */
export function buildUpcomingClassNotifications(params: {
  student: StudentRecord;
  courses: Course[];
  sessions: AttendanceSession[];
}): AppNotification[] {
  const { student, courses, sessions } = params;
  if (!student.claimedUid) return [];

  const today = getLagosDateInfo(0);
  const tomorrow = getLagosDateInfo(1);
  const nowIso = new Date().toISOString();
  const generated: AppNotification[] = [];

  // 1. Scheduled or live sessions created by lecturers
  for (const ses of sessions) {
    if (ses.status !== 'scheduled' && ses.status !== 'live') continue;
    if (ses.sessionDate < today.dateStr || ses.sessionDate > tomorrow.dateStr) continue;

    const id = `notif_up_ses_${student.id}_${ses.id}`;
    const whenLabel = ses.sessionDate === today.dateStr ? 'Today' : 'Tomorrow';
    const venuePart = ses.venue ? ` at ${ses.venue}` : '';
    generated.push({
      id,
      recipientUid: student.claimedUid,
      title:
        ses.status === 'live'
          ? `Live now: ${ses.courseCode}`
          : `Upcoming class: ${ses.courseCode}`,
      message: `${ses.courseTitle} (${whenLabel} at ${ses.startTime}${venuePart}).`,
      type: ses.status === 'live' ? 'success' : 'info',
      category: 'upcoming_class',
      milestoneKey: `session_${ses.id}`,
      courseId: ses.courseId,
      read: false,
      createdAt: nowIso,
    });
  }

  // 2. Configured course timetable slots matching today (still upcoming) or tomorrow
  for (const course of courses) {
    if (!course.timetableSlots || course.timetableSlots.length === 0) continue;
    for (const slot of course.timetableSlots) {
      let targetDate: string | null = null;
      let whenLabel = '';

      if (slot.dayOfWeek === today.dayOfWeek) {
        const slotEnd = parseHHMM(slot.endTime || slot.startTime);
        if (slotEnd >= today.currentMinutes - 15) {
          targetDate = today.dateStr;
          whenLabel = 'Today';
        }
      } else if (slot.dayOfWeek === tomorrow.dayOfWeek) {
        targetDate = tomorrow.dateStr;
        whenLabel = 'Tomorrow';
      }

      if (!targetDate) continue;

      const timeSlug = slot.startTime.replace(/[^0-9]/g, '');
      const id = `notif_up_slot_${student.id}_${course.id}_${targetDate}_${timeSlug}`;
      generated.push({
        id,
        recipientUid: student.claimedUid,
        title: `Upcoming class: ${course.courseCode}`,
        message: `${course.courseTitle} — ${whenLabel} (${slot.dayOfWeek}), ${slot.startTime}–${slot.endTime} at ${slot.venue}.`,
        type: 'info',
        category: 'upcoming_class',
        milestoneKey: `slot_${targetDate}_${timeSlug}`,
        courseId: course.id,
        read: false,
        createdAt: nowIso,
      });
    }
  }

  return generated;
}

/**
 * Evaluates deduplicated milestone and low-attendance alerts for a student in a course.
 */
export function buildCourseMilestoneNotifications(params: {
  student: StudentRecord;
  enrolment: Enrolment;
  course: Course;
  sessions: AttendanceSession[];
  records: AttendanceRecord[];
  settings: InstitutionSettings;
}): AppNotification[] {
  const { student, enrolment, course, sessions, records, settings } = params;
  if (!student.claimedUid) return [];

  const summary = calculateStudentCourseAttendance({
    studentId: student.id,
    enrolment,
    course,
    sessions,
    records,
    settings,
  });

  if (summary.percentage === null || summary.totalEligible === 0) {
    return [];
  }

  const pct = summary.percentage;
  const nowIso = new Date().toISOString();
  const notifications: AppNotification[] = [];

  // Positive milestones (only notify highest achieved milestone bucket or configured milestones)
  const sortedMilestones = [...(settings.milestonePercentages || [50, 75, 90, 100])].sort((a, b) => b - a);
  for (const milestone of sortedMilestones) {
    if (pct >= milestone) {
      const milestoneKey = `pct_${milestone}`;
      notifications.push({
        id: `notif_ms_${student.id}_${course.id}_${milestoneKey}`,
        recipientUid: student.claimedUid,
        title:
          milestone === 100
            ? `Perfect attendance in ${course.courseCode}`
            : `${milestone}% attendance milestone reached in ${course.courseCode}`,
        message: `You have reached ${pct}% attendance across ${summary.totalEligible} completed session(s) in ${course.courseTitle}.`,
        type: 'success',
        category: 'milestone',
        milestoneKey,
        courseId: course.id,
        read: false,
        createdAt: nowIso,
      });
      break;
    }
  }

  // Below threshold advisory once at least 2 completed sessions exist
  if (summary.totalEligible >= 2 && pct < settings.attendanceThreshold) {
    const milestoneKey = `below_${settings.attendanceThreshold}_s${summary.totalEligible}`;
    notifications.push({
      id: `notif_ms_${student.id}_${course.id}_${milestoneKey}`,
      recipientUid: student.claimedUid,
      title: `Attendance below ${settings.attendanceThreshold}% in ${course.courseCode}`,
      message: `Your attendance in ${course.courseCode} is ${pct}% (${summary.missedCount} missed out of ${summary.totalEligible} completed sessions).`,
      type: 'warning',
      category: 'milestone',
      milestoneKey,
      courseId: course.id,
      read: false,
      createdAt: nowIso,
    });
  }

  return notifications;
}
