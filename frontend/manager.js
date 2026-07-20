// No login here either (same accepted Phase 1 tradeoff as the student portal).

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
const LOCATIONS = ['S700', 'TLS', 'S701', 'Back Office'];
const SEAT_CAPACITY = { S700: 2, TLS: 1, S701: 1, 'Back Office': Infinity };

let currentWorkScheduleRows = [];

function to12Hour(time24) {
  if (!time24) return '';
  const [h, m] = time24.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const hour = ((h + 11) % 12) + 1;
  return `${hour}:${String(m).padStart(2, '0')} ${period}`;
}

function to24Hour(time12) {
  if (!time12) return '';
  const match = time12.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return '';
  let [, h, m, period] = match;
  h = parseInt(h, 10) % 12;
  if (period.toUpperCase() === 'PM') h += 12;
  return `${String(h).padStart(2, '0')}:${m}`;
}

function parseTimeMinutes(text) {
  if (!text) return null;
  const match = String(text).trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return null;
  let [, h, m, period] = match;
  h = parseInt(h, 10) % 12;
  if (period.toUpperCase() === 'PM') h += 12;
  return h * 60 + parseInt(m, 10);
}

function showStatus(el, message, kind) {
  el.textContent = message;
  el.hidden = false;
  el.className = `status ${kind}`;
}

// --- Roster (for the Add/Edit Shift student dropdown) ---
async function loadRoster() {
  const select = document.getElementById('shift-student');
  try {
    const roster = await api.getStudentsRoster();
    select.innerHTML = '';
    roster
      .filter((s) => s.active)
      .forEach((s) => {
        const opt = document.createElement('option');
        opt.value = s.name;
        opt.textContent = `${s.name} (${s.role}${s.primaryLocation ? ' - ' + s.primaryLocation : ''})`;
        select.appendChild(opt);
      });
  } catch (err) {
    select.innerHTML = `<option value="">Could not load roster: ${err.message}</option>`;
  }
}

// --- Calendar ---
function hasCapacityConflict(rows, capacity) {
  if (!isFinite(capacity)) return false;
  const events = [];
  rows.forEach((r) => {
    const start = parseTimeMinutes(r['Start Time']);
    const end = parseTimeMinutes(r['End Time']);
    if (start == null || end == null) return;
    events.push([start, 1]);
    events.push([end, -1]);
  });
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let count = 0;
  for (const [, delta] of events) {
    count += delta;
    if (count > capacity) return true;
  }
  return false;
}

function renderChip(row) {
  const isManual = row['Source'] === 'Manual';
  const chip = document.createElement('div');
  chip.className = `chip${isManual ? ' chip-manual' : ''}`;
  chip.innerHTML = `
    <div class="chip-name">${row['Student Name'] || ''}</div>
    <div class="chip-time">${row['Start Time'] || ''} - ${row['End Time'] || ''}</div>
    ${row['Notes'] ? `<div class="chip-reason">${row['Notes']}</div>` : ''}
    <div class="chip-actions">
      <button type="button" class="edit-chip-btn">Edit</button>
      <button type="button" class="delete-chip-btn">Delete</button>
    </div>
  `;
  chip.querySelector('.edit-chip-btn').addEventListener('click', () => startEditShift(row));
  chip.querySelector('.delete-chip-btn').addEventListener('click', () => deleteShift(row));
  return chip;
}

async function loadCalendar() {
  const semester = document.getElementById('calendar-semester-input').value.trim();
  if (!semester) return;
  try {
    currentWorkScheduleRows = await api.getWorkSchedule(semester);
  } catch (err) {
    alert(`Could not load the schedule: ${err.message}`);
    return;
  }

  LOCATIONS.forEach((location) => {
    const rowEl = document.querySelector(`#calendar-table tr[data-location="${location}"]`);
    DAYS.forEach((day) => {
      const cell = rowEl.querySelector(`td[data-day="${day}"]`);
      cell.innerHTML = '';
      const rows = currentWorkScheduleRows
        .filter((r) => r['Location'] === location && r['Day'] === day)
        .sort((a, b) => (parseTimeMinutes(a['Start Time']) || 0) - (parseTimeMinutes(b['Start Time']) || 0));
      rows.forEach((row) => cell.appendChild(renderChip(row)));
      cell.classList.toggle('cell-conflict', hasCapacityConflict(rows, SEAT_CAPACITY[location]));
    });
  });

  renderWeeklyHours();
}

