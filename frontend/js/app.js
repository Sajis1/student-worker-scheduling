// No login system in Phase 1: the "signed in" student is just a name held in
// sessionStorage after being picked from the Student Master dropdown.
const STORAGE_KEY = 'uhd-student-worker-name';

const pickerSection = document.getElementById('picker-section');
const portalSection = document.getElementById('portal-section');
const studentSelect = document.getElementById('student-select');
const continueBtn = document.getElementById('continue-btn');
const pickerError = document.getElementById('picker-error');
const currentStudentBanner = document.getElementById('current-student');
const currentStudentName = document.getElementById('current-student-name');
const switchStudentBtn = document.getElementById('switch-student-btn');

let currentStudents = []; // [{name, studentId, email}] - populated by loadStudents(), used to look up the signed-in student's email for time-off submissions

function showError(el, message) {
  el.textContent = message;
  el.hidden = false;
}

function hideError(el) {
  el.hidden = true;
}

async function loadStudents() {
  try {
    const students = await api.getStudents();
    currentStudents = students;
    studentSelect.innerHTML = '<option value="">Select your name</option>';
    students.forEach((student) => {
      const opt = document.createElement('option');
      opt.value = student.name;
      opt.textContent = student.name;
      studentSelect.appendChild(opt);
    });
    continueBtn.disabled = false;
  } catch (err) {
    studentSelect.innerHTML = '<option value="">Unable to load students</option>';
    showError(pickerError, `Could not load student list: ${err.message}`);
  }
}

function setActiveStudent(name) {
  sessionStorage.setItem(STORAGE_KEY, name);
  currentStudentName.textContent = name;
  currentStudentBanner.hidden = false;
  pickerSection.hidden = true;
  portalSection.hidden = false;
  refreshClassSchedule();
  refreshTimeOff();
}

function clearActiveStudent() {
  sessionStorage.removeItem(STORAGE_KEY);
  currentStudentBanner.hidden = true;
  portalSection.hidden = true;
  pickerSection.hidden = false;
}

continueBtn.addEventListener('click', () => {
  hideError(pickerError);
  const name = studentSelect.value;
  if (!name) {
    showError(pickerError, 'Please select your name first.');
    return;
  }
  setActiveStudent(name);
});

switchStudentBtn.addEventListener('click', clearActiveStudent);

// --- Tabs ---
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => (p.hidden = true));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).hidden = false;
  });
});

// --- Class schedule ---
const classScheduleForm = document.getElementById('class-schedule-form');
const classScheduleStatus = document.getElementById('class-schedule-status');
const classScheduleTableBody = document.querySelector('#class-schedule-table tbody');

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

