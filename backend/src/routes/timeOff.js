const express = require('express');
const { getRows, addRow, updateRow } = require('../smartsheetClient');

const router = express.Router();

// GET /api/time-off?student=Name -> that student's time-off requests.
// GET /api/time-off -> every request (used by the Phase 2/3 manager views).
router.get('/', async (req, res) => {
  try {
    const rows = await getRows(process.env.TIME_OFF_SHEET_ID);
    const { student } = req.query;
    const filtered = student
      ? rows.filter((row) => row['Student Name'] === student)
      : rows;
    res.json(filtered);
  } catch (err) {
    console.error('GET /api/time-off failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/time-off -> submit a new request. Status always starts Pending;
// approval/denial happens later (manager dashboard in Phase 2/3), not here.
router.post('/', async (req, res) => {
  try {
    const { studentName, startDate, endDate, reason } = req.body;
    if (!studentName || !startDate || !endDate) {
      return res
        .status(400)
        .json({ error: 'studentName, startDate, and endDate are required.' });
    }
    const submittedDate = new Date().toISOString().slice(0, 10);
    const row = await addRow(process.env.TIME_OFF_SHEET_ID, {
      'Student Name': studentName,
      'Start Date': startDate,
      'End Date': endDate,
      Reason: reason || '',
      Status: 'Pending',
      'Submitted Date': submittedDate,
    });
    res.status(201).json(row);
  } catch (err) {
    console.error('POST /api/time-off failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/time-off/:rowId/status -> manager approves or denies a request.
// This is the minimal infrastructure Phase 2's schedule generator needs (it
// only excludes Approved time off). Full approval-workflow polish (audit
// trail, notifications) is Phase 3.
router.patch('/:rowId/status', async (req, res) => {
  try {
    const { status } = req.body;
    if (status !== 'Approved' && status !== 'Denied') {
      return res.status(400).json({ error: 'status must be "Approved" or "Denied".' });
    }
    const row = await updateRow(process.env.TIME_OFF_SHEET_ID, Number(req.params.rowId), {
      Status: status,
    });
    res.json(row);
  } catch (err) {
    console.error('PATCH /api/time-off/:rowId/status failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
