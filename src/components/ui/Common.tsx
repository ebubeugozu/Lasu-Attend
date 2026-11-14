import React, { useEffect } from 'react';
import { CheckCircle2, AlertTriangle, XCircle, Clock, MinusCircle, HelpCircle, X } from 'lucide-react';

export function BrandMark({ size = 28, light = false }: { size?: number; light?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className="shrink-0"
    >
      <rect width="32" height="32" rx="7" fill={light ? '#1D3352' : '#14243A'} />
      <rect x="6.5" y="6.5" width="7.5" height="7.5" rx="1.5" stroke="#FFFFFF" strokeWidth="2" />
      <rect x="18" y="6.5" width="7.5" height="7.5" rx="1.5" stroke="#4263EB" strokeWidth="2" />
      <rect x="6.5" y="18" width="7.5" height="7.5" rx="1.5" stroke="#0F9D91" strokeWidth="2" />
      <path d="M18 21.75L20.75 24.5L26 18.5" stroke="#FFFFFF" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function StatusLabel({
  status,
  label,
}: {
  status: 'present' | 'late' | 'absent' | 'excused' | 'live' | 'completed' | 'scheduled' | 'cancelled' | 'not_checked_in' | 'active' | 'inactive' | 'pending_activation' | 'pending' | 'suspended' | 'completed_checkpoint' | 'missed_checkpoint' | 'none';
  label?: string;
}) {
  const map: Record<string, { text: string; color: string; icon: React.ReactNode }> = {
    present: { text: 'Present', color: 'text-[#16845B] dark:text-emerald-400', icon: <CheckCircle2 className="w-4 h-4 shrink-0" /> },
    active: { text: 'Active', color: 'text-[#16845B] dark:text-emerald-400', icon: <CheckCircle2 className="w-4 h-4 shrink-0" /> },
    inactive: { text: 'Inactive', color: 'text-[#697586] dark:text-slate-400', icon: <MinusCircle className="w-4 h-4 shrink-0" /> },
    completed: { text: 'Completed', color: 'text-[#16845B] dark:text-emerald-400', icon: <CheckCircle2 className="w-4 h-4 shrink-0" /> },
    completed_checkpoint: { text: 'Verified', color: 'text-[#0F9D91] dark:text-teal-400', icon: <CheckCircle2 className="w-4 h-4 shrink-0" /> },
    live: { text: 'Live Open', color: 'text-[#4263EB] dark:text-blue-400', icon: <Clock className="w-4 h-4 shrink-0" /> },
    late: { text: 'Late', color: 'text-[#D99020] dark:text-amber-400', icon: <AlertTriangle className="w-4 h-4 shrink-0" /> },
    pending_activation: { text: 'Pending Activation', color: 'text-[#D99020] dark:text-amber-400', icon: <Clock className="w-4 h-4 shrink-0" /> },
    pending: { text: 'Pending', color: 'text-[#D99020] dark:text-amber-400', icon: <Clock className="w-4 h-4 shrink-0" /> },
    scheduled: { text: 'Scheduled', color: 'text-[#697586] dark:text-slate-400', icon: <Clock className="w-4 h-4 shrink-0" /> },
    not_checked_in: { text: 'Not yet checked in', color: 'text-[#697586] dark:text-slate-400', icon: <MinusCircle className="w-4 h-4 shrink-0" /> },
    excused: { text: 'Excused', color: 'text-[#697586] dark:text-slate-400', icon: <MinusCircle className="w-4 h-4 shrink-0" /> },
    none: { text: 'Not run', color: 'text-[#697586] dark:text-slate-400', icon: <MinusCircle className="w-4 h-4 shrink-0" /> },
    absent: { text: 'Absent', color: 'text-[#D84A4A] dark:text-rose-400', icon: <XCircle className="w-4 h-4 shrink-0" /> },
    missed_checkpoint: { text: 'Missed 2nd check', color: 'text-[#D84A4A] dark:text-rose-400', icon: <XCircle className="w-4 h-4 shrink-0" /> },
    suspended: { text: 'Suspended', color: 'text-[#D84A4A] dark:text-rose-400', icon: <XCircle className="w-4 h-4 shrink-0" /> },
    cancelled: { text: 'Cancelled', color: 'text-[#D84A4A] dark:text-rose-400', icon: <XCircle className="w-4 h-4 shrink-0" /> },
  };

  const entry = map[status] || { text: status, color: 'text-[#697586] dark:text-slate-400', icon: <MinusCircle className="w-4 h-4 shrink-0" /> };

  return (
    <span className={`inline-flex items-center gap-1.5 text-[13px] font-medium whitespace-nowrap ${entry.color}`}>
      {entry.icon}
      <span>{label || entry.text}</span>
    </span>
  );
}

export function EmptyState({
  title,
  description,
  actionLabel,
  onAction,
}: {
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl px-6 py-12 text-center">
      <h3 className="text-base font-semibold text-[#172337] dark:text-slate-100">{title}</h3>
      <p className="mt-1.5 text-sm text-[#697586] dark:text-slate-400 max-w-md mx-auto">{description}</p>
      {actionLabel && onAction && (
        <button
          type="button"
          onClick={onAction}
          className="mt-5 inline-flex items-center justify-center px-4 py-2.5 text-sm font-medium text-white bg-[#4263EB] hover:bg-[#3451C7] rounded-lg transition-colors"
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}

export function SkeletonRows({ rows = 5 }: { rows?: number }) {
  return (
    <div className="divide-y divide-[#E5EAF0] dark:divide-slate-800">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center justify-between px-5 py-3.5 animate-pulse">
          <div className="flex items-center gap-4">
            <div className="h-4 w-24 bg-[#E5EAF0] dark:bg-slate-800 rounded" />
            <div className="h-4 w-44 bg-[#E5EAF0] dark:bg-slate-800 rounded" />
          </div>
          <div className="h-4 w-20 bg-[#E5EAF0] dark:bg-slate-800 rounded" />
        </div>
      ))}
    </div>
  );
}

export function InfoTooltip({ text }: { text: string }) {
  return (
    <span className="group relative inline-flex items-center ml-1 align-middle">
      <button
        type="button"
        aria-label={text}
        className="text-[#697586] dark:text-slate-400 hover:text-[#172337] dark:hover:text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#4263EB] rounded"
      >
        <HelpCircle className="w-3.5 h-3.5" />
      </button>
      <span
        role="tooltip"
        className="pointer-events-none opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-52 sm:w-60 max-w-[calc(100vw-32px)] rounded-lg bg-[#14243A] dark:bg-slate-800 border border-white/10 px-3 py-2 text-xs font-normal text-white shadow-lg z-40"
      >
        {text}
      </span>
    </span>
  );
}

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  maxWidth = 'max-w-xl',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  maxWidth?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-[#0D1828]/70 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
    >
      <div className={`w-full ${maxWidth} bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-800 rounded-xl shadow-xl overflow-hidden max-h-[92vh] flex flex-col`}>
        <div className="flex items-start justify-between gap-3 px-4 sm:px-6 py-4 border-b border-[#E5EAF0] dark:border-slate-800">
          <div className="min-w-0">
            <h2 className="text-base sm:text-lg font-semibold text-[#172337] dark:text-slate-100 break-words">{title}</h2>
            {subtitle && <p className="text-xs sm:text-sm text-[#697586] dark:text-slate-400 mt-0.5">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close modal"
            className="min-h-[40px] min-w-[40px] shrink-0 flex items-center justify-center rounded-lg text-[#697586] dark:text-slate-400 hover:text-[#172337] dark:hover:text-slate-100 hover:bg-[#F6F8FB] dark:hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-4 sm:p-6 overflow-y-auto text-[#172337] dark:text-slate-100">{children}</div>
      </div>
    </div>
  );
}
