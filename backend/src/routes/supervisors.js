const express = require('express');
const { getRows } = require('../smartsheetClient');

const router = express.Router();

// GET /api/supervisors -> the shared contact list shown at the bottom of
// the manager dashboard's Excel export (same list under both boxes). Lives
// in its own sheet, separate from Student Master, since a supervisor isn't
// necessarily a student-worker row - add/remove a row here when someone
// joins or leaves, no code change needed.
router.get('/', async (req, res) => {
  try {
    const rows = await getRows(process.env.SUPERVISORS_SHEET_ID);
    const supervisors = rows
      .map((row) => ({ name: row['Name'], phone: row['Phone'] }))
      .filter((s) => s.name);
    res.json(supervisors);
  } catch (err) {
    console.error('GET /api/supervisors failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
