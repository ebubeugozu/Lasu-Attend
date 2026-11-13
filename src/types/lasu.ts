export type UserRole = 'system_admin' | 'department_admin' | 'lecturer' | 'student';
export type UserStatus = 'active' | 'pending' | 'suspended';
export type StudentLevel = '100L' | '200L' | '300L' | '400L' | '500L';
export type StudentAccountStatus = 'pending_activation' | 'active' | 'suspended';
export type SessionStatus = 'scheduled' | 'live' | 'completed' | 'cancelled';
export type AttendanceStatus = 'present' | 'late' | 'absent' | 'excused';
export type CheckpointStatus = 'none' | 'completed' | 'missed';
export type LateCountPolicy = 'count_as_attended' | 'count_as_half' | 'count_as_absent';
export type ThemePreference = 'light' | 'dark' | 'system';

export type DayOfWeek =
  | 'Monday'
  | 'Tuesday'
  | 'Wednesday'
  | 'Thursday'
  | 'Friday'
  | 'Saturday';

export interface CourseTimetableSlot {
  dayOfWeek: DayOfWeek;
  startTime: string; // HH:mm
  endTime: string; // HH:mm
  venue: string;
}

export interface Institution {
  id: string;
  name: string;
  code: string;
  status: 'active' | 'inactive';
  createdAt: string;
}

export interface InstitutionSettings {
  id: string;
  lateCountPolicy: LateCountPolicy;
  attendanceThreshold: number;
  milestonePercentages: number[];
  updatedAt: string;
  updatedByUid?: string;
}

export interface Department {
  id: string;
  institutionId: string;
  facultyName: string;
  name: string;
  code: string;
  status: 'active' | 'inactive';
  createdAt: string;
}

export interface PlatformUser {
  uid: string;
  email: string;
  displayName: string;
  role: UserRole;
  departmentId: string;
  departmentName?: string;
  facultyName?: string;
  status: UserStatus;
  studentId?: string;
  matricNumber?: string;
  isDemo: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface StudentRecord {
  id: string;
  matricNumber: string;
  fullName: string;
  email?: string;
  departmentId: string;
  departmentName: string;
  facultyName: string;
  level: StudentLevel;
  accountStatus: StudentAccountStatus;
  activationCode?: string; // Only visible to authorized admins when pending_activation
  claimedUid?: string;
  isDemo: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Course {
  id: string;
  institutionId: string;
  departmentId: string;
  departmentName: string;
  courseCode: string;
  courseTitle: string;
  level: StudentLevel;
  semester: string;
  lecturerUid: string;
  lecturerName: string;
  status: 'active' | 'archived';
  enrolledCount: number;
  timetableSlots?: CourseTimetableSlot[];
  isDemo: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Enrolment {
  id: string;
  courseId: string;
  studentId: string;
  matricNumber: string;
  studentUid?: string;
  lecturerUid: string;
  status: 'enrolled' | 'dropped';
  enrolledAt: string;
}

export interface AttendanceSession {
  id: string;
  courseId: string;
  courseCode: string;
  courseTitle: string;
  departmentId: string;
  lecturerUid: string;
  lecturerName: string;
  lectureTitle?: string;
  venue?: string;
  sessionDate: string;
  startTime: string;
  openedAt?: string;
  closedAt?: string;
  lateThresholdMinutes: number;
  rotationIntervalSeconds: number;
  gracePeriodSeconds: number;
  status: SessionStatus;
  checkpointActive: boolean;
  checkpointStartedAt?: string;
  totalEnrolled: number;
  presentCount: number;
  lateCount: number;
  absentCount: number;
  verifiedCount: number;
  failedAttemptCount: number;
  isDemo: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AttendanceRecord {
  id: string;
  sessionId: string;
  courseId: string;
  lecturerUid: string;
  studentId: string;
  studentUid?: string;
  matricNumber: string;
  studentName: string;
  status: AttendanceStatus;
  checkInTime?: string;
  checkpointStatus: CheckpointStatus;
  checkpointTime?: string;
  correctedByUid?: string;
  correctedByName?: string;
  correctionReason?: string;
  correctedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CheckpointEvent {
  id: string;
  sessionId: string;
  courseId: string;
  lecturerUid: string;
  studentId: string;
  studentUid?: string;
  matricNumber: string;
  verifiedAt: string;
}

export interface FailedAttempt {
  id: string;
  sessionId: string;
  actorUid?: string;
  matricNumber?: string;
  reason: string;
  code: string;
  attemptedAt: string;
}

export interface AuditLog {
  id: string;
  actorUid: string;
  actorName: string;
  actorRole: UserRole | 'system';
  action: string;
  targetType: string;
  targetId: string;
  details: string;
  departmentId?: string;
  createdAt: string;
}

export type NotificationCategory =
  | 'upcoming_class'
  | 'milestone'
  | 'attendance_update'
  | 'info';

export interface AppNotification {
  id: string;
  recipientUid: string;
  title: string;
  message: string;
  type: 'info' | 'warning' | 'success';
  category?: NotificationCategory;
  milestoneKey?: string;
  courseId?: string;
  read: boolean;
  createdAt: string;
}

export interface LiveQRPayload {
  sessionId: string;
  courseCode: string;
  courseTitle: string;
  lectureTitle?: string;
  venue?: string;
  lecturerName: string;
  status: SessionStatus;
  mode: 'checkin' | 'verify';
  token: string;
  shortCode: string;
  issuedAt: number;
  expiresAt: number;
  graceSeconds: number;
  rotationIntervalSeconds: number;
  serverTime: number;
  checkedInCount: number;
  verifiedCount: number;
  totalEnrolled: number;
}
