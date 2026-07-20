require('dotenv').config();
const express = require('express');
const cors = require('cors');

const studentsRouter = require('./src/routes/students');
const classScheduleRouter = require('./src/routes/classSchedule');
const timeOffRouter = require('./src/routes/timeOff');
const workScheduleRouter = require('./src/routes/workSchedule');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use('/api/students', studentsRouter);
app.use('/api/class-schedule', classScheduleRouter);
app.use('/api/time-off', timeOffRouter);
app.use('/api/work-schedule', workScheduleRouter);

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Unexpected server error.' });
});

// Vercel imports this file as a serverless function and calls the exported
// app directly (it matches Node's (req, res) handler signature) - it never
// needs app.listen. Locally (npm start), VERCEL is unset, so this runs like
// a normal Express server.
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => {
    console.log(`Backend listening on http://localhost:${PORT}`);
  });
}

module.exports = app;