// --- Export to Excel ---
// Excel opens CSV natively, so this needs no extra library or build step -
// consistent with the rest of this frontend. A leading BOM tells Excel the
// file is UTF-8 so accented names/notes don't get garbled on open.
function csvEscape(value) {
  const text = value == null ? '' : String(value);
  return /["\n,]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function exportScheduleToExcel() {
  if (currentWorkScheduleRows.length === 0) {
    alert('No schedule loaded to export. Load a semester on the calendar above first.');
    return;
  }

  const dayOrder = { Monday: 0, Tuesday: 1, Wednesday: 2, Thursday: 3, Friday: 4 };
  const sortedRows = [...currentWorkScheduleRows].sort((a, b) => {
    const dayDiff = (dayOrder[a['Day']] ?? 5) - (dayOrder[b['Day']] ?? 5);
    if (dayDiff !== 0) return dayDiff;
    const locDiff = (a['Location'] || '').localeCompare(b['Location'] || '');
    if (locDiff !== 0) return locDiff;
    return (parseTimeMinutes(a['Start Time']) || 0) - (parseTimeMinutes(b['Start Time']) || 0);
  });

  const header = ['Student Name', 'Day', 'Location', 'Start Time', 'End Time', 'Semester', 'Source', 'Notes'];
  const lines = [header.join(',')];
  sortedRows.forEach((row) => {
    lines.push(
      header.map((col) => csvEscape(row[col])).join(',')
    );
  });

  const semester = document.getElementById('calendar-semester-input').value.trim() || 'schedule';
  const filename = `work-schedule-${semester.replace(/\s+/g, '-')}.csv`;
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// --- Weekly hours summary ---
function renderWeeklyHours() {
  const tbody = document.querySelector('#weekly-hours-table tbody');
  const emptyMsg = document.getElementById('weekly-hours-empty');
  const totals = new Map();
  currentWorkScheduleRows.forEach((row) => {
    const start = parseTimeMinutes(row['Start Time']);
    const end = parseTimeMinutes(row['End Time']);
    if (start == null || end == null) return;
    const name = row['Student Name'];
    // A full 8-5 day includes an unpaid lunch hour - only 8 hours count.
    // Detected from the times themselves (not the Notes text) so this holds
    // for manually added/edited shifts too, not just generator output.
    const isLunchDay = row['Start Time'] === '8:00 AM' && row['End Time'] === '5:00 PM';
    const workedMinutes = end - start - (isLunchDay ? 60 : 0);
    totals.set(name, (totals.get(name) || 0) + workedMinutes);
  });

  const entries = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  tbody.innerHTML = '';
  emptyMsg.hidden = entries.length > 0;
  entries.forEach(([name, minutes]) => {
    const hours = (minutes / 60).toFixed(1);
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${name}</td><td>${hours}</td>`;
    tbody.appendChild(tr);
  });
}

// --- Class Schedule (read-only reference, straight from Class Schedule -
// not editable here, students manage their own via the student portal) ---
async function loadClassScheduleView() {
  const tbody = document.querySelector('#class-schedule-table tbody');
  try {
    const [roster, classRows] = await Promise.all([api.getStudentsRoster(), api.getAllClassSchedule()]);
    const roleOrder = { 'Front Desk': 0, 'Back Office': 1, Floater: 2 };
    const active = roster
      .filter((s) => s.active)
      .sort((a, b) => {
        const roleDiff = (roleOrder[a.role] ?? 3) - (roleOrder[b.role] ?? 3);
        if (roleDiff !== 0) return roleDiff;
        const locDiff = (a.primaryLocation || '').localeCompare(b.primaryLocation || '');
        if (locDiff !== 0) return locDiff;
        return a.name.localeCompare(b.name);
      });

    tbody.innerHTML = '';
    active.forEach((student) => {
      const tr = document.createElement('tr');
      const nameTd = document.createElement('td');
      nameTd.innerHTML = `<strong>${student.name}</strong><br><span class="hint">${student.role}${student.primaryLocation ? ' - ' + student.primaryLocation : ''}</span>`;
      tr.appendChild(nameTd);

      DAYS.forEach((day) => {
        const td = document.createElement('td');
        const rows = classRows
          .filter((r) => r['Student Name'] === student.name && r['Day'] === day)
          .sort((a, b) => (parseTimeMinutes(a['Start Time']) || 0) - (parseTimeMinutes(b['Start Time']) || 0));
        rows.forEach((row) => {
          const chip = document.createElement('div');
          chip.className = 'chip chip-class';
          chip.innerHTML = `
            <div class="chip-time">${row['Start Time'] || ''} - ${row['End Time'] || ''}</div>
            ${row['Course/Notes'] ? `<div class="chip-reason">${row['Course/Notes']}</div>` : ''}
          `;
          td.appendChild(chip);
        });
        tr.appendChild(td);
      });

      tbody.appendChild(tr);
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6">Could not load class schedule: ${err.message}</td></tr>`;
  }
}

// --- Generate ---
async function handleGenerate() {
  const semester = document.getElementById('semester-input').value.trim();
  const asOfDate = document.getElementById('asof-input').value;
  const statusEl = document.getElementById('generate-status');
  const gapsPanel = document.getElementById('gaps-panel');
  const gapsList = document.getElementById('gaps-list');
  const btn = document.getElementById('generate-btn');

  if (!semester) {
    showStatus(statusEl, 'Semester is required.', 'error');
    return;
  }

  btn.disabled = true;
  showStatus(statusEl, 'Generating...', 'status');
  gapsPanel.hidden = true;

  try {
    const result = await api.generateSchedule(semester, asOfDate || undefined);
    showStatus(
      statusEl,
      `Added ${result.added} generated rows, removed ${result.removed} previous generated rows.` +
        (result.warnings.length ? ` Warnings: ${result.warnings.join(' ')}` : ''),
      'success'
    );
    if (result.gaps.length) {
      gapsList.innerHTML = result.gaps
        .map((g) => `<li>${g.day} - ${g.location}: ${g.start} - ${g.end} uncovered</li>`)
        .join('');
      gapsPanel.hidden = false;
    }
    document.getElementById('calendar-semester-input').value = semester;
    await loadCalendar();
  } catch (err) {
    showStatus(statusEl, `Generate failed: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
}

// --- Add / Edit shift form ---
function resetShiftForm() {
  document.getElementById('shift-rowid').value = '';
  document.getElementById('shift-form-title').textContent = 'Add Shift (Manual)';
  document.getElementById('shift-submit-btn').textContent = 'Add shift';
  document.getElementById('shift-cancel-btn').hidden = true;
  document.getElementById('shift-form').reset();
  document.getElementById('shift-semester').value = document.getElementById('calendar-semester-input').value;
}

function startEditShift(row) {
  document.getElementById('shift-rowid').value = row.rowId;
  document.getElementById('shift-form-title').textContent = `Edit Shift - ${row['Student Name']}`;
  document.getElementById('shift-submit-btn').textContent = 'Save changes';
  document.getElementById('shift-cancel-btn').hidden = false;
  document.getElementById('shift-student').value = row['Student Name'];
  document.getElementById('shift-day').value = row['Day'];
  document.getElementById('shift-location').value = row['Location'];
  document.getElementById('shift-start').value = to24Hour(row['Start Time']);
  document.getElementById('shift-end').value = to24Hour(row['End Time']);
  document.getElementById('shift-semester').value = row['Semester'];
  document.getElementById('shift-notes').value = row['Notes'] || '';
  document.getElementById('shift-form-panel').scrollIntoView({ behavior: 'smooth' });
}

async function deleteShift(row) {
  if (!confirm(`Delete ${row['Student Name']}'s ${row['Day']} ${row['Location']} shift?`)) return;
  try {
    await api.deleteWorkScheduleRow(row.rowId);
    await loadCalendar();
  } catch (err) {
    alert(`Could not delete shift: ${err.message}`);
  }
}

async function handleShiftFormSubmit(e) {
  e.preventDefault();
  const statusEl = document.getElementById('shift-form-status');
  const rowId = document.getElementById('shift-rowid').value;
  const payload = {
    studentName: document.getElementById('shift-student').value,
    day: document.getElementById('shift-day').value,
    location: document.getElementById('shift-location').value,
    startTime: to12Hour(document.getElementById('shift-start').value),
    endTime: to12Hour(document.getElementById('shift-end').value),
    semester: document.getElementById('shift-semester').value,
    notes: document.getElementById('shift-notes').value,
  };

  try {
    if (rowId) {
      await api.updateWorkScheduleRow(rowId, payload);
      showStatus(statusEl, 'Shift updated.', 'success');
    } else {
      await api.addWorkScheduleRow(payload);
      showStatus(statusEl, 'Shift added.', 'success');
    }
    resetShiftForm();
    document.getElementById('calendar-semester-input').value = payload.semester;
    await loadCalendar();
  } catch (err) {
    showStatus(statusEl, `Could not save shift: ${err.message}`, 'error');
  }
}

// --- Pending time off ---
async function loadPendingTimeOff() {
  const tbody = document.querySelector('#time-off-table tbody');
  const emptyMsg = document.getElementById('time-off-empty');
  try {
    const rows = await api.getTimeOff();
    const pending = rows.filter((r) => r['Status'] === 'Pending');
    tbody.innerHTML = '';
    emptyMsg.hidden = pending.length > 0;
    pending.forEach((row) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${row['Student Name'] || ''}</td>
        <td>${row['Start Date'] || ''}</td>
        <td>${row['End Date'] || ''}</td>
        <td>${row['Reason'] || ''}</td>
        <td>${row['Submitted Date'] || ''}</td>
        <td>
          <button type="button" class="approve-btn">Approve</button>
          <button type="button" class="deny-btn">Deny</button>
        </td>
      `;
      tr.querySelector('.approve-btn').addEventListener('click', () => setTimeOffStatus(row.rowId, 'Approved'));
      tr.querySelector('.deny-btn').addEventListener('click', () => setTimeOffStatus(row.rowId, 'Denied'));
      tbody.appendChild(tr);
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6">Could not load time-off requests: ${err.message}</td></tr>`;
  }
}

async function setTimeOffStatus(rowId, status) {
  try {
    await api.setTimeOffStatus(rowId, status);
    await loadPendingTimeOff();
  } catch (err) {
    alert(`Could not update request: ${err.message}`);
  }
}

// --- Init ---
document.getElementById('generate-btn').addEventListener('click', handleGenerate);
document.getElementById('refresh-calendar-btn').addEventListener('click', loadCalendar);
document.getElementById('export-excel-btn').addEventListener('click', exportScheduleToExcel);
document.getElementById('refresh-class-schedule-btn').addEventListener('click', loadClassScheduleView);
document.getElementById('shift-form').addEventListener('submit', handleShiftFormSubmit);
document.getElementById('shift-cancel-btn').addEventListener('click', resetShiftForm);
document.getElementById('asof-input').valueAsDate = new Date();

loadRoster();
loadCalendar();
loadClassScheduleView();
loadPendingTimeOff();
