import { auth } from './firebase';

const DEMO_TOKEN_KEY = 'lasu_attend_demo_token';

export function getStoredDemoToken(): string | null {
  try {
    return sessionStorage.getItem(DEMO_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setStoredDemoToken(token: string | null) {
  try {
    if (token) {
      sessionStorage.setItem(DEMO_TOKEN_KEY, token);
    } else {
      sessionStorage.removeItem(DEMO_TOKEN_KEY);
    }
  } catch {
    // ignore storage errors
  }
}

export async function getAuthToken(): Promise<string | null> {
  const demo = getStoredDemoToken();
  if (demo) return demo;
  if (auth.currentUser) {
    return auth.currentUser.getIdToken();
  }
  return null;
}

export class ApiError extends Error {
  status: number;
  code?: string;
  data?: unknown;

  constructor(message: string, status: number, code?: string, data?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await getAuthToken();
  const headers = new Headers(init?.headers || {});
  if (!headers.has('Content-Type') && init?.body && typeof init.body === 'string') {
    headers.set('Content-Type', 'application/json');
  }
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const res = await fetch(path, {
    ...init,
    headers,
  });

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const json = (await res.json()) as { error?: string; code?: string };
    if (!res.ok) {
      throw new ApiError(json.error || `Request failed (${res.status})`, res.status, json.code, json);
    }
    return json as T;
  }

  if (!res.ok) {
    const text = await res.text();
    throw new ApiError(text || `Request failed (${res.status})`, res.status);
  }

  return (await res.text()) as unknown as T;
}

export async function downloadReport(params: {
  sessionId?: string;
  courseId?: string;
  departmentId?: string;
  dateFrom?: string;
  dateTo?: string;
  status?: string;
  student?: string;
  format: 'csv' | 'xls' | 'pdf';
}) {
  const token = await getAuthToken();
  const q = new URLSearchParams();
  if (params.sessionId) q.set('sessionId', params.sessionId);
  if (params.courseId) q.set('courseId', params.courseId);
  if (params.departmentId) q.set('departmentId', params.departmentId);
  if (params.dateFrom) q.set('dateFrom', params.dateFrom);
  if (params.dateTo) q.set('dateTo', params.dateTo);
  if (params.status) q.set('status', params.status);
  if (params.student) q.set('student', params.student);
  q.set('format', params.format);

  const res = await fetch(`/api/reports/export?${q.toString()}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    let msg = 'Failed to export report.';
    try {
      const errJson = (await res.json()) as { error?: string };
      if (errJson.error) msg = errJson.error;
    } catch {
      // ignore non-json errors
    }
    throw new Error(msg);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const ext = params.format === 'pdf' ? 'pdf' : params.format === 'xls' ? 'xls' : 'csv';
  a.href = url;
  a.download = params.sessionId ? `lasu-attend-${params.sessionId}.${ext}` : `lasu-attend-report.${ext}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
