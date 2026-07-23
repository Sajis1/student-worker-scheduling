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
        <td>${row['Course/Notes'] || ''}</td>
        <td>${row['Semester'] || ''}</td>
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
    showStatus(classScheduleStatus, `Could not load your class schedule: ${err.message}`, 'error');
  }
}

function resetClassScheduleForm() {
  document.getElementById('cs-rowid').value = '';
  document.getElementById('class-schedule-form-title').textContent = 'My Class Schedule';
  document.getElementById('cs-submit-btn').textContent = 'Submit';
  document.getElementById('cs-cancel-btn').hidden = true;
  classScheduleForm.reset();
}

function startEditClass(row) {
  document.getElementById('cs-rowid').value = row.rowId;
  document.getElementById('class-schedule-form-title').textContent = 'Edit Class';
  document.getElementById('cs-submit-btn').textContent = 'Save changes';
  document.getElementById('cs-cancel-btn').hidden = false;
  document.getElementById('cs-day').value = row['Day'];
  document.getElementById('cs-start').value = to24Hour(row['Start Time']);
  document.getElementById('cs-end').value = to24Hour(row['End Time']);
  document.getElementById('cs-notes').value = row['Course/Notes'] || '';
  document.getElementById('cs-semester').value = row['Semester'] || '';
  classScheduleForm.scrollIntoView({ behavior: 'smooth' });
}

// For classes that meet more than once a week: prefill everything from an
// existing entry (minus the day) so the student only has to pick the other
// day instead of retyping start/end/notes/semester.
function duplicateClass(row) {
  resetClassScheduleForm();
  document.getElementById('cs-day').value = '';
  document.getElementById('cs-start').value = to24Hour(row['Start Time']);
  document.getElementById('cs-end').value = to24Hour(row['End Time']);
  document.getElementById('cs-notes').value = row['Course/Notes'] || '';
  document.getElementById('cs-semester').value = row['Semester'] || '';
  showStatus(classScheduleStatus, 'Pick the other day this class meets, then submit.', 'success');
  classScheduleForm.scrollIntoView({ behavior: 'smooth' });
}

async function deleteClassScheduleEntry(rowId) {
  if (!(await appConfirm('Delete this class?'))) return;
  try {
    await api.deleteClassScheduleEntry(rowId);
    showStatus(classScheduleStatus, 'Class deleted.', 'success');
    refreshClassSchedule();
  } catch (err) {
    showStatus(classScheduleStatus, `Could not delete class: ${err.message}`, 'error');
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
    courseNotes: document.getElementById('cs-notes').value,
    semester: document.getElementById('cs-semester').value,
  };
  try {
    if (rowId) {
      await api.updateClassScheduleEntry(rowId, entry);
      showStatus(classScheduleStatus, 'Class updated.', 'success');
    } else {
      await api.addClassScheduleEntry(entry);
      showStatus(classScheduleStatus, 'Your class has been submitted.', 'success');
    }
    resetClassScheduleForm();
    refreshClassSchedule();
  } catch (err) {
    showStatus(classScheduleStatus, `Could not save class: ${err.message}`, 'error');
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
loadStudents();
const savedName = sessionStorage.getItem(STORAGE_KEY);
if (savedName) {
  setActiveStudent(savedName);
}
