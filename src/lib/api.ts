// Simple API wrapper that injects JWT token automatically
const BASE = '/api';

function getToken() {
  return localStorage.getItem('sync_engine_token');
}

async function request(url: string, options: RequestInit = {}) {
  const token = getToken();
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(options.headers || {}),
  };

  const res = await fetch(BASE + url, { ...options, headers });

  if (res.status === 401) {
    localStorage.removeItem('sync_engine_token');
    window.location.href = '/login';
    throw new Error('Unauthorized');
  }

  const text = await res.text();
  const json = text ? JSON.parse(text) : {};

  if (!res.ok) {
    throw new Error(json.error || `Request failed: ${res.status}`);
  }

  return json;
}

export const api = {
  get: (url: string) => request(url, { method: 'GET' }),
  post: (url: string, body?: unknown) => request(url, { method: 'POST', body: JSON.stringify(body) }),
  patch: (url: string, body?: unknown) => request(url, { method: 'PATCH', body: JSON.stringify(body) }),
  put: (url: string, body?: unknown) => request(url, { method: 'PUT', body: JSON.stringify(body) }),
  delete: (url: string) => request(url, { method: 'DELETE' }),
};

// Auth helpers
export function setToken(token: string) {
  localStorage.setItem('sync_engine_token', token);
}

export function clearToken() {
  localStorage.removeItem('sync_engine_token');
  localStorage.removeItem('sync_engine_user');
}

export function getUser() {
  const u = localStorage.getItem('sync_engine_user');
  return u ? JSON.parse(u) : null;
}

export function setUser(user: unknown) {
  localStorage.setItem('sync_engine_user', JSON.stringify(user));
}
