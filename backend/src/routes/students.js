const express = require('express');
const { getRows } = require('../smartsheetClient');

const router = express.Router();

// GET /api/students -> active students, for the "pick your name" dropdown.
router.get('/', async (req, res) => {
  try {
    const rows = await getRows(process.env.STUDENT_MASTER_SHEET_ID);
    const activeStudents = rows
      .filter((row) => row['Active'] === true)
      .map((row) => ({
        name: row['Student Name'],
        studentId: row['Student ID'],
        email: row['Email'],
      }))
      .filter((student) => student.name);
    res.json(activeStudents);
  } catch (err) {
    console.error('GET /api/students failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/students/roster -> every student (active or not) with the fields
// the manager dashboard and scheduler need. Deliberately separate from GET /
// above, which intentionally hides Role/Primary Location from the student
// portal.
router.get('/roster', async (req, res) => {
  try {
    const rows = await getRows(process.env.STUDENT_MASTER_SHEET_ID);
    const roster = rows
      .map((row) => ({
        name: row['Student Name'],
        studentId: row['Student ID'],
        email: row['Email'],
        active: row['Active'] === true,
        role: row['Role'],
        primaryLocation: row['Primary Location'],
      }))
      .filter((student) => student.name);
    res.json(roster);
  } catch (err) {
    console.error('GET /api/students/roster failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
