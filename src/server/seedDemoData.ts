import type {
  AppNotification,
  AttendanceRecord,
  AttendanceSession,
  AuditLog,
  Course,
  DayOfWeek,
  Department,
  Enrolment,
  Institution,
  InstitutionSettings,
  PlatformUser,
  StudentLevel,
  StudentRecord,
} from '../types/lasu.ts';

export interface StoreState {
  institutions: Institution[];
  institutionSettings: InstitutionSettings;
  departments: Department[];
  users: PlatformUser[];
  students: StudentRecord[];
  courses: Course[];
  enrolments: Enrolment[];
  sessions: AttendanceSession[];
  records: AttendanceRecord[];
  auditLogs: AuditLog[];
  notifications: AppNotification[];
}

const FIRST_NAMES = [
  'Toluwani', 'Chinedu', 'Aisha', 'Oluwaseun', 'Ibrahim', 'Chioma', 'Babajide', 'Fatima',
  'Damilola', 'Emeka', 'Zainab', 'Ayodeji', 'Ngozi', 'Sadiq', 'Temitope', 'Uchenna',
  'Khadijah', 'Femi', 'Amaka', 'Yusuf', 'Moyosore', 'Kelechi', 'Halima', 'Gbolahan',
  'Chidinma', 'Abdullahi', 'Bukola', 'Ifeanyi', 'Amina', 'Rotimi', 'Nneka', 'Mustapha',
  'Adedayo', 'Chukwudi', 'Mariam', 'Kayode', 'Onyeka', 'Bashir', 'Eniola', 'Somto',
];

const LAST_NAMES = [
  'Adebayo', 'Okafor', 'Bello', 'Ogunleye', 'Abubakar', 'Eze', 'Balogun', 'Musa',
  'Adeyemi', 'Nwosu', 'Suleiman', 'Oladipo', 'Okonkwo', 'Garba', 'Fashola', 'Ibe',
  'Lawal', 'Umeh', 'Danladi', 'Akintola', 'Onwuchekwa', 'Usman', 'Soyinka', 'Nwachukwu',
  'Bakare', 'Chukwu', 'Idris', 'Adekunle', 'Onyekachi', 'Aliyu', 'Sanwo', 'Okoro',
];

function deterministicName(index: number): string {
  const first = FIRST_NAMES[index % FIRST_NAMES.length];
  const last = LAST_NAMES[Math.floor(index / FIRST_NAMES.length) % LAST_NAMES.length];
  const middleInitial = String.fromCharCode(65 + (index % 26));
  return `${first} ${middleInitial}. ${last}`;
}

export function createDefaultInstitutionSettings(): InstitutionSettings {
  return {
    id: 'default',
    lateCountPolicy: 'count_as_attended',
    attendanceThreshold: 75,
    milestonePercentages: [50, 75, 90, 100],
    updatedAt: new Date().toISOString(),
  };
}

