// All Smartsheet access goes through the backend. This file never talks to
// Smartsheet directly. Locally the frontend is opened straight from disk (or
// a static server) on a different origin than the backend, so it needs the
// full localhost URL; once deployed on Vercel, frontend and API share one
// domain (see /vercel.json), so a relative path is all that's needed.
const BASE_URL =
  window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.protocol === 'file:'
    ? 'http://localhost:3001'
    : '';

async function apiRequest(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error((data && data.error) || `Request to ${path} failed (${res.status}).`);
  }
  return data;
}

const api = {
  getStudents: () => apiRequest('/api/students'),

  getClassSchedule: (studentName) =>
    apiRequest(`/api/class-schedule?student=${encodeURIComponent(studentName)}`),

  getAllClassSchedule: () => apiRequest('/api/class-schedule'),

  addClassScheduleEntry: (entry) =>
    apiRequest('/api/class-schedule', { method: 'POST', body: JSON.stringify(entry) }),

  updateClassScheduleEntry: (rowId, entry) =>
    apiRequest(`/api/class-schedule/${rowId}`, { method: 'PUT', body: JSON.stringify(entry) }),

  deleteClassScheduleEntry: (rowId) =>
    apiRequest(`/api/class-schedule/${rowId}`, { method: 'DELETE' }),

  getTimeOff: (studentName) =>
    apiRequest(`/api/time-off?student=${encodeURIComponent(studentName)}`),

  submitTimeOff: (request) =>
    apiRequest('/api/time-off', { method: 'POST', body: JSON.stringify(request) }),

  setTimeOffStatus: (rowId, status) =>
    apiRequest(`/api/time-off/${rowId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),

  getStudentsRoster: () => apiRequest('/api/students/roster'),

  getWorkSchedule: (semester) =>
    apiRequest(`/api/work-schedule?semester=${encodeURIComponent(semester)}`),

  generateSchedule: (semester, asOfDate) =>
    apiRequest('/api/work-schedule/generate', {
      method: 'POST',
      body: JSON.stringify({ semester, asOfDate }),
    }),

  addWorkScheduleRow: (row) =>
    apiRequest('/api/work-schedule', { method: 'POST', body: JSON.stringify(row) }),

  updateWorkScheduleRow: (rowId, row) =>
    apiRequest(`/api/work-schedule/${rowId}`, { method: 'PUT', body: JSON.stringify(row) }),

  deleteWorkScheduleRow: (rowId) =>
    apiRequest(`/api/work-schedule/${rowId}`, { method: 'DELETE' }),
};
