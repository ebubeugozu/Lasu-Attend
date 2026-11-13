import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import type { ThemePreference } from '../types/lasu';

const GLOBAL_THEME_KEY = 'lasu_attend_theme';

function getSystemTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return 'light';
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function readStoredTheme(storageKey: string): ThemePreference {
  try {
    const val = localStorage.getItem(storageKey) || localStorage.getItem(GLOBAL_THEME_KEY);
    if (val === 'light' || val === 'dark' || val === 'system') {
      return val;
    }
  } catch {
    // ignore storage access issues
  }
  return 'system';
}

interface ThemeContextValue {
  preference: ThemePreference;
  resolvedTheme: 'light' | 'dark';
  setPreference: (pref: ThemePreference) => void;
  setActiveUserScope: (uid: string | null) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [userScopeUid, setUserScopeUid] = useState<string | null>(null);
  const storageKey = userScopeUid ? `${GLOBAL_THEME_KEY}_${userScopeUid}` : GLOBAL_THEME_KEY;

  const [preference, setPreferenceState] = useState<ThemePreference>(() => readStoredTheme(GLOBAL_THEME_KEY));
  const [systemTheme, setSystemTheme] = useState<'light' | 'dark'>(() => getSystemTheme());

  // Sync user-scoped preference when user signs in/out
  useEffect(() => {
    setPreferenceState(readStoredTheme(storageKey));
  }, [storageKey]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => {
      setSystemTheme(e.matches ? 'dark' : 'light');
    };
    setSystemTheme(mq.matches ? 'dark' : 'light');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const resolvedTheme: 'light' | 'dark' = preference === 'system' ? systemTheme : preference;

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', resolvedTheme === 'dark');
    root.dataset.theme = resolvedTheme;
    root.style.colorScheme = resolvedTheme;
  }, [resolvedTheme]);

  const setPreference = useCallback(
    (pref: ThemePreference) => {
      setPreferenceState(pref);
      try {
        localStorage.setItem(GLOBAL_THEME_KEY, pref);
        if (userScopeUid) {
          localStorage.setItem(`${GLOBAL_THEME_KEY}_${userScopeUid}`, pref);
        }
      } catch {
        // ignore storage errors
      }
    },
    [userScopeUid]
  );

  const setActiveUserScope = useCallback((uid: string | null) => {
    setUserScopeUid(uid);
  }, []);

  const value = useMemo(
    () => ({
      preference,
      resolvedTheme,
      setPreference,
      setActiveUserScope,
    }),
    [preference, resolvedTheme, setPreference, setActiveUserScope]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used inside ThemeProvider');
  }
  return ctx;
}

export function ThemeSwitcher({
  variant = 'segmented',
}: {
  variant?: 'segmented' | 'compact';
}) {
  const { preference, resolvedTheme, setPreference } = useTheme();

  if (variant === 'compact') {
    const nextMap: Record<ThemePreference, ThemePreference> = {
      light: 'dark',
      dark: 'system',
      system: 'light',
    };
    const labelMap: Record<ThemePreference, string> = {
      light: 'Light theme',
      dark: 'Dark theme',
      system: `System theme (${resolvedTheme})`,
    };
    const Icon = preference === 'dark' ? Moon : preference === 'light' ? Sun : Monitor;

    return (
      <button
        type="button"
        onClick={() => setPreference(nextMap[preference])}
        title={`${labelMap[preference]} — click to switch`}
        aria-label={`${labelMap[preference]}. Switch theme`}
        className="min-w-[40px] min-h-[40px] px-2.5 rounded-lg border border-[#E5EAF0] dark:border-slate-700 bg-white dark:bg-[#14243A] text-[#172337] dark:text-slate-200 hover:bg-[#F6F8FB] dark:hover:bg-slate-800 inline-flex items-center gap-1.5 text-xs font-medium transition-colors"
      >
        <Icon className="w-4 h-4 text-[#4263EB] dark:text-blue-400" />
        <span className="hidden xl:inline capitalize">{preference}</span>
      </button>
    );
  }

  const options: Array<{ id: ThemePreference; label: string; icon: typeof Sun }> = [
    { id: 'light', label: 'Light', icon: Sun },
    { id: 'dark', label: 'Dark', icon: Moon },
    { id: 'system', label: 'System', icon: Monitor },
  ];

  return (
    <div
      role="radiogroup"
      aria-label="Theme preference"
      className="inline-flex items-center p-1 rounded-lg bg-[#F6F8FB] dark:bg-[#09111E] border border-[#E5EAF0] dark:border-slate-700 gap-1"
    >
      {options.map((opt) => {
        const Icon = opt.icon;
        const active = preference === opt.id;
        return (
          <button
            key={opt.id}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => setPreference(opt.id)}
            className={`min-h-[36px] px-3 py-1.5 rounded-md text-xs font-medium inline-flex items-center gap-1.5 transition-colors whitespace-nowrap ${
              active
                ? 'bg-white dark:bg-[#1A2D47] text-[#14243A] dark:text-white shadow-xs border border-[#E5EAF0] dark:border-slate-600'
                : 'text-[#697586] dark:text-slate-400 hover:text-[#172337] dark:hover:text-slate-200'
            }`}
          >
            <Icon className="w-3.5 h-3.5" />
            <span>{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}
