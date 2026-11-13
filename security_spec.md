# LASU Attend — Firestore Security Specification (Phase 0 TDD)

## 1. Data Invariants
1. **No Direct Student Attendance Writes**: Students cannot create, update, or delete documents in `/attendanceRecords` or `/checkpointEvents`. Only system administrators, the assigned course lecturer, or the privileged server-side backend may write attendance records.
2. **PII Isolation**: `/users/{uid}` and `/students/{studentId}` contain PII (email, matriculation number, full name). No blanket `isSignedIn()` reads are permitted. Students may only read their own profile, their own student record (`claimedUid == request.auth.uid`), and their own attendance records (`studentUid == request.auth.uid`).
3. **Role Privilege Escalation Lock**: A user creating their own `/users/{uid}` profile can only self-register as `student` with `status: 'pending'` (unless bootstrapped admin). Users cannot update their own `role` or `status`.
4. **Department Scoping**: Department administrators can only manage students, courses, and sessions belonging to their assigned `departmentId`.
5. **Terminal State Locking**: Once an `/attendanceSessions/{sessionId}` reaches `'completed'` or `'cancelled'`, non-admin updates are locked.
6. **Immutable Audit Logs**: `/auditLogs/{logId}` is strictly append-only (`update: false`, `delete: false`), and students have zero read or write access.
7. **Server Timestamps & Bounded Strings**: All `createdAt` and `updatedAt` timestamps must equal `request.time`. All document IDs match `^[a-zA-Z0-9_\-]+$` (<= 128 chars), and all string fields have explicit `.size()` bounds.

## 2. The "Dirty Dozen" Adversarial Test Payloads
1. **Student Self-Marking Attendance (`CREATE /attendanceRecords/rec_1`)**: Authenticated student sends `{ sessionId: 's1', studentUid: auth.uid, status: 'present' }` -> MUST return `PERMISSION_DENIED`.
2. **Student Forging Another Student's Check-In (`CREATE /attendanceRecords/rec_2`)**: Student sends `studentUid: 'victim_uid'` -> MUST return `PERMISSION_DENIED`.
3. **Privilege Escalation on Registration (`CREATE /users/{uid}`)**: New user sends `{ uid: auth.uid, role: 'system_admin', status: 'active' }` -> MUST return `PERMISSION_DENIED`.
4. **Role Self-Promotion on Update (`UPDATE /users/{uid}`)**: Existing student updates `{ role: 'lecturer' }` -> MUST return `PERMISSION_DENIED`.
5. **Cross-Department Admin Tampering (`UPDATE /courses/cpe201`)**: Department admin for `dept_mec` tries to update a course in `dept_cpe` -> MUST return `PERMISSION_DENIED`.
6. **Unverified Email Spoofing (`READ/WRITE`)**: User with `email: 'ebubeugozu79@gmail.com'` and `email_verified: false` attempts admin operation -> MUST return `PERMISSION_DENIED`.
7. **Shadow Field Injection (`UPDATE /attendanceSessions/s1`)**: Lecturer updates session with an unexpected ghost key `{ isApprovedByDean: true }` -> MUST return `PERMISSION_DENIED`.
8. **ID Poisoning / Denial of Wallet (`CREATE /courses/<2000-char-id>`)**: Attacker sends oversized document ID or 1MB `courseTitle` -> MUST return `PERMISSION_DENIED`.
9. **Terminal State Bypass (`UPDATE /attendanceSessions/s1`)**: Lecturer attempts to reopen a `'completed'` session back to `'live'` -> MUST return `PERMISSION_DENIED`.
10. **Student Reading Peer Attendance (`GET /attendanceRecords/other_rec`)**: Student A reads Student B's attendance record -> MUST return `PERMISSION_DENIED`.
11. **Student Reading Audit Logs (`LIST /auditLogs`)**: Student queries `/auditLogs` -> MUST return `PERMISSION_DENIED`.
12. **Audit Log Tampering (`UPDATE/DELETE /auditLogs/log_1`)**: Any user (even admin) attempts to modify or delete an existing audit log -> MUST return `PERMISSION_DENIED`.
