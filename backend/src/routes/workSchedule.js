const express = require('express');
const { getRows, addRow, addRows, updateRow, deleteRows } = require('../smartsheetClient');
const { generateWeeklySchedule, formatMinutesToTime } = require('../scheduler');

const router = express.Router();

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

// GET /api/work-schedule?student=Name&semester=Fall 2026
router.get('/', async (req, res) => {
  try {
    const rows = await getRows(process.env.WORK_SCHEDULE_SHEET_ID);
    const { student, semester } = req.query;
    const filtered = rows
      .filter((row) => !student || row['Student Name'] === student)
      .filter((row) => !semester || row['Semester'] === semester);
    res.json(filtered);
  } catch (err) {
    console.error('GET /api/work-schedule failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/work-schedule/generate -> run the scheduler and replace this
// semester's Generated rows. Existing Manual rows are never touched.
router.post('/generate', async (req, res) => {
  try {
    const { semester } = req.body;
    const asOfDate = req.body.asOfDate || todayIso();
    if (!semester) {
      return res.status(400).json({ error: 'semester is required.' });
    }

    const [studentRows, classRows, timeOffRows, workScheduleRows] = await Promise.all([
      getRows(process.env.STUDENT_MASTER_SHEET_ID),
      getRows(process.env.CLASS_SCHEDULE_SHEET_ID),
      getRows(process.env.TIME_OFF_SHEET_ID),
      getRows(process.env.WORK_SCHEDULE_SHEET_ID),
    ]);

    const students = studentRows
      .filter((row) => row['Active'] === true)
      .map((row) => ({
        name: row['Student Name'],
        role: row['Role'],
        primaryLocation: row['Primary Location'],
      }))
      .filter((student) => student.name);

    const existingForSemester = workScheduleRows.filter((row) => row['Semester'] === semester);
    const manualRows = existingForSemester.filter((row) => row['Source'] === 'Manual');
    const staleGeneratedRows = existingForSemester.filter((row) => row['Source'] === 'Generated');

    const { generatedRows, gaps, warnings } = generateWeeklySchedule({
      students,
      classRows,
      timeOffRows,
      manualRows,
      asOfDate,
    });

    const lastUpdated = todayIso();
    const newFieldRows = generatedRows.map((row) => ({
      'Student Name': row.studentName,
      Day: row.day,
      Location: row.location,
      'Start Time': formatMinutesToTime(row.start),
      'End Time': formatMinutesToTime(row.end),
      Semester: semester,
      Source: 'Generated',
      Notes: row.reason || '',
      'Last Updated': lastUpdated,
    }));

    await deleteRows(
      process.env.WORK_SCHEDULE_SHEET_ID,
      staleGeneratedRows.map((row) => row.rowId)
    );
    await addRows(process.env.WORK_SCHEDULE_SHEET_ID, newFieldRows);

    res.json({
      added: newFieldRows.length,
      removed: staleGeneratedRows.length,
      gaps: gaps.map((gap) => ({
        day: gap.day,
        location: gap.location,
        start: formatMinutesToTime(gap.start),
        end: formatMinutesToTime(gap.end),
      })),
      warnings,
    });
  } catch (err) {
    console.error('POST /api/work-schedule/generate failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/work-schedule -> manager manually adds one shift. Always Manual.
router.post('/', async (req, res) => {
  try {
    const { studentName, day, location, startTime, endTime, semester, notes } = req.body;
    if (!studentName || !day || !location || !startTime || !endTime || !semester) {
      return res.status(400).json({
        error: 'studentName, day, location, startTime, endTime, and semester are required.',
      });
    }
    const row = await addRow(process.env.WORK_SCHEDULE_SHEET_ID, {
      'Student Name': studentName,
      Day: day,
      Location: location,
      'Start Time': startTime,
      'End Time': endTime,
      Semester: semester,
      Source: 'Manual',
      Notes: notes || '',
      'Last Updated': todayIso(),
    });
    res.status(201).json(row);
  } catch (err) {
    console.error('POST /api/work-schedule failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/work-schedule/:rowId -> manager edits a shift. Always forces
// Source: 'Manual', regardless of what it was — this is the entire
// "override survives regeneration" mechanism.
router.put('/:rowId', async (req, res) => {
  try {
    const { studentName, day, location, startTime, endTime, semester, notes } = req.body;
    const fields = { Source: 'Manual', 'Last Updated': todayIso() };
    if (studentName !== undefined) fields['Student Name'] = studentName;
    if (day !== undefined) fields['Day'] = day;
    if (location !== undefined) fields['Location'] = location;
    if (startTime !== undefined) fields['Start Time'] = startTime;
    if (endTime !== undefined) fields['End Time'] = endTime;
    if (semester !== undefined) fields['Semester'] = semester;
    if (notes !== undefined) fields['Notes'] = notes;

    const row = await updateRow(process.env.WORK_SCHEDULE_SHEET_ID, Number(req.params.rowId), fields);
    res.json(row);
  } catch (err) {
    console.error('PUT /api/work-schedule/:rowId failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/work-schedule/:rowId -> works on any row regardless of Source.
router.delete('/:rowId', async (req, res) => {
  try {
    await deleteRows(process.env.WORK_SCHEDULE_SHEET_ID, [Number(req.params.rowId)]);
    res.status(204).end();
  } catch (err) {
    console.error('DELETE /api/work-schedule/:rowId failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
