import React, { useCallback, useEffect, useState } from 'react';
import {
  Bell,
  CheckCheck,
  ChevronDown,
  LogOut,
  Menu,
  Play,
  X,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { ThemeSwitcher } from '../../context/ThemeContext';
import { apiFetch } from '../../lib/api';
import type { AppNotification } from '../../types/lasu';
import { BrandMark } from '../ui/Common';

export interface NavItem {
  id: string;
  label: string;
  icon: React.ReactNode;
  badgeCount?: number;
}

const CATEGORY_LABEL: Record<string, string> = {
  upcoming_class: 'Upcoming Class',
  milestone: 'Milestone',
  attendance_update: 'Attendance Update',
  session: 'Session',
  system: 'System',
};

export function AppShell({
  navItems,
  activeNav,
  onSelectNav,
  primaryAction,
  mobileBottomTabs,
  onOpenNotifications,
  notificationsRefreshKey,
  children,
}: {
  navItems: NavItem[];
  activeNav: string;
  onSelectNav: (id: string) => void;
  primaryAction?: { label: string; onClick: () => void };
  mobileBottomTabs?: NavItem[];
  onOpenNotifications?: () => void;
  notificationsRefreshKey?: number;
  children: React.ReactNode;
}) {
  const { user, isDemoSession, logout } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);

  const loadNotifications = useCallback(() => {
    apiFetch<AppNotification[]>('/api/notifications')
      .then((list) => setNotifications(list))
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadNotifications();
  }, [activeNav, notificationsRefreshKey, loadNotifications]);

  const unreadCount = notifications.filter((n) => !n.read).length;

  const markRead = async (id: string) => {
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
    apiFetch(`/api/notifications/${id}/read`, { method: 'POST' }).catch(() => {});
  };

  const markAllRead = async () => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    apiFetch('/api/notifications/read-all', { method: 'POST' }).catch(() => {});
  };

  const todayFormatted = new Date().toLocaleDateString('en-NG', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

  const roleDisplay =
    user?.role === 'system_admin'
      ? 'System Administrator'
      : user?.role === 'department_admin'
        ? 'Department Administrator'
        : user?.role === 'lecturer'
          ? 'Lecturer'
          : 'Student';

  return (
    <div className="min-h-screen bg-[#F6F8FB] dark:bg-[#09111E] text-[#172337] dark:text-slate-100 flex">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex lg:w-64 lg:flex-col lg:fixed lg:inset-y-0 bg-[#0D1828] border-r border-white/10 text-white z-30">
        <div className="h-16 px-5 flex items-center gap-3 border-b border-white/10">
          <BrandMark size={30} light />
          <span className="text-base font-bold tracking-tight text-white whitespace-nowrap">LASU Attend</span>
        </div>

        <nav className="flex-1 px-3 py-5 space-y-1 overflow-y-auto" aria-label="Primary navigation">
          {navItems.map((item) => {
            const active = item.id === activeNav;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectNav(item.id)}
                className={`w-full min-h-[42px] px-3.5 py-2.5 rounded-lg text-sm font-medium flex items-center justify-between gap-2 transition-colors text-left ${
                  active
                    ? 'bg-[#14243A] text-white'
                    : 'text-[#B8C4D4] hover:text-white hover:bg-[#14243A]/60'
                }`}
              >
                <span className="flex items-center gap-3 min-w-0">
                  <span className={active ? 'text-[#4263EB]' : 'text-[#9FB0C7]'}>{item.icon}</span>
                  <span className="truncate">{item.label}</span>
                </span>
                {typeof item.badgeCount === 'number' && item.badgeCount > 0 && (
                  <span className="min-w-[20px] h-5 px-1.5 rounded-md bg-[#4263EB] text-white text-[11px] font-mono-tabular font-semibold inline-flex items-center justify-center">
                    {item.badgeCount}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <div className="p-4 border-t border-white/10 text-xs text-[#9FB0C7] space-y-1">
          <p className="font-medium text-white truncate">{user?.displayName}</p>
          <p className="truncate">{roleDisplay}</p>
          <p className="truncate">{user?.departmentName || 'Lagos State University'}</p>
        </div>
      </aside>

      {/* Mobile / Tablet Drawer Sidebar */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div className="fixed inset-0 bg-[#0D1828]/70" onClick={() => setSidebarOpen(false)} />
          <aside className="relative w-72 max-w-[85vw] bg-[#0D1828] text-white flex flex-col z-10 border-r border-white/10">
            <div className="h-16 px-5 flex items-center justify-between border-b border-white/10">
              <div className="flex items-center gap-3">
                <BrandMark size={28} light />
                <span className="text-base font-bold text-white">LASU Attend</span>
              </div>
              <button
                type="button"
                onClick={() => setSidebarOpen(false)}
                aria-label="Close menu"
                className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-lg text-[#B8C4D4] hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
              {navItems.map((item) => {
                const active = item.id === activeNav;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      onSelectNav(item.id);
                      setSidebarOpen(false);
                    }}
                    className={`w-full min-h-[44px] px-3.5 py-2.5 rounded-lg text-sm font-medium flex items-center justify-between gap-2 text-left ${
                      active ? 'bg-[#14243A] text-white' : 'text-[#B8C4D4] hover:bg-[#14243A]/60'
                    }`}
                  >
                    <span className="flex items-center gap-3 min-w-0">
                      <span>{item.icon}</span>
                      <span className="truncate">{item.label}</span>
                    </span>
                    {typeof item.badgeCount === 'number' && item.badgeCount > 0 && (
                      <span className="min-w-[20px] h-5 px-1.5 rounded-md bg-[#4263EB] text-white text-[11px] font-mono-tabular font-semibold inline-flex items-center justify-center">
                        {item.badgeCount}
                      </span>
                    )}
                  </button>
                );
              })}
            </nav>
            <div className="p-4 border-t border-white/10">
              <button
                type="button"
                onClick={logout}
                className="w-full min-h-[44px] px-3.5 rounded-lg bg-white/10 hover:bg-white/15 text-sm font-medium text-white flex items-center justify-center gap-2"
              >
                <LogOut className="w-4 h-4" />
                <span>Sign Out</span>
              </button>
            </div>
          </aside>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 lg:pl-64 flex flex-col min-w-0">
        {/* Top Header */}
        <header className="sticky top-0 z-20 h-16 bg-white dark:bg-[#0F1A2B] border-b border-[#E5EAF0] dark:border-slate-800 px-4 md:px-6 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setSidebarOpen(true)}
              aria-label="Open navigation"
              className="lg:hidden min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg text-[#172337] dark:text-slate-200 hover:bg-[#F6F8FB] dark:hover:bg-slate-800"
            >
              <Menu className="w-5 h-5" />
            </button>

            <div className="min-w-0">
              <div className="flex items-center gap-2 text-xs text-[#697586] dark:text-slate-400">
                <span className="whitespace-nowrap">{todayFormatted}</span>
                {isDemoSession && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="font-medium text-[#D99020] dark:text-amber-400 truncate">
                      Demo Environment (Sample Data)
                    </span>
                  </>
                )}
              </div>
              <p className="text-sm font-semibold text-[#172337] dark:text-slate-100 truncate">
                Welcome, {user?.displayName}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {primaryAction && (
              <button
                type="button"
                onClick={primaryAction.onClick}
                className="min-h-[40px] px-3.5 md:px-4 py-2 rounded-lg bg-[#4263EB] hover:bg-[#3451C7] text-white text-sm font-medium inline-flex items-center gap-2 transition-colors whitespace-nowrap shrink-0"
              >
                <Play className="w-3.5 h-3.5 fill-current" />
                <span>{primaryAction.label}</span>
              </button>
            )}

            <ThemeSwitcher variant="compact" />

            {/* Notifications Popover */}
            <div className="relative">
              <button
                type="button"
                aria-label="Notifications"
                onClick={() => {
                  setNotifOpen((v) => !v);
                  setProfileOpen(false);
                }}
                className="relative min-h-[40px] min-w-[40px] flex items-center justify-center rounded-lg border border-[#E5EAF0] dark:border-slate-700 bg-white dark:bg-[#14243A] hover:bg-[#F6F8FB] dark:hover:bg-slate-800 text-[#172337] dark:text-slate-200"
              >
                <Bell className="w-4 h-4" />
                {unreadCount > 0 && (
                  <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-[#4263EB] text-white text-[10px] font-semibold flex items-center justify-center tabular-nums">
                    {unreadCount}
                  </span>
                )}
              </button>

              {notifOpen && (
                <div className="absolute right-0 mt-2 w-80 sm:w-96 max-w-[92vw] bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-700 rounded-xl shadow-xl z-40 overflow-hidden">
                  <div className="px-4 py-3 border-b border-[#E5EAF0] dark:border-slate-800 flex items-center justify-between gap-2">
                    <div>
                      <span className="text-sm font-semibold text-[#172337] dark:text-slate-100">Notifications</span>
                      <span className="ml-2 text-xs text-[#697586] dark:text-slate-400 tabular-nums">
                        {unreadCount} unread
                      </span>
                    </div>
                    {unreadCount > 0 && (
                      <button
                        type="button"
                        onClick={markAllRead}
                        className="text-xs font-medium text-[#4263EB] dark:text-blue-400 hover:underline inline-flex items-center gap-1"
                      >
                        <CheckCheck className="w-3.5 h-3.5" />
                        <span>Mark all read</span>
                      </button>
                    )}
                  </div>
                  <div className="max-h-72 overflow-y-auto divide-y divide-[#E5EAF0] dark:divide-slate-800">
                    {notifications.length === 0 ? (
                      <p className="p-4 text-xs text-[#697586] dark:text-slate-400 text-center">No notifications yet.</p>
                    ) : (
                      notifications.slice(0, 12).map((n) => (
                        <button
                          key={n.id}
                          type="button"
                          onClick={() => markRead(n.id)}
                          className={`w-full text-left px-4 py-3 hover:bg-[#F6F8FB] dark:hover:bg-slate-800/60 transition-colors ${
                            n.read ? 'opacity-65' : 'bg-[#4263EB]/[0.04] dark:bg-blue-500/10'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[11px] font-medium text-[#4263EB] dark:text-blue-400">
                              {CATEGORY_LABEL[n.category || n.type || 'system'] || 'Update'}
                            </span>
                            <span className="text-[11px] font-mono-tabular text-[#697586] dark:text-slate-400">
                              {new Date(n.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                            </span>
                          </div>
                          <p className="text-xs font-semibold text-[#172337] dark:text-slate-100 mt-0.5">{n.title}</p>
                          <p className="text-xs text-[#697586] dark:text-slate-400 mt-0.5 leading-relaxed">{n.message}</p>
                        </button>
                      ))
                    )}
                  </div>
                  {onOpenNotifications && (
                    <div className="px-4 py-2.5 border-t border-[#E5EAF0] dark:border-slate-800 bg-[#F6F8FB]/70 dark:bg-[#09111E]/60">
                      <button
                        type="button"
                        onClick={() => {
                          setNotifOpen(false);
                          onOpenNotifications();
                        }}
                        className="w-full text-center text-xs font-medium text-[#4263EB] dark:text-blue-400 hover:underline"
                      >
                        Open Notification Centre
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Profile Dropdown */}
            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  setProfileOpen((v) => !v);
                  setNotifOpen(false);
                }}
                className="min-h-[40px] pl-3 pr-2.5 py-1.5 rounded-lg border border-[#E5EAF0] dark:border-slate-700 bg-white dark:bg-[#14243A] hover:bg-[#F6F8FB] dark:hover:bg-slate-800 flex items-center gap-2 text-sm font-medium text-[#172337] dark:text-slate-100"
              >
                <span className="w-6 h-6 rounded-md bg-[#14243A] dark:bg-[#4263EB] text-white text-xs font-semibold flex items-center justify-center">
                  {(user?.displayName || 'U').charAt(0).toUpperCase()}
                </span>
                <ChevronDown className="w-4 h-4 text-[#697586] dark:text-slate-400" />
              </button>

              {profileOpen && (
                <div className="absolute right-0 mt-2 w-64 bg-white dark:bg-[#0F1A2B] border border-[#E5EAF0] dark:border-slate-700 rounded-xl shadow-xl z-40 p-2 space-y-2">
                  <div className="px-3 py-2 border-b border-[#E5EAF0] dark:border-slate-800">
                    <p className="text-xs font-semibold text-[#172337] dark:text-slate-100 truncate">{user?.displayName}</p>
                    <p className="text-xs text-[#697586] dark:text-slate-400 truncate">{user?.email}</p>
                    <p className="text-[11px] text-[#4263EB] dark:text-blue-400 mt-0.5">{roleDisplay}</p>
                  </div>
                  <div className="px-2">
                    <p className="text-[11px] text-[#697586] dark:text-slate-400 mb-1.5 px-1">Appearance</p>
                    <ThemeSwitcher variant="segmented" />
                  </div>
                  <button
                    type="button"
                    onClick={logout}
                    className="w-full px-3 py-2 rounded-lg text-left text-xs font-medium text-[#D84A4A] dark:text-rose-400 hover:bg-[#D84A4A]/10 flex items-center gap-2"
                  >
                    <LogOut className="w-3.5 h-3.5" />
                    <span>Sign Out</span>
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        {/* Main Viewport */}
        <main className={`flex-1 p-4 md:p-6 lg:p-8 max-w-[1440px] w-full mx-auto ${mobileBottomTabs ? 'pb-24 md:pb-8' : ''}`}>
          {children}
        </main>
      </div>

      {/* Mobile Bottom Tab Bar (Student Thumb Zone) */}
      {mobileBottomTabs && (
        <nav
          aria-label="Mobile student navigation"
          className="md:hidden fixed bottom-0 left-0 right-0 z-30 h-16 bg-white/95 dark:bg-[#0F1A2B]/95 backdrop-blur-md border-t border-[#E5EAF0] dark:border-slate-800 grid"
          style={{ gridTemplateColumns: `repeat(${mobileBottomTabs.length}, minmax(0, 1fr))` }}
        >
          {mobileBottomTabs.map((tab) => {
            const active = tab.id === activeNav;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => onSelectNav(tab.id)}
                className={`relative flex flex-col items-center justify-center gap-1 min-h-[44px] ${
                  active ? 'text-[#4263EB] dark:text-blue-400' : 'text-[#697586] dark:text-slate-400'
                }`}
              >
                <span className="relative">
                  {tab.icon}
                  {typeof tab.badgeCount === 'number' && tab.badgeCount > 0 && (
                    <span className="absolute -top-1.5 -right-2 min-w-[14px] h-[14px] px-1 rounded-full bg-[#4263EB] text-white text-[9px] font-bold flex items-center justify-center">
                      {tab.badgeCount}
                    </span>
                  )}
                </span>
                <span className="text-[11px] font-medium truncate max-w-full px-1">{tab.label}</span>
              </button>
            );
          })}
        </nav>
      )}
    </div>
  );
}
