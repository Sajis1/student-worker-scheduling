// No login here either (same accepted Phase 1 tradeoff as the student portal).

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
// Short labels for the Excel export's day column only - the full names in
// DAYS are still what's used everywhere data is looked up/matched.
const DAY_LABEL = { Monday: 'Mon', Tuesday: 'Tue', Wednesday: 'Wed', Thursday: 'Thu', Friday: 'Fri' };
const LOCATIONS = ['S700', 'TLS', 'S701', 'Back Office'];
const SEAT_CAPACITY = { S700: 2, TLS: 1, S701: 1, 'Back Office': Infinity };

let currentWorkScheduleRows = [];
let currentRoster = []; // [{name, role, primaryLocation, active, maxHours, extension, phone}] - populated by loadRoster(), reused by the Excel export to split by Role
let currentSupervisors = []; // [{name, phone}] - populated by loadSupervisors(), shown at the bottom of both Excel export boxes
let currentClassScheduleRows = []; // raw Class Schedule rows - populated by loadClassScheduleView(), reused by the Excel export to look up Expected Grad

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
    currentRoster = roster;
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

// Shared contact list (Supervisors sheet) shown identically at the bottom of
// both Excel export boxes - failing silently (empty list) is fine here since
// it's a bonus contact block, not something that should block the export.
async function loadSupervisors() {
  try {
    currentSupervisors = await api.getSupervisors();
  } catch (err) {
    currentSupervisors = [];
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
    appAlert(`Could not load the schedule: ${err.message}`);
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

// --- Copy for Excel ---
// Grid layout (students as columns, days as rows) modeled after the PMO's
// existing hand-kept schedule sheet, split into two side-by-side boxes -
// Front Desk in one, Floater/Back Office in the other - same split the PMO
// already uses on paper. Built as a single (non-nested) table with a blank
// spacer column between the two groups: Excel reads the pasted HTML as
// plain adjacent columns, so the two boxes land side by side exactly as
// laid out here, no nested-table quirks to worry about.
//
// There's no file-download version of this anymore: downloads are blocked
// entirely inside a restrictive iframe sandbox (confirmed by testing - a
// real server-side Content-Disposition download gets blocked identically
// to a blob download, with no `allow-downloads` on the sandbox), which is
// exactly the situation this dashboard runs in when embedded in a Teams
// tab. `document.execCommand('copy')` on a real user-gesture click still
// works there even though downloads and the modern Clipboard API don't, so
// copy-to-clipboard is the one export path that works everywhere this
// dashboard gets used - a browser tab or an embedded Teams tab alike.
const LOCATION_MARKER = { S701: '*', TLS: '^', S700: 'F', 'Back Office': 'BO' };
// Single-quoted font names: the table's own style attribute is double-quoted,
// so double-quoting these too would prematurely close it and corrupt the
// markup (caught by testing the actual clipboard HTML, not just the visible
// rendering, which looked fine despite the broken attribute underneath).
const EXPORT_FONT_STACK = "'Aptos','Segoe UI',Calibri,Arial,sans-serif";

function compactTime(text) {
  const match = String(text || '').trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return text || '';
  const [, h, m] = match;
  return m === '00' ? h : `${h}:${m}`;
}

// Compact form for the Grad row, e.g. "Spring 2027" -> "Spr27", "Summer II
// 2026" -> "Sum26" (both summer sessions collapse to the same "Sum" since
// the reference card doesn't distinguish I/II here). "Temp" (a temp/
// undetermined worker) passes through unchanged. Anything that doesn't
// match a recognized term falls back to the raw typed value rather than
// hiding it, since a manager's free-typed entry is still useful as-is.
function abbreviateExpectedGrad(value) {
  if (!value) return '';
  const text = String(value).trim();
  if (/^temp$/i.test(text)) return 'Temp';
  const match = text.match(/^(Spring|Summer\s*I{1,2}|Summer|Fall|Winter)\s+(\d{4})$/i);
  if (!match) return text;
  const [, term, year] = match;
  const abbrevByTerm = { spring: 'Spr', summer: 'Sum', fall: 'Fall', winter: 'Win' };
  const termKey = term.toLowerCase().replace(/\s*i{1,2}$/, '').trim();
  return `${abbrevByTerm[termKey] || term}${year.slice(-2)}`;
}

function htmlEscape(value) {
  const text = value == null ? '' : String(value);
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function weeklyHoursByStudent(rows) {
  const totals = new Map();
  rows.forEach((row) => {
    const start = parseTimeMinutes(row['Start Time']);
    const end = parseTimeMinutes(row['End Time']);
    if (start == null || end == null) return;
    const isLunchDay = row['Start Time'] === '8:00 AM' && row['End Time'] === '5:00 PM';
    const workedMinutes = end - start - (isLunchDay ? 60 : 0);
    totals.set(row['Student Name'], (totals.get(row['Student Name']) || 0) + workedMinutes);
  });
  return totals;
}

// Front Desk gets its own box; Floater and Back Office share the other one
// (and anyone with an unrecognized/blank Role falls in there too, rather
// than silently vanishing from the export).
function splitStudentsByRole(students) {
  const roleByName = new Map(currentRoster.map((s) => [s.name, s.role]));
  const frontDesk = [];
  const other = [];
  students.forEach((name) => {
    (roleByName.get(name) === 'Front Desk' ? frontDesk : other).push(name);
  });
  return { frontDesk, other };
}

// Builds just the <table> markup for the clipboard copy - returns null if
// there's nothing to show.
function buildScheduleTableHtml() {
  if (currentWorkScheduleRows.length === 0) return null;

  // Pulled fresh from the "Viewing semester" field every time this is
  // built (not cached anywhere) - so the header always reflects whatever
  // semester is currently on screen, with no separate place to update it.
  const semester = document.getElementById('calendar-semester-input').value.trim() || 'Schedule';
  const totals = weeklyHoursByStudent(currentWorkScheduleRows);
  // Same order as the Weekly Hours panel above (most hours first) within
  // each box, so the export reads consistently with what's already on screen.
  const allStudents = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
  const { frontDesk, other } = splitStudentsByRole(allStudents);
  // Keep the two boxes reasonably even rather than strictly by role: if
  // Front Desk has more than one extra student compared to the other box,
  // shift its lowest-hours student(s) over until they're within one of
  // each other - purely a print/layout balance, doesn't change anyone's
  // actual role or schedule.
  const byHoursDesc = (a, b) => (totals.get(b) || 0) - (totals.get(a) || 0);
  while (frontDesk.length - other.length > 1) {
    other.push(frontDesk.pop()); // frontDesk is hours-descending, so pop() takes its lowest-hours student
  }
  frontDesk.sort(byHoursDesc);
  other.sort(byHoursDesc);
  const groups = [{ students: frontDesk }, { students: other }].filter((g) => g.students.length > 0);
  if (groups.length === 0) return null;

  const byStudentDay = new Map(); // "name|day" -> [{Location,Start,End}]
  currentWorkScheduleRows.forEach((row) => {
    const key = `${row['Student Name']}|${row['Day']}`;
    if (!byStudentDay.has(key)) byStudentDay.set(key, []);
    byStudentDay.get(key).push(row);
  });
  const cellFor = (name, day) =>
    (byStudentDay.get(`${name}|${day}`) || [])
      .sort((a, b) => (parseTimeMinutes(a['Start Time']) || 0) - (parseTimeMinutes(b['Start Time']) || 0))
      .map((row) => {
        const marker = LOCATION_MARKER[row['Location']] || '';
        return `${compactTime(row['Start Time'])}-${compactTime(row['End Time'])}${marker ? ' ' + marker : ''}`;
      })
      .join('<br>');

  const th = 'style="background:#1F3864;color:#fff;font-weight:bold;text-align:center;border:1px solid #999;padding:5px 10px;"';
  const dayLabelTd = 'style="background:#D9E1F2;font-weight:bold;text-align:center;border:1px solid #999;padding:5px 10px;white-space:nowrap;"';
  const cellTd = 'style="text-align:center;border:1px solid #999;padding:5px 10px;white-space:nowrap;"';
  const totalTd = 'style="background:#D9E1F2;font-weight:bold;text-align:center;border:1px solid #999;padding:5px 10px;"';
  const spacerTd = '<td style="border:none;background:transparent;width:28px;"></td>';

  const totalCols = groups.reduce((sum, g) => sum + g.students.length + 1, 0) + (groups.length - 1);
  // One combined header spanning both boxes, instead of a separate title
  // per box - the semester comes straight from the field read above, so
  // changing "Viewing semester" and copying again always relabels this
  // automatically.
  const infoFor = (name) => currentRoster.find((s) => s.name === name) || {};
  // Expected Grad lives on Class Schedule (students fill it in themselves,
  // one class block at a time), not Student Master - a student can have
  // several rows, so this just takes the first non-blank value found.
  const expectedGradFor = (name) => {
    const row = currentClassScheduleRows.find((r) => r['Student Name'] === name && r['Expected Grad']);
    return row ? row['Expected Grad'] : '';
  };

  // Each box gets its own title bar (not one bar spanning the gap between
  // them) - same per-group-colspan pattern as the contact/supervisor rows,
  // so the two boxes read as genuinely separate, not one connected table.
  const titleRow = `<tr>${groups
    .map((g, i) => {
      const groupColspan = g.students.length + 1;
      return `${i > 0 ? spacerTd : ''}<td colspan="${groupColspan}" style="background:#1F3864;color:#fff;font-weight:bold;text-align:center;font-size:14pt;padding:8px;">PMO Student Worker Schedule &mdash; ${htmlEscape(semester)}</td>`;
    })
    .join('')}</tr>`;
  const headerRow = `<tr>${groups
    .map((g, i) => `${i > 0 ? spacerTd : ''}<td ${th}></td>${g.students.map((name) => `<td ${th}>${htmlEscape(name)}</td>`).join('')}`)
    .join('')}</tr>`;
  const extRow = `<tr>${groups
    .map(
      (g, i) =>
        `${i > 0 ? spacerTd : ''}<td ${dayLabelTd}>Ext.</td>${g.students
          .map((name) => `<td ${cellTd}>${htmlEscape(infoFor(name).extension || '')}</td>`)
          .join('')}`
    )
    .join('')}</tr>`;
  const dayRows = DAYS.map(
    (day) =>
      `<tr>${groups
        .map(
          (g, i) =>
            `${i > 0 ? spacerTd : ''}<td ${dayLabelTd}>${DAY_LABEL[day]}</td>${g.students
              .map((name) => `<td ${cellTd}>${cellFor(name, day)}</td>`)
              .join('')}`
        )
        .join('')}</tr>`
  ).join('');
  // Total Hrs and Grad are two separate rows, one value per cell - matches
  // the rest of the table's one-value-per-cell style instead of stacking
  // both values in a single cell with a line break.
  const hoursRow = `<tr>${groups
    .map(
      (g, i) =>
        `${i > 0 ? spacerTd : ''}<td ${totalTd}>Total Hrs</td>${g.students
          .map((name) => `<td ${totalTd}>${(Math.round((totals.get(name) || 0) / 6) / 10).toFixed(1).replace(/\.0$/, '')}</td>`)
          .join('')}`
    )
    .join('')}</tr>`;
  const gradRow = `<tr>${groups
    .map(
      (g, i) =>
        `${i > 0 ? spacerTd : ''}<td ${totalTd}>Grad</td>${g.students
          .map((name) => `<td ${totalTd}>${htmlEscape(abbreviateExpectedGrad(expectedGradFor(name)))}</td>`)
          .join('')}`
    )
    .join('')}</tr>`;

  // Per-student contact list, one row per student, each spanning just its
  // own box's width - boxes with different student counts just end early on
  // the shorter side rather than needing filler.
  const maxContactRows = Math.max(0, ...groups.map((g) => g.students.length));
  const contactRows = Array.from({ length: maxContactRows }, (_, rowIndex) =>
    `<tr>${groups
      .map((g, i) => {
        const groupColspan = g.students.length + 1;
        const name = g.students[rowIndex];
        const cellHtml = name ? `${htmlEscape(name)}: ${htmlEscape(infoFor(name).phone || '')}` : '';
        return `${i > 0 ? spacerTd : ''}<td colspan="${groupColspan}" style="border:1px solid #999;padding:4px 10px;">${cellHtml}</td>`;
      })
      .join('')}</tr>`
  ).join('');

  // Same legend text repeated under each box separately, not one row
  // spanning the gap between them - same reasoning as the title bar above.
  const legendRow = `<tr>${groups
    .map((g, i) => {
      const groupColspan = g.students.length + 1;
      return `${i > 0 ? spacerTd : ''}<td colspan="${groupColspan}" style="border:1px solid #999;padding:5px 10px;">* = S701&nbsp;&nbsp;&nbsp;^ = TLS&nbsp;&nbsp;&nbsp;F = S700&nbsp;&nbsp;&nbsp;BO = Back Office</td>`;
    })
    .join('')}</tr>`;

  // Same shared contact list (Supervisors sheet) repeated under both boxes,
  // matching the reference card - not per-student data, so every group's
  // cell shows the same supervisor for a given row.
  const supervisorRows = currentSupervisors
    .map(
      (sup) =>
        `<tr>${groups
          .map((g, i) => {
            const groupColspan = g.students.length + 1;
            return `${i > 0 ? spacerTd : ''}<td colspan="${groupColspan}" style="border:1px solid #999;padding:4px 10px;">${htmlEscape(sup.name)}: ${htmlEscape(sup.phone || '')}</td>`;
          })
          .join('')}</tr>`
    )
    .join('');

  const updatedRow = `<tr><td colspan="${totalCols}" style="border:1px solid #999;padding:5px 10px;text-align:right;font-style:italic;">Last Updated: ${new Date().toLocaleDateString()}</td></tr>`;

  return `<table style="border-collapse:collapse;font-family:${EXPORT_FONT_STACK};font-size:11pt;">
${titleRow}
${headerRow}
${extRow}
${dayRows}
${hoursRow}
${gradRow}
<tr><td colspan="${totalCols}" style="border:none;padding:4px;"></td></tr>
${contactRows}
${legendRow}
${supervisorRows}
${updatedRow}
</table>`;
}

// document.execCommand('copy') on a real user-gesture click works even
// inside a restrictive iframe sandbox that blocks downloads outright (see
// note above) - this selects an off-screen copy of the table and copies it
// as rich HTML, so pasting into a blank Excel sheet (Ctrl+V) reconstructs
// the grid/colors the same way copying any webpage table into Excel does.
function copyScheduleForExcel() {
  const tableHtml = buildScheduleTableHtml();
  const statusEl = document.getElementById('export-copy-status');
  if (!tableHtml) {
    appAlert('No schedule loaded to copy. Load a semester on the calendar above first.');
    return;
  }

  const container = document.createElement('div');
  container.style.position = 'fixed';
  container.style.left = '-99999px';
  container.style.top = '0';
  container.innerHTML = tableHtml;
  document.body.appendChild(container);

  const range = document.createRange();
  range.selectNode(container);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);

  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch (err) {
    copied = false;
  }
  selection.removeAllRanges();
  document.body.removeChild(container);

  if (statusEl) {
    showStatus(
      statusEl,
      copied ? 'Copied! Paste into a blank Excel sheet with Ctrl+V.' : 'Copy failed - please try again.',
      copied ? 'success' : 'error'
    );
  }
}

// --- Weekly hours summary ---
// A full 8-5 day includes an unpaid lunch hour - only 8 hours count. Detected
// from the times themselves (not the Notes text) so this holds for manually
// added/edited shifts too, not just generator output.
function workedMinutesForShift(startTime, endTime) {
  const start = parseTimeMinutes(startTime);
  const end = parseTimeMinutes(endTime);
  if (start == null || end == null) return 0;
  const isLunchDay = startTime === '8:00 AM' && endTime === '5:00 PM';
  return end - start - (isLunchDay ? 60 : 0);
}

// Each student's cap comes from their own Max Hours (Student Master),
// defaulting to 20 when blank/0/non-numeric - same fallback the generator
// itself uses, so this always reflects the cap that actually applied.
function capHoursFor(name) {
  const raw = Number((currentRoster.find((s) => s.name === name) || {}).maxHours);
  return Number.isFinite(raw) && raw > 0 ? raw : 20;
}

function renderWeeklyHours() {
  const tbody = document.querySelector('#weekly-hours-table tbody');
  const emptyMsg = document.getElementById('weekly-hours-empty');
  const totals = new Map();
  currentWorkScheduleRows.forEach((row) => {
    const workedMinutes = workedMinutesForShift(row['Start Time'], row['End Time']);
    if (!workedMinutes) return;
    const name = row['Student Name'];
    totals.set(name, (totals.get(name) || 0) + workedMinutes);
  });

  const entries = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  tbody.innerHTML = '';
  emptyMsg.hidden = entries.length > 0;
  entries.forEach(([name, minutes]) => {
    const hours = (minutes / 60).toFixed(1);
    const capHours = capHoursFor(name);
    const pct = Math.min(100, (minutes / (capHours * 60)) * 100);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${name}</td>
      <td>
        <div class="hours-bar-track"><div class="hours-bar-fill" style="width:${pct}%"></div></div>
        <span class="hours-bar-label">${hours} / ${capHours}</span>
      </td>`;
    tbody.appendChild(tr);
  });
}

// --- Class Schedule (read-only reference, straight from Class Schedule -
// not editable here, students manage their own via the student portal) ---
async function loadClassScheduleView() {
  const tbody = document.querySelector('#class-schedule-table tbody');
  try {
    const [roster, classRows] = await Promise.all([api.getStudentsRoster(), api.getAllClassSchedule()]);
    currentClassScheduleRows = classRows;
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
// UHD's five terms in chronological order within a year, with the calendar
// month (0-11) each one starts. Winter starts in December and is labeled
// with the year it starts in, same convention "Fall 2026" already uses
// spanning into December.
const SEMESTER_TERMS = [
  { name: 'Spring', startMonth: 0 },
  { name: 'Summer I', startMonth: 5 },
  { name: 'Summer II', startMonth: 6 },
  { name: 'Fall', startMonth: 8 },
  { name: 'Winter', startMonth: 11 },
];

// The current term plus the next 2 (3 total), looking up to two years ahead
// so the window never runs dry near a year boundary. A term counts as "not
// yet passed" as long as the next term in the sequence hasn't started yet -
// so today (July 2026, mid-Summer II) yields ["Summer II 2026", "Fall 2026",
// "Winter 2026"], with Spring/Summer I 2026 already excluded.
function currentSemesterOptions() {
  const now = new Date();
  const todayKey = now.getFullYear() * 12 + now.getMonth();
  const options = [];
  for (const year of [now.getFullYear(), now.getFullYear() + 1]) {
    SEMESTER_TERMS.forEach((term, i) => {
      const key = year * 12 + term.startMonth;
      const next = SEMESTER_TERMS[i + 1];
      const nextKey = next ? year * 12 + next.startMonth : (year + 1) * 12 + SEMESTER_TERMS[0].startMonth;
      if (nextKey > todayKey) options.push({ key, label: `${term.name} ${year}` });
    });
  }
  return options
    .sort((a, b) => a.key - b.key)
    .slice(0, 3)
    .map((o) => o.label);
}

// Rebuilds the semester dropdown's options and selects selectedValue. If
// selectedValue isn't one of the upcoming three (e.g. editing an older
// shift from a past/future semester), it's added as an extra option so it
// displays correctly instead of silently landing on the wrong semester.
function fillSemesterSelect(selectEl, selectedValue) {
  const options = currentSemesterOptions();
  if (selectedValue && !options.includes(selectedValue)) options.unshift(selectedValue);
  selectEl.innerHTML = options.map((s) => `<option value="${htmlEscape(s)}">${htmlEscape(s)}</option>`).join('');
  if (selectedValue) selectEl.value = selectedValue;
}

function resetShiftForm() {
  document.getElementById('shift-rowid').value = '';
  document.getElementById('shift-form-title').textContent = 'Add Shift (Manual)';
  document.getElementById('shift-submit-btn').textContent = 'Add shift';
  document.getElementById('shift-cancel-btn').hidden = true;
  document.getElementById('shift-form').reset();
  fillSemesterSelect(document.getElementById('shift-semester'), document.getElementById('calendar-semester-input').value);
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
  fillSemesterSelect(document.getElementById('shift-semester'), row['Semester']);
  document.getElementById('shift-notes').value = row['Notes'] || '';
  document.getElementById('shift-form-panel').scrollIntoView({ behavior: 'smooth' });
}

async function deleteShift(row) {
  if (!(await appConfirm(`Delete ${row['Student Name']}'s ${row['Day']} ${row['Location']} shift?`))) return;
  try {
    await api.deleteWorkScheduleRow(row.rowId);
    await loadCalendar();
  } catch (err) {
    appAlert(`Could not delete shift: ${err.message}`);
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

  // Warn (but don't block) if this shift would push the student over their
  // own weekly cap - manual overrides are allowed to exceed it on purpose
  // (e.g. covering someone on time off), but the manager should see that
  // red flag before confirming, not discover it later.
  const workedMinutes = currentWorkScheduleRows
    .filter((r) => r['Student Name'] === payload.studentName && r['Semester'] === payload.semester)
    .filter((r) => !rowId || String(r.rowId) !== String(rowId))
    .reduce((sum, r) => sum + workedMinutesForShift(r['Start Time'], r['End Time']), 0);
  const projectedHours = (workedMinutes + workedMinutesForShift(payload.startTime, payload.endTime)) / 60;
  const capHours = capHoursFor(payload.studentName);
  if (projectedHours > capHours) {
    const proceed = await appConfirm(
      `⚠ This will put ${payload.studentName} at ${projectedHours.toFixed(1)} hrs this week - over their ${capHours} hr cap. Add it anyway?`,
      'warning'
    );
    if (!proceed) return;
  }

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
    appAlert(`Could not update request: ${err.message}`);
  }
}

// --- Init ---
document.getElementById('generate-btn').addEventListener('click', handleGenerate);
document.getElementById('refresh-calendar-btn').addEventListener('click', loadCalendar);
document.getElementById('copy-excel-btn').addEventListener('click', copyScheduleForExcel);
document.getElementById('refresh-class-schedule-btn').addEventListener('click', loadClassScheduleView);
document.getElementById('shift-form').addEventListener('submit', handleShiftFormSubmit);
document.getElementById('shift-cancel-btn').addEventListener('click', resetShiftForm);
document.getElementById('asof-input').valueAsDate = new Date();
fillSemesterSelect(document.getElementById('shift-semester'), document.getElementById('calendar-semester-input').value);

loadRoster();
loadSupervisors();
loadCalendar();
loadClassScheduleView();
loadPendingTimeOff();
