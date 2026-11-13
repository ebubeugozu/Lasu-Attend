import React, { useEffect, useState } from 'react';
import type { AttendanceSession, Course } from '../../types/lasu';
import { apiFetch } from '../../lib/api';
import { Modal } from '../ui/Common';

export function StartAttendanceModal({
  open,
  onClose,
  courses,
  defaultCourseId,
  onStarted,
}: {
  open: boolean;
  onClose: () => void;
  courses: Course[];
  defaultCourseId?: string;
  onStarted: (session: AttendanceSession) => void;
}) {
  const [courseId, setCourseId] = useState(defaultCourseId || courses[0]?.id || '');
  const [lectureTitle, setLectureTitle] = useState('');
  const [venue, setVenue] = useState('');
  const [lateThresholdMinutes, setLateThresholdMinutes] = useState(15);
  const [startImmediately, setStartImmediately] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (defaultCourseId) setCourseId(defaultCourseId);
    else if (!courseId && courses[0]) setCourseId(courses[0].id);
  }, [defaultCourseId, courses, courseId]);

  useEffect(() => {
    const selected = courses.find((c) => c.id === courseId);
    if (selected?.timetableSlots && selected.timetableSlots.length > 0) {
      setVenue(selected.timetableSlots[0].venue);
    }
  }, [courseId, courses]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!courseId) return;
    setSubmitting(true);
    setError(null);
    try {
      const now = new Date();
      const res = await apiFetch<{ session: AttendanceSession }>('/api/sessions', {
        method: 'POST',
        body: JSON.stringify({
          courseId,
          lectureTitle: lectureTitle.trim() || undefined,
          venue: venue.trim() || undefined,
          sessionDate: now.toISOString().slice(0, 10),
          startTime: now.toTimeString().slice(0, 5),
          lateThresholdMinutes: Number(lateThresholdMinutes),
          startImmediately,
        }),
      });
      setLectureTitle('');
      onStarted(res.session);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create attendance session.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Start Attendance Session"
      subtitle="Sensible defaults are pre-selected so you can display the QR code in seconds."
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <div className="rounded-lg bg-[#D84A4A]/10 border border-[#D84A4A]/25 px-3.5 py-2.5 text-xs text-[#D84A4A] dark:text-rose-400">
            {error}
          </div>
        )}

        <div>
          <label htmlFor="session-course" className="block text-xs font-medium text-[#172337] dark:text-slate-200 mb-1.5">
            Course
          </label>
          <select
            id="session-course"
            value={courseId}
            onChange={(e) => setCourseId(e.target.value)}
            required
            className="w-full min-h-[42px] px-3 py-2 text-sm border border-[#E5EAF0] dark:border-slate-700 rounded-lg bg-white dark:bg-[#09111E] text-[#172337] dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-[#4263EB]"
          >
            {courses.map((c) => (
              <option key={c.id} value={c.id}>
                {c.courseCode} — {c.courseTitle} ({c.enrolledCount} enrolled)
              </option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label htmlFor="lecture-title" className="block text-xs font-medium text-[#172337] dark:text-slate-200 mb-1.5">
              Lecture Topic (Optional)
            </label>
            <input
              id="lecture-title"
              type="text"
              value={lectureTitle}
              onChange={(e) => setLectureTitle(e.target.value)}
              placeholder="e.g. Week 4: Rigid Body Dynamics"
              className="w-full min-h-[42px] px-3 py-2 text-sm border border-[#E5EAF0] dark:border-slate-700 rounded-lg bg-white dark:bg-[#09111E] text-[#172337] dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-[#4263EB]"
            />
          </div>

          <div>
            <label htmlFor="session-venue" className="block text-xs font-medium text-[#172337] dark:text-slate-200 mb-1.5">
              Venue / Lecture Hall (Optional)
            </label>
            <input
              id="session-venue"
              type="text"
              value={venue}
              onChange={(e) => setVenue(e.target.value)}
              placeholder="e.g. Engineering Lecture Theatre (ELT)"
              className="w-full min-h-[42px] px-3 py-2 text-sm border border-[#E5EAF0] dark:border-slate-700 rounded-lg bg-white dark:bg-[#09111E] text-[#172337] dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-[#4263EB]"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label htmlFor="late-threshold" className="block text-xs font-medium text-[#172337] dark:text-slate-200 mb-1.5">
              Late-Arrival Threshold (Minutes)
            </label>
            <input
              id="late-threshold"
              type="number"
              min={0}
              max={120}
              value={lateThresholdMinutes}
              onChange={(e) => setLateThresholdMinutes(Number(e.target.value))}
              className="w-full min-h-[42px] px-3 py-2 text-sm font-mono-tabular border border-[#E5EAF0] dark:border-slate-700 rounded-lg bg-white dark:bg-[#09111E] text-[#172337] dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-[#4263EB]"
            />
          </div>

          <div className="flex items-end pb-1">
            <label className="inline-flex items-center gap-2.5 text-sm text-[#172337] dark:text-slate-200 cursor-pointer">
              <input
                type="checkbox"
                checked={startImmediately}
                onChange={(e) => setStartImmediately(e.target.checked)}
                className="w-4 h-4 rounded border-[#E5EAF0] dark:border-slate-700 text-[#4263EB] focus:ring-[#4263EB]"
              />
              <span>Open QR check-in immediately</span>
            </label>
          </div>
        </div>

        <div className="pt-2 flex items-center justify-end gap-3 border-t border-[#E5EAF0] dark:border-slate-800">
          <button
            type="button"
            onClick={onClose}
            className="min-h-[40px] px-4 py-2 text-sm font-medium text-[#697586] dark:text-slate-300 hover:text-[#172337] dark:hover:text-white rounded-lg border border-[#E5EAF0] dark:border-slate-700"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting || !courseId}
            className="min-h-[40px] px-5 py-2 text-sm font-medium text-white bg-[#4263EB] hover:bg-[#3451C7] rounded-lg disabled:opacity-60"
          >
            {submitting ? 'Starting...' : startImmediately ? 'Start & Display QR' : 'Schedule Session'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