export function createDemoSeedState(): StoreState {
  const now = new Date().toISOString();
  const thirtyDaysAgoIso = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const institutionId = 'inst_lasu';

  const institutions: Institution[] = [
    {
      id: institutionId,
      name: 'Lagos State University',
      code: 'LASU',
      status: 'active',
      createdAt: now,
    },
  ];

  const institutionSettings = createDefaultInstitutionSettings();

  const departments: Department[] = [
    {
      id: 'dept_mec',
      institutionId,
      facultyName: 'Faculty of Engineering',
      name: 'Mechanical Engineering',
      code: 'MEC',
      status: 'active',
      createdAt: now,
    },
    {
      id: 'dept_ece',
      institutionId,
      facultyName: 'Faculty of Engineering',
      name: 'Electronic & Computer Engineering',
      code: 'ECE',
      status: 'active',
      createdAt: now,
    },
    {
      id: 'dept_cpe',
      institutionId,
      facultyName: 'Faculty of Engineering',
      name: 'Chemical & Polymer Engineering',
      code: 'CPE',
      status: 'active',
      createdAt: now,
    },
    {
      id: 'dept_ase',
      institutionId,
      facultyName: 'Faculty of Engineering',
      name: 'Aerospace Engineering',
      code: 'ASE',
      status: 'active',
      createdAt: now,
    },
  ];

  const users: PlatformUser[] = [
    {
      uid: 'demo_sysadmin_1',
      email: 'demo.sysadmin@lasu.edu.ng',
      displayName: 'Prof. Folashade Balogun',
      role: 'system_admin',
      departmentId: 'dept_mec',
      departmentName: 'Faculty Administration',
      facultyName: 'Faculty of Engineering',
      status: 'active',
      isDemo: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      uid: 'demo_deptadmin_ece',
      email: 'demo.eceadmin@lasu.edu.ng',
      displayName: 'Dr. Chukwuma Okafor',
      role: 'department_admin',
      departmentId: 'dept_ece',
      departmentName: 'Electronic & Computer Engineering',
      facultyName: 'Faculty of Engineering',
      status: 'active',
      isDemo: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      uid: 'demo_lecturer_1',
      email: 'demo.ogunleye@lasu.edu.ng',
      displayName: 'Dr. Adeyemi Ogunleye',
      role: 'lecturer',
      departmentId: 'dept_mec',
      departmentName: 'Mechanical Engineering',
      facultyName: 'Faculty of Engineering',
      status: 'active',
      isDemo: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      uid: 'demo_lecturer_2',
      email: 'demo.bello@lasu.edu.ng',
      displayName: 'Engr. Amina Bello',
      role: 'lecturer',
      departmentId: 'dept_ece',
      departmentName: 'Electronic & Computer Engineering',
      facultyName: 'Faculty of Engineering',
      status: 'active',
      isDemo: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      uid: 'demo_student_1',
      email: 'demo.student@lasu.edu.ng',
      displayName: 'Toluwani A. Adebayo',
      role: 'student',
      departmentId: 'dept_mec',
      departmentName: 'Mechanical Engineering',
      facultyName: 'Faculty of Engineering',
      status: 'active',
      studentId: 'std_230591001',
      matricNumber: '230591001',
      isDemo: true,
      createdAt: now,
      updatedAt: now,
    },
  ];

  // Generate 800 realistic synthetic 200-level Engineering students across 4 departments
  const students: StudentRecord[] = [];
  for (let i = 0; i < 800; i++) {
    const dept = departments[i % departments.length];
    const matric = String(230591001 + i);
    const id = `std_${matric}`;
    const isDemoPrimaryStudent = i === 0;
    const isPendingSample = i >= 790;
    students.push({
      id,
      matricNumber: matric,
      fullName: isDemoPrimaryStudent ? 'Toluwani A. Adebayo' : deterministicName(i),
      email: isDemoPrimaryStudent ? 'demo.student@lasu.edu.ng' : undefined,
      departmentId: dept.id,
      departmentName: dept.name,
      facultyName: dept.facultyName,
      level: '200L' as StudentLevel,
      accountStatus: isPendingSample ? 'pending_activation' : 'active',
      activationCode: isPendingSample ? `LASU-ACT-${2026 + i}` : undefined,
      claimedUid: isDemoPrimaryStudent ? 'demo_student_1' : `demo_student_uid_${matric}`,
      isDemo: true,
      createdAt: thirtyDaysAgoIso,
      updatedAt: now,
    });
  }

  // Dedicated unactivated student for interactive activation testing
  students.push({
    id: 'std_230591999',
    matricNumber: '230591999',
    fullName: 'Kolawole M. Adesina',
    departmentId: 'dept_ece',
    departmentName: 'Electronic & Computer Engineering',
    facultyName: 'Faculty of Engineering',
    level: '200L',
    accountStatus: 'pending_activation',
    activationCode: 'LASU-2026-ACT',
    isDemo: true,
    createdAt: thirtyDaysAgoIso,
    updatedAt: now,
  });

  // Determine today/tomorrow weekday names in Lagos for realistic configured demo timetable slots
  const weekdayNames: DayOfWeek[] = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const lagosWeekday = new Intl.DateTimeFormat('en-US', { timeZone: 'Africa/Lagos', weekday: 'long' }).format(
    new Date(Date.now() + 86_400_000)
  ) as DayOfWeek;
  const tomorrowSlotDay: DayOfWeek = weekdayNames.includes(lagosWeekday) ? lagosWeekday : 'Monday';

  const courses: Course[] = [
    {
      id: 'crs_mec201',
      institutionId,
      departmentId: 'dept_mec',
      departmentName: 'Mechanical Engineering',
      courseCode: 'MEC 201',
      courseTitle: 'Engineering Mechanics I (Statics & Dynamics)',
      level: '200L',
      semester: '2025/2026 Rain Semester',
      lecturerUid: 'demo_lecturer_1',
      lecturerName: 'Dr. Adeyemi Ogunleye',
      status: 'active',
      enrolledCount: 800,
      timetableSlots: [
        { dayOfWeek: tomorrowSlotDay, startTime: '09:00', endTime: '11:00', venue: 'ETF Lecture Theatre A' },
        { dayOfWeek: 'Thursday', startTime: '14:00', endTime: '16:00', venue: 'Engineering Main Hall' },
      ],
      isDemo: true,
      createdAt: thirtyDaysAgoIso,
      updatedAt: now,
    },
    {
      id: 'crs_eng202',
      institutionId,
      departmentId: 'dept_mec',
      departmentName: 'Mechanical Engineering',
      courseCode: 'ENG 202',
      courseTitle: 'Engineering Mathematics III',
      level: '200L',
      semester: '2025/2026 Rain Semester',
      lecturerUid: 'demo_lecturer_1',
      lecturerName: 'Dr. Adeyemi Ogunleye',
      status: 'active',
      enrolledCount: 400,
      timetableSlots: [
        { dayOfWeek: 'Tuesday', startTime: '11:00', endTime: '13:00', venue: '300-Seater Auditorium' },
      ],
      isDemo: true,
      createdAt: thirtyDaysAgoIso,
      updatedAt: now,
    },
    {
      id: 'crs_cpe205',
      institutionId,
      departmentId: 'dept_cpe',
      departmentName: 'Chemical & Polymer Engineering',
      courseCode: 'CPE 205',
      courseTitle: 'Engineering Thermodynamics I',
      level: '200L',
      semester: '2025/2026 Rain Semester',
      lecturerUid: 'demo_lecturer_1',
      lecturerName: 'Dr. Adeyemi Ogunleye',
      status: 'active',
      enrolledCount: 200,
      timetableSlots: [
        { dayOfWeek: 'Wednesday', startTime: '14:00', endTime: '16:00', venue: 'CPE Lecture Room 2' },
      ],
      isDemo: true,
      createdAt: thirtyDaysAgoIso,
      updatedAt: now,
    },
    {
      id: 'crs_ece203',
      institutionId,
      departmentId: 'dept_ece',
      departmentName: 'Electronic & Computer Engineering',
      courseCode: 'ECE 203',
      courseTitle: 'Digital Logic & Microprocessor Systems',
      level: '200L',
      semester: '2025/2026 Rain Semester',
      lecturerUid: 'demo_lecturer_2',
      lecturerName: 'Engr. Amina Bello',
      status: 'active',
      enrolledCount: 240,
      timetableSlots: [
        { dayOfWeek: 'Friday', startTime: '10:00', endTime: '12:00', venue: 'ECE Digital Lab Theatre' },
      ],
      isDemo: true,
      createdAt: thirtyDaysAgoIso,
      updatedAt: now,
    },
  ];

  const enrolments: Enrolment[] = [];
  for (let i = 0; i < 800; i++) {
    const s = students[i];
    enrolments.push({
      id: `enr_mec201_${s.id}`,
      courseId: 'crs_mec201',
      studentId: s.id,
      matricNumber: s.matricNumber,
      studentUid: s.claimedUid,
      lecturerUid: 'demo_lecturer_1',
      status: 'enrolled',
      enrolledAt: thirtyDaysAgoIso,
    });
  }
  for (let i = 0; i < 400; i++) {
    const s = students[i];
    enrolments.push({
      id: `enr_eng202_${s.id}`,
      courseId: 'crs_eng202',
      studentId: s.id,
      matricNumber: s.matricNumber,
      studentUid: s.claimedUid,
      lecturerUid: 'demo_lecturer_1',
      status: 'enrolled',
      enrolledAt: thirtyDaysAgoIso,
    });
  }
  for (let i = 0; i < 200; i++) {
    const s = students[i];
    enrolments.push({
      id: `enr_cpe205_${s.id}`,
      courseId: 'crs_cpe205',
      studentId: s.id,
      matricNumber: s.matricNumber,
      studentUid: s.claimedUid,
      lecturerUid: 'demo_lecturer_1',
      status: 'enrolled',
      enrolledAt: thirtyDaysAgoIso,
    });
  }
  for (let i = 0; i < 240; i++) {
    const s = students[i];
    enrolments.push({
      id: `enr_ece203_${s.id}`,
      courseId: 'crs_ece203',
      studentId: s.id,
      matricNumber: s.matricNumber,
      studentUid: s.claimedUid,
      lecturerUid: 'demo_lecturer_2',
      status: 'enrolled',
      enrolledAt: thirtyDaysAgoIso,
    });
  }

  const sessions: AttendanceSession[] = [];
  const records: AttendanceRecord[] = [];

  const sessionTemplates: Array<{
    id: string;
    course: Course;
    daysAgo: number;
    lectureTitle: string;
    venue: string;
    startTime: string;
    presentRate: number;
    lateRate: number;
    hadCheckpoint: boolean;
  }> = [
    {
      id: 'ses_mec201_w1',
      course: courses[0],
      daysAgo: 21,
      lectureTitle: 'Force Systems & Equilibrium in 3D',
      venue: 'ETF Lecture Theatre A',
      startTime: '09:00',
      presentRate: 0.78,
      lateRate: 0.08,
      hadCheckpoint: false,
    },
    {
      id: 'ses_mec201_w2',
      course: courses[0],
      daysAgo: 14,
      lectureTitle: 'Trusses, Frames & Structural Analysis',
      venue: 'ETF Lecture Theatre A',
      startTime: '09:00',
      presentRate: 0.81,
      lateRate: 0.07,
      hadCheckpoint: true,
    },
    {
      id: 'ses_mec201_w3',
      course: courses[0],
      daysAgo: 7,
      lectureTitle: 'Kinematics of Rigid Bodies',
      venue: 'Engineering Main Hall',
      startTime: '09:00',
      presentRate: 0.74,
      lateRate: 0.09,
      hadCheckpoint: true,
    },
    {
      id: 'ses_eng202_w2',
      course: courses[1],
      daysAgo: 11,
      lectureTitle: 'Laplace Transforms & ODEs',
      venue: '300-Seater Auditorium',
      startTime: '11:00',
      presentRate: 0.80,
      lateRate: 0.06,
      hadCheckpoint: false,
    },
    {
      id: 'ses_eng202_w3',
      course: courses[1],
      daysAgo: 4,
      lectureTitle: 'Fourier Series & Partial Differential Equations',
      venue: '300-Seater Auditorium',
      startTime: '11:00',
      presentRate: 0.83,
      lateRate: 0.05,
      hadCheckpoint: false,
    },
    {
      id: 'ses_cpe205_w3',
      course: courses[2],
      daysAgo: 3,
      lectureTitle: 'First Law of Thermodynamics for Open Systems',
      venue: 'CPE Lecture Room 2',
      startTime: '14:00',
      presentRate: 0.72,
      lateRate: 0.10,
      hadCheckpoint: false,
    },
    {
      id: 'ses_ece203_w3',
      course: courses[3],
      daysAgo: 2,
      lectureTitle: 'Sequential Circuits & State Machines',
      venue: 'ECE Digital Lab Theatre',
      startTime: '10:00',
      presentRate: 0.86,
      lateRate: 0.05,
      hadCheckpoint: true,
    },
  ];

  for (let sIdx = 0; sIdx < sessionTemplates.length; sIdx++) {
    const tpl = sessionTemplates[sIdx];
    const courseEnrolments = enrolments.filter((e) => e.courseId === tpl.course.id);
    const sessionDateObj = new Date(Date.now() - tpl.daysAgo * 86_400_000);
    const sessionDate = sessionDateObj.toISOString().slice(0, 10);
    const openedAt = `${sessionDate}T${tpl.startTime}:00.000Z`;
    const closedAt = `${sessionDate}T11:00:00.000Z`;

    let presentCount = 0;
    let lateCount = 0;
    let absentCount = 0;
    let verifiedCount = 0;

    for (let idx = 0; idx < courseEnrolments.length; idx++) {
      const student = students[idx];
      const isLowRiskProfile = idx > 0 && idx % 17 === 0;
      const hashVal = ((idx * 37 + sIdx * 19) % 100) / 100;

      let status: 'present' | 'late' | 'absent' = 'present';
      if (isLowRiskProfile) {
        status = hashVal < 0.35 ? 'present' : hashVal < 0.48 ? 'late' : 'absent';
      } else if (idx === 0) {
        status = sIdx === 2 ? 'absent' : sIdx === 4 ? 'late' : 'present';
      } else {
        if (hashVal < tpl.presentRate) status = 'present';
        else if (hashVal < tpl.presentRate + tpl.lateRate) status = 'late';
        else status = 'absent';
      }

      if (status === 'present') presentCount++;
      else if (status === 'late') lateCount++;
      else absentCount++;

      const offsetMinutes = status === 'present' ? (idx % 12) + 1 : status === 'late' ? 18 + (idx % 15) : 0;
      const checkInIso =
        status === 'absent'
          ? undefined
          : new Date(new Date(openedAt).getTime() + offsetMinutes * 60_000).toISOString();

      let checkpointStatus: 'none' | 'completed' | 'missed' = 'none';
      let checkpointTime: string | undefined;
      if (tpl.hadCheckpoint) {
        if (status !== 'absent' && hashVal < 0.92) {
          checkpointStatus = 'completed';
          checkpointTime = new Date(new Date(openedAt).getTime() + 45 * 60_000).toISOString();
          verifiedCount++;
        } else {
          checkpointStatus = 'missed';
        }
      }

      records.push({
        id: `rec_${tpl.id}_${student.id}`,
        sessionId: tpl.id,
        courseId: tpl.course.id,
        lecturerUid: tpl.course.lecturerUid,
        studentId: student.id,
        studentUid: student.claimedUid,
        matricNumber: student.matricNumber,
        studentName: student.fullName,
        status,
        checkInTime: checkInIso,
        checkpointStatus,
        checkpointTime,
        createdAt: closedAt,
        updatedAt: closedAt,
      });
    }

    sessions.push({
      id: tpl.id,
      courseId: tpl.course.id,
      courseCode: tpl.course.courseCode,
      courseTitle: tpl.course.courseTitle,
      departmentId: tpl.course.departmentId,
      lecturerUid: tpl.course.lecturerUid,
      lecturerName: tpl.course.lecturerName,
      lectureTitle: tpl.lectureTitle,
      venue: tpl.venue,
      sessionDate,
      startTime: tpl.startTime,
      openedAt,
      closedAt,
      lateThresholdMinutes: 15,
      rotationIntervalSeconds: 90,
      gracePeriodSeconds: 15,
      status: 'completed',
      checkpointActive: false,
      totalEnrolled: courseEnrolments.length,
      presentCount,
      lateCount,
      absentCount,
      verifiedCount,
      failedAttemptCount: sIdx === 1 ? 3 : 1,
      isDemo: true,
      createdAt: openedAt,
      updatedAt: closedAt,
    });
  }

  const auditLogs: AuditLog[] = [
    {
      id: 'log_seed_1',
      actorUid: 'demo_sysadmin_1',
      actorName: 'Prof. Folashade Balogun',
      actorRole: 'system_admin',
      action: 'STUDENT_REGISTER_IMPORTED',
      targetType: 'student_register',
      targetId: 'batch_200l_eng',
      details: 'Imported 800 demo 200-level Engineering student records across 4 departments.',
      createdAt: now,
    },
    {
      id: 'log_seed_2',
      actorUid: 'demo_lecturer_1',
      actorName: 'Dr. Adeyemi Ogunleye',
      actorRole: 'lecturer',
      action: 'SESSION_CLOSED',
      targetType: 'attendance_session',
      targetId: 'ses_mec201_w3',
      details: 'Closed MEC 201 attendance session (Kinematics of Rigid Bodies) and computed absent roster.',
      departmentId: 'dept_mec',
      createdAt: now,
    },
  ];

  const notifications: AppNotification[] = [
    {
      id: 'notif_demo_1',
      recipientUid: 'demo_lecturer_1',
      title: 'MEC 201 session summary ready',
      message: 'Week 3 attendance for Kinematics of Rigid Bodies closed with 83% attendance across 800 students.',
      type: 'info',
      category: 'info',
      courseId: 'crs_mec201',
      read: false,
      createdAt: now,
    },
  ];

  return {
    institutions,
    institutionSettings,
    departments,
    users,
    students,
    courses,
    enrolments,
    sessions,
    records,
    auditLogs,
    notifications,
  };
}
