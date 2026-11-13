import React, { useState } from 'react';
import { Maximize2, Minimize2, Copy, Check, ArrowLeft, ShieldCheck, Users } from 'lucide-react';
import { useLiveQR } from '../../hooks/useLiveQR';
import { BrandMark } from '../ui/Common';

export function QRPresentationView({
  sessionId,
  onExit,
}: {
  sessionId: string;
  onExit?: () => void;
}) {
  const { payload, qrDataUrl, secondsRemaining, wsConnected, error } = useLiveQR(sessionId, true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [copied, setCopied] = useState(false);

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().then(() => setIsFullscreen(true)).catch(() => {});
    } else {
      document.exitFullscreen().then(() => setIsFullscreen(false)).catch(() => {});
    }
  };

  const copyDisplayLink = () => {
    const url = `${window.location.origin}/present/${sessionId}`;
    navigator.clipboard?.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  if (error) {
    return (
      <div className="min-h-screen bg-[#0D1828] text-white flex flex-col items-center justify-center p-6">
        <p className="text-lg font-medium text-[#D84A4A]">{error}</p>
        {onExit && (
          <button
            type="button"
            onClick={onExit}
            className="mt-4 px-4 py-2 bg-[#4263EB] rounded-lg text-sm font-medium"
          >
            Back to Session
          </button>
        )}
      </div>
    );
  }

  if (!payload) {
    return (
      <div className="min-h-screen bg-[#0D1828] text-white flex items-center justify-center">
        <p className="text-sm text-[#9FB0C7]">Connecting to lecture hall display...</p>
      </div>
    );
  }

  const isVerifyMode = payload.mode === 'verify';
  const progressPct =
    payload.rotationIntervalSeconds > 0
      ? Math.min(100, Math.max(0, (secondsRemaining / payload.rotationIntervalSeconds) * 100))
      : 0;
  const shortUrl = `${window.location.host}/checkin`;

  return (
    <div className="min-h-screen bg-[#0D1828] text-white flex flex-col justify-between p-6 md:p-10">
      {/* Top Bar */}
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-white/10 pb-5">
        <div className="flex items-center gap-3.5">
          {onExit && (
            <button
              type="button"
              onClick={onExit}
              className="min-h-[40px] px-3 py-2 rounded-lg bg-white/10 hover:bg-white/15 text-sm font-medium inline-flex items-center gap-2 transition-colors whitespace-nowrap"
            >
              <ArrowLeft className="w-4 h-4" />
              <span>Dashboard</span>
            </button>
          )}
          <BrandMark size={32} light />
          <div>
            <div className="flex items-center gap-2 text-xs text-[#9FB0C7]">
              <span>LASU Attend</span>
              <span aria-hidden="true">·</span>
              <span>{wsConnected ? 'Display synchronized' : 'Reconnecting'}</span>
            </div>
            <h1 className="text-xl md:text-2xl font-bold tracking-tight text-white">
              {payload.courseCode} — {payload.courseTitle}
            </h1>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={copyDisplayLink}
            className="min-h-[40px] px-3.5 py-2 rounded-lg bg-white/10 hover:bg-white/15 text-sm font-medium inline-flex items-center gap-2 transition-colors whitespace-nowrap"
          >
            {copied ? <Check className="w-4 h-4 text-[#0F9D91]" /> : <Copy className="w-4 h-4" />}
            <span>{copied ? 'Link copied' : 'Mirror on another screen'}</span>
          </button>
          <button
            type="button"
            onClick={toggleFullscreen}
            className="min-h-[40px] px-3.5 py-2 rounded-lg bg-[#4263EB] hover:bg-[#3451C7] text-sm font-medium inline-flex items-center gap-2 transition-colors whitespace-nowrap"
          >
            {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
            <span>{isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}</span>
          </button>
        </div>
      </header>

      {/* Main High-Contrast QR Stage */}
      <main className="flex-1 flex flex-col lg:flex-row items-center justify-center gap-10 lg:gap-16 py-8 max-w-6xl mx-auto w-full">
        {/* Left: High-Contrast QR Box */}
        <div className="bg-white p-6 md:p-8 rounded-2xl shadow-2xl flex flex-col items-center">
          {payload.status !== 'live' ? (
            <div className="w-[300px] h-[300px] md:w-[360px] md:h-[360px] flex flex-col items-center justify-center text-center bg-[#F6F8FB] rounded-xl p-6">
              <p className="text-xl font-bold text-[#14243A]">Attendance Closed</p>
              <p className="text-sm text-[#697586] mt-2">
                This session has ended. Return to the lecturer dashboard to review and export results.
              </p>
            </div>
          ) : qrDataUrl ? (
            <img
              src={qrDataUrl}
              alt={`Dynamic attendance QR code for ${payload.courseCode}`}
              className="w-[300px] h-[300px] md:w-[380px] md:h-[380px] object-contain"
            />
          ) : (
            <div className="w-[300px] h-[300px] md:w-[380px] md:h-[380px] bg-[#F6F8FB] rounded-xl animate-pulse" />
          )}

          {/* Countdown bar */}
          {payload.status === 'live' && (
            <div className="w-full mt-5">
              <div className="flex items-center justify-between text-xs font-medium text-[#172337] mb-1.5">
                <span>Code rotates automatically</span>
                <span className="font-mono-tabular font-semibold text-[#4263EB]">{secondsRemaining}s</span>
              </div>
              <div className="w-full h-2 bg-[#E5EAF0] rounded-full overflow-hidden">
                <div
                  className={`h-full transition-all duration-500 ${
                    isVerifyMode ? 'bg-[#0F9D91]' : 'bg-[#4263EB]'
                  }`}
                  style={{ width: `${progressPct}%` }}
                />
              </div>
            </div>
          )}
        </div>

        {/* Right: Clear Instructions, Status & Live Count */}
        <div className="max-w-lg w-full space-y-6 text-center lg:text-left">
          <div className="space-y-2">
            <div className="inline-flex items-center gap-2 text-sm font-semibold tracking-wide text-[#0F9D91]">
              <ShieldCheck className="w-5 h-5" />
              <span>
                {payload.status !== 'live'
                  ? 'Session Completed'
                  : isVerifyMode
                    ? 'Second Checkpoint: Verify Attendance'
                    : 'Attendance Open'}
              </span>
            </div>
            <h2 className="text-3xl md:text-4xl font-bold text-white leading-tight">
              Scan this code from your seat using your phone camera.
            </h2>
            <p className="text-base text-[#B8C4D4]">
              {payload.lectureTitle ? `${payload.lectureTitle} · ` : ''}
              {payload.venue ? `${payload.venue} · ` : ''}
              {payload.lecturerName}
            </p>
          </div>

          {/* Live Count Metric */}
          <div className="grid grid-cols-2 gap-4 bg-[#14243A] border border-white/10 rounded-xl p-5">
            <div>
              <div className="flex items-center justify-center lg:justify-start gap-2 text-xs text-[#9FB0C7]">
                <Users className="w-4 h-4" />
                <span>{isVerifyMode ? 'Checkpoint Verified' : 'Checked In'}</span>
              </div>
              <p className="mt-1 text-3xl font-bold font-mono-tabular text-white">
                {isVerifyMode ? payload.verifiedCount : payload.checkedInCount}
                <span className="text-lg font-normal text-[#9FB0C7]"> / {payload.totalEnrolled}</span>
              </p>
            </div>
            <div>
              <p className="text-xs text-[#9FB0C7]">Rotation Window</p>
              <p className="mt-1 text-3xl font-bold font-mono-tabular text-white">
                {payload.rotationIntervalSeconds}s
              </p>
              <p className="text-xs text-[#9FB0C7] mt-0.5">{payload.graceSeconds}s scan grace period</p>
            </div>
          </div>

          {/* Manual Fallback Code for Accessibility / Camera Issues */}
          {payload.status === 'live' && (
            <div className="bg-[#14243A] border border-white/10 rounded-xl p-5">
              <p className="text-xs text-[#9FB0C7]">Camera issue? Open {shortUrl} and enter fallback code:</p>
              <p className="mt-2 text-3xl md:text-4xl font-mono-tabular font-bold tracking-widest text-white select-all">
                {payload.shortCode}
              </p>
            </div>
          )}
        </div>
      </main>

      {/* Subtle Footer */}
      <footer className="border-t border-white/10 pt-4 flex flex-wrap items-center justify-between gap-4 text-xs text-[#9FB0C7]">
        <span>Multiple students may scan simultaneously. Remain seated during check-in.</span>
        <span>Lagos State University · LASU Attend</span>
      </footer>
    </div>
  );
}
