const express = require('express');
const { getRows, addRow, updateRow, deleteRows } = require('../smartsheetClient');

const router = express.Router();

// GET /api/class-schedule?student=Name -> that student's class blocks.
// GET /api/class-schedule -> every class block (used by Phase 2 scheduling logic).
router.get('/', async (req, res) => {
  try {
    const rows = await getRows(process.env.CLASS_SCHEDULE_SHEET_ID);
    const { student } = req.query;
    const filtered = student
      ? rows.filter((row) => row['Student Name'] === student)
      : rows;
    res.json(filtered);
  } catch (err) {
    console.error('GET /api/class-schedule failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/class-schedule -> add one class block for one student.
router.post('/', async (req, res) => {
  try {
    const { studentName, day, startTime, endTime, courseNotes, semester } = req.body;
    if (!studentName || !day || !startTime || !endTime) {
      return res
        .status(400)
        .json({ error: 'studentName, day, startTime, and endTime are required.' });
    }
    const row = await addRow(process.env.CLASS_SCHEDULE_SHEET_ID, {
      'Student Name': studentName,
      Day: day,
      'Start Time': startTime,
      'End Time': endTime,
      'Course/Notes': courseNotes || '',
      Semester: semester || '',
    });
    res.status(201).json(row);
  } catch (err) {
    console.error('POST /api/class-schedule failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/class-schedule/:rowId -> a student edits a class block instead of
// deleting and re-typing it.
router.put('/:rowId', async (req, res) => {
  try {
    const { day, startTime, endTime, courseNotes, semester } = req.body;
    if (!day || !startTime || !endTime) {
      return res.status(400).json({ error: 'day, startTime, and endTime are required.' });
    }
    const row = await updateRow(process.env.CLASS_SCHEDULE_SHEET_ID, Number(req.params.rowId), {
      Day: day,
      'Start Time': startTime,
      'End Time': endTime,
      'Course/Notes': courseNotes || '',
      Semester: semester || '',
    });
    res.json(row);
  } catch (err) {
    console.error('PUT /api/class-schedule/:rowId failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/class-schedule/:rowId -> a student removes a mistyped class block.
router.delete('/:rowId', async (req, res) => {
  try {
    await deleteRows(process.env.CLASS_SCHEDULE_SHEET_ID, [Number(req.params.rowId)]);
    res.status(204).end();
  } catch (err) {
    console.error('DELETE /api/class-schedule/:rowId failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