async function refreshClassSchedule() {
  const studentName = sessionStorage.getItem(STORAGE_KEY);
  try {
    const rows = await api.getClassSchedule(studentName);
    classScheduleTableBody.innerHTML = '';
    rows.forEach((row) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${row['Day'] || ''}</td>
        <td>${row['Start Time'] || ''}</td>
        <td>${row['End Time'] || ''}</td>
        <td>${row['Semester'] || ''}</td>
        <td>${row['Expected Grad'] || ''}</td>
        <td class="row-actions">
          <button type="button" class="edit-class-btn">Edit</button>
          <button type="button" class="duplicate-class-btn">Duplicate</button>
          <button type="button" class="delete-class-btn">Delete</button>
        </td>
      `;
      tr.querySelector('.edit-class-btn').addEventListener('click', () => startEditClass(row));
      tr.querySelector('.duplicate-class-btn').addEventListener('click', () => duplicateClass(row));
      tr.querySelector('.delete-class-btn').addEventListener('click', () => deleteClassScheduleEntry(row.rowId));
      classScheduleTableBody.appendChild(tr);
    });
  } catch (err) {
    showStatus(classScheduleStatus, `Could not load your unavailable schedule: ${err.message}`, 'error');
  }
}

// UHD's five terms in chronological order within a year, with the calendar
// month (0-11) each one starts - month-only on purpose, since exact
// first-class-days shift slightly every year and aren't worth chasing here.
// Winter starts in December and is labeled with the year it starts in, same
// convention "Fall 2026" already uses spanning into December.
const SEMESTER_TERMS = [
  { name: 'Spring', startMonth: 0 }, // January
  { name: 'Summer I', startMonth: 5 }, // June
  { name: 'Summer II', startMonth: 6 }, // July
  { name: 'Fall', startMonth: 7 }, // August
  { name: 'Winter', startMonth: 11 }, // December
];

// The current term plus the next 2 (3 total), looking up to two years ahead
// so the window never runs dry near a year boundary. A term counts as "not
// yet passed" as long as the next term in the sequence hasn't started yet -
// so today (July 2026, Summer II) yields ["Summer II 2026", "Fall 2026",
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

// Rebuilds the semester dropdown's options and selects selectedValue, or the
// current term if none given. If selectedValue isn't one of the upcoming
// options (e.g. editing an older entry from an already-passed semester),
// it's added as an extra option so it displays correctly instead of
// silently landing on the wrong semester.
function fillSemesterSelect(selectEl, selectedValue) {
  const options = currentSemesterOptions();
  if (selectedValue && !options.includes(selectedValue)) options.unshift(selectedValue);
  selectEl.innerHTML = options.map((s) => `<option value="${s}">${s}</option>`).join('');
  selectEl.value = selectedValue || options[0];
}

function resetClassScheduleForm() {
  document.getElementById('cs-rowid').value = '';
  document.getElementById('class-schedule-form-title').textContent = 'My Unavailable Schedule';
  document.getElementById('cs-submit-btn').textContent = 'Submit';
  document.getElementById('cs-cancel-btn').hidden = true;
  classScheduleForm.reset();
  fillSemesterSelect(document.getElementById('cs-semester'));
}

function startEditClass(row) {
  document.getElementById('cs-rowid').value = row.rowId;
  document.getElementById('class-schedule-form-title').textContent = 'Edit Unavailable Time';
  document.getElementById('cs-submit-btn').textContent = 'Save changes';
  document.getElementById('cs-cancel-btn').hidden = false;
  document.getElementById('cs-day').value = row['Day'];
  document.getElementById('cs-start').value = to24Hour(row['Start Time']);
  document.getElementById('cs-end').value = to24Hour(row['End Time']);
  fillSemesterSelect(document.getElementById('cs-semester'), row['Semester']);
  document.getElementById('cs-grad').value = row['Expected Grad'] || '';
  classScheduleForm.scrollIntoView({ behavior: 'smooth' });
}

// For classes that meet more than once a week: prefill everything from an
// existing entry (minus the day) so the student only has to pick the other
// day instead of retyping start/end/semester.
function duplicateClass(row) {
  resetClassScheduleForm();
  document.getElementById('cs-day').value = '';
  document.getElementById('cs-start').value = to24Hour(row['Start Time']);
  document.getElementById('cs-end').value = to24Hour(row['End Time']);
  fillSemesterSelect(document.getElementById('cs-semester'), row['Semester']);
  document.getElementById('cs-grad').value = row['Expected Grad'] || '';
  showStatus(classScheduleStatus, 'Pick the other day this applies, then submit.', 'success');
  classScheduleForm.scrollIntoView({ behavior: 'smooth' });
}

async function deleteClassScheduleEntry(rowId) {
  if (!(await appConfirm('Delete this entry?'))) return;
  try {
    await api.deleteClassScheduleEntry(rowId);
    showStatus(classScheduleStatus, 'Entry deleted.', 'success');
    refreshClassSchedule();
  } catch (err) {
    showStatus(classScheduleStatus, `Could not delete entry: ${err.message}`, 'error');
  }
}

document.getElementById('cs-cancel-btn').addEventListener('click', resetClassScheduleForm);

classScheduleForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const studentName = sessionStorage.getItem(STORAGE_KEY);
  const rowId = document.getElementById('cs-rowid').value;
  const entry = {
    studentName,
    day: document.getElementById('cs-day').value,
    startTime: to12Hour(document.getElementById('cs-start').value),
    endTime: to12Hour(document.getElementById('cs-end').value),
    semester: document.getElementById('cs-semester').value,
    expectedGrad: document.getElementById('cs-grad').value,
  };
  try {
    if (rowId) {
      await api.updateClassScheduleEntry(rowId, entry);
      showStatus(classScheduleStatus, 'Entry updated.', 'success');
    } else {
      await api.addClassScheduleEntry(entry);
      showStatus(classScheduleStatus, 'Your unavailable time has been submitted.', 'success');
    }
    resetClassScheduleForm();
    refreshClassSchedule();
  } catch (err) {
    showStatus(classScheduleStatus, `Could not save entry: ${err.message}`, 'error');
  }
});

// --- Time off ---
const timeOffForm = document.getElementById('time-off-form');
const timeOffStatus = document.getElementById('time-off-status');
const timeOffTableBody = document.querySelector('#time-off-table tbody');

async function refreshTimeOff() {
  const studentName = sessionStorage.getItem(STORAGE_KEY);
  try {
    const rows = await api.getTimeOff(studentName);
    timeOffTableBody.innerHTML = '';
    rows.forEach((row) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${row['Start Date'] || ''}</td>
        <td>${row['End Date'] || ''}</td>
        <td>${row['Reason'] || ''}</td>
        <td>${row['Status'] || ''}</td>
        <td>${row['Submitted Date'] || ''}</td>
      `;
      timeOffTableBody.appendChild(tr);
    });
  } catch (err) {
    showStatus(timeOffStatus, `Could not load your time-off requests: ${err.message}`, 'error');
  }
}

timeOffForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const studentName = sessionStorage.getItem(STORAGE_KEY);
  const request = {
    studentName,
    startDate: document.getElementById('to-start').value,
    endDate: document.getElementById('to-end').value,
    reason: document.getElementById('to-reason').value,
    // Populates the Email column on Time Off Requests, which the "Time-off
    // status update" Smartsheet Automation alerts when Status changes -
    // that's how the submitting student gets notified of approval/denial.
    email: (currentStudents.find((s) => s.name === studentName) || {}).email || '',
  };
  try {
    await api.submitTimeOff(request);
    showStatus(timeOffStatus, 'Your time-off request has been submitted.', 'success');
    timeOffForm.reset();
    refreshTimeOff();
  } catch (err) {
    showStatus(timeOffStatus, `Could not submit request: ${err.message}`, 'error');
  }
});

function showStatus(el, message, kind) {
  el.textContent = message;
  el.hidden = false;
  el.className = `status ${kind}`;
}

// --- Init ---
// loadStudents() is awaited before auto-restoring a returning student -
// setActiveStudent() doesn't itself need the roster, but currentStudents
// must be populated before they could possibly submit a time-off request,
// otherwise the email lookup silently comes back blank (a returning student
// never re-picks their name, so there's no other point that would populate
// it in time).
(async function init() {
  fillSemesterSelect(document.getElementById('cs-semester'));
  await loadStudents();
  const savedName = sessionStorage.getItem(STORAGE_KEY);
  if (savedName) {
    setActiveStudent(savedName);
  }
})();
