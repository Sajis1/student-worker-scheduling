// Pure scheduling logic: no Express, no Smartsheet calls. Operates only on
// plain JS arrays/objects so it can be exercised without any network access.
// Callers (routes/workSchedule.js) are responsible for fetching Smartsheet
// rows in, and turning generatedRows back into Smartsheet field objects out.

const OFFICE_START = 480; // 8:00 AM, in minutes since midnight
const OFFICE_END = 1020; // 5:00 PM
const LUNCH_START = 720; // 12:00 PM
const LUNCH_END = 780; // 1:00 PM
const MIN_SHIFT_MINUTES = 240; // 4 hours - a hard constraint, no shift is ever assigned shorter than this
const WEEKLY_CAP_MINUTES = 1200; // 20 hours/week, a hard constraint
const CLASS_BUFFER_MINUTES = 30; // small break before/after class, so a shift never starts the instant class ends or ends the instant class starts
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

// A shift spanning the full 8am-5pm office day includes a mandatory unpaid
// 1-hour lunch break. The displayed block stays one continuous row (the
// student isn't actually pulled off the schedule for it) - only the worked
// -minutes count used for the 20-hour cap and Weekly Hours drops by 60,
// and the row gets a note so it's visible without splitting the calendar
// entry in two. Scoped narrowly to the exact full-day case on purpose - this
// doesn't try to guess a break policy for partial shifts.
function isFullOfficeDay(interval) {
  return interval.start === OFFICE_START && interval.end === OFFICE_END;
}

function workedMinutesFor(interval) {
  const raw = interval.end - interval.start;
  return isFullOfficeDay(interval) ? raw - (LUNCH_END - LUNCH_START) : raw;
}

// A full 8-5 block only actually costs (raw - 60min lunch) against the
// weekly cap. Capping by raw minutes alone truncates a candidate's last
// hour even when their true lunch-adjusted cost fits the remaining budget
// exactly - which silently turned a fully-available candidate into a
// truncated one, tripping orphan-avoidance and disqualifying them even
// though they could really work the whole day. Extend to the full day
// first if the discounted cost fits; only fall back to a raw-minute cap
// otherwise.
function budgetCappedEnd(overlap, remainingBudget) {
  if (isFullOfficeDay(overlap) && workedMinutesFor(overlap) <= remainingBudget) {
    return overlap.end;
  }
  return Math.min(overlap.end, overlap.start + remainingBudget);
}

function parseTimeToMinutes(text) {
  if (!text) return null;
  const match = String(text).trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return null;
  const [, hourStr, minuteStr, period] = match;
  let hour = parseInt(hourStr, 10) % 12;
  if (period.toUpperCase() === 'PM') hour += 12;
  return hour * 60 + parseInt(minuteStr, 10);
}

function formatMinutesToTime(minutes) {
  const hour24 = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const period = hour24 >= 12 ? 'PM' : 'AM';
  const hour12 = ((hour24 + 11) % 12) + 1;
  return `${hour12}:${String(minute).padStart(2, '0')} ${period}`;
}

function subtractInterval(intervals, toRemove) {
  const result = [];
  for (const iv of intervals) {
    if (toRemove.end <= iv.start || toRemove.start >= iv.end) {
      result.push(iv);
      continue;
    }
    if (toRemove.start > iv.start) result.push({ start: iv.start, end: Math.min(toRemove.start, iv.end) });
    if (toRemove.end < iv.end) result.push({ start: Math.max(toRemove.end, iv.start), end: iv.end });
  }
  return result.filter((iv) => iv.end > iv.start);
}

function subtractIntervals(intervals, toRemoveList) {
  return toRemoveList.reduce((acc, tr) => subtractInterval(acc, tr), intervals);
}

function intersect(a, b) {
  const start = Math.max(a.start, b.start);
  const end = Math.min(a.end, b.end);
  return end > start ? { start, end } : null;
}

// Computes one student's free intervals on one weekday, within office hours,
// after removing class blocks and any already-occupied (manual) time.
function computeAvailability({ day, classRows, manualOccupied, unavailableAllDay }) {
  if (unavailableAllDay) return [];
  let intervals = [{ start: OFFICE_START, end: OFFICE_END }];
  const classBlocks = classRows
    .filter((row) => row['Day'] === day)
    .map((row) => ({
      start: parseTimeToMinutes(row['Start Time']),
      end: parseTimeToMinutes(row['End Time']),
    }))
    .filter((iv) => iv.start != null && iv.end != null && iv.end > iv.start)
    // Pad each class block by a small buffer on both sides so a shift never
    // starts the instant class ends (or has to end the instant it begins) -
    // clamped to office hours since a buffer past 8-5 has nothing to protect.
    .map((iv) => ({
      start: Math.max(OFFICE_START, iv.start - CLASS_BUFFER_MINUTES),
      end: Math.min(OFFICE_END, iv.end + CLASS_BUFFER_MINUTES),
    }));
  intervals = subtractIntervals(intervals, classBlocks);
  if (manualOccupied && manualOccupied.length) {
    intervals = subtractIntervals(intervals, manualOccupied);
  }
  return intervals;
}

function isDateWithinRange(dateStr, startStr, endStr) {
  return dateStr >= startStr && dateStr <= endStr;
}

function computeUnavailableStudents(timeOffRows, asOfDate) {
  const unavailable = new Set();
  for (const row of timeOffRows) {
    if (row['Status'] !== 'Approved') continue;
    const start = row['Start Date'];
    const end = row['End Date'];
    if (!start || !end) continue;
    if (isDateWithinRange(asOfDate, start, end)) {
      unavailable.add(row['Student Name']);
    }
  }
  return unavailable;
}

function buildManualOccupancy(manualRows) {
  const byStudent = new Map();
  const bySeat = new Map();
  for (const row of manualRows) {
    const name = row['Student Name'];
    const day = row['Day'];
    const location = row['Location'];
    const start = parseTimeToMinutes(row['Start Time']);
    const end = parseTimeToMinutes(row['End Time']);
    if (start == null || end == null) continue;
    const interval = { start, end };

    if (!byStudent.has(name)) byStudent.set(name, new Map());
    const studentDays = byStudent.get(name);
    if (!studentDays.has(day)) studentDays.set(day, []);
    studentDays.get(day).push(interval);

    if (!bySeat.has(location)) bySeat.set(location, new Map());
    const seatDays = bySeat.get(location);
    if (!seatDays.has(day)) seatDays.set(day, []);
    seatDays.get(day).push(interval);
  }
  return { byStudent, bySeat };
}

// Full, gap-free coverage beats everything else - a candidate who can close
// the ENTIRE current gap alone always wins, even over someone who's worked
// fewer days so far. Only when nobody can achieve full closure does "fewer
// days worked wins" take over as the deciding factor (which is what spreads
// the roster across the week when a single person genuinely can't cover a
// whole day); overlap length is the last tie-break. This ordering matters:
// without the closure bonus, a fully-available student who already worked a
// couple of days could lose out to two partially-available fresher students
// who'd each leave a stub of the day uncovered - full coverage is worth
// more than an even week for the seats that need to be covered every day.
function candidateScore(overlapMinutes, daysWorkedSoFar, closesGapFully) {
  const closureBonus = closesGapFully ? 100000000 : 0;
  return closureBonus - daysWorkedSoFar * 100000 + overlapMinutes;
}

// Students whose Primary Location is this seat - the "stay home" tier tried
// before mixing anyone in from elsewhere.
function homePool(pool, location) {
  return pool.filter((s) => s.primaryLocation === location);
}

// Greedily fills a seat instance's remaining gap from a pool of students,
// picking the best-scoring candidate each round. Hard constraints enforced
// here, all via ctx: a student can be assigned at most ONCE per day (one
// continuous "clock in, clock out" per day - ctx.usedToday), a student's
// assignment is truncated so their running weekly total never exceeds the
// 20-hour cap (ctx.weeklyMinutes), and no assignment is ever shorter than
// the 4-hour minimum. Mutates seatInstance.gap and the
// availability/usedToday/weeklyMinutes/daysWorked tracked in ctx as it
// assigns. `forcedReason`, if given, overrides the auto mix-note (used for
// the Back Office fallback, which is a real role crossing, not just a
// location mismatch worth a casual note). When `avoidOrphans` is true (the
// default for every tier except a seat's absolute last resort), a candidate
// is skipped ONLY if the 20-hour weekly cap (not their real availability) is
// what would truncate their assignment short and leave a sub-4-hour,
// un-assignable sliver behind - that's a self-inflicted fragment the
// algorithm can avoid by trying someone else with more budget. A gap caused
// by a candidate's genuine availability (e.g. a class before or after their
// free window) is never grounds to skip them: that gap is real regardless of
// who's picked, and the candidate's own available time should still be used
// rather than passed over in favor of someone with cleaner full-day
// availability - home priority beats gap-minimization.
function fillSeatFromPool(
  seatInstance,
  pool,
  ctx,
  forcedReason,
  avoidOrphans = true,
  allowShortShift = false,
  maximizeUnderutilized = false
) {
  const { day, getAvailability, consume, usedToday, weeklyMinutes, daysWorked, generatedRows } = ctx;
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const gapWindow of [...seatInstance.gap]) {
      let best = null;
      let bestScore = -Infinity;
      for (const student of pool) {
        if (usedToday.has(student.name)) continue; // one shift per day
        const remainingBudget = WEEKLY_CAP_MINUTES - (weeklyMinutes.get(student.name) || 0);
        if (remainingBudget <= 0) continue; // 20-hour weekly cap reached
        for (const iv of getAvailability(student)) {
          const overlap = intersect(iv, gapWindow);
          if (!overlap) continue;
          const cappedEnd = budgetCappedEnd(overlap, remainingBudget);
          if (cappedEnd <= overlap.start) continue;
          const interval = { start: overlap.start, end: cappedEnd };
          const overlapMinutes = interval.end - interval.start;
          if (!allowShortShift && overlapMinutes < MIN_SHIFT_MINUTES) continue; // 4-hour hard minimum
          if (avoidOrphans) {
            const wasCapTruncated = cappedEnd < overlap.end;
            const leftoverAfter = gapWindow.end - interval.end;
            const capInducedOrphan = wasCapTruncated && leftoverAfter > 0 && leftoverAfter < MIN_SHIFT_MINUTES;
            if (capInducedOrphan) continue;
          }
          const closesGapFully = interval.start === gapWindow.start && interval.end === gapWindow.end;
          // Opportunistic/bonus seats (S700's 2nd chair) aren't about closing
          // a required gap or spreading days evenly - they're purely about
          // catching up whoever has banked the fewest hours so far this
          // week, so the ranking swaps to lowest-weeklyMinutes-wins instead
          // of the usual closure/days-worked scoring.
          const score = maximizeUnderutilized
            ? -(weeklyMinutes.get(student.name) || 0) * 1000 + overlapMinutes
            : candidateScore(overlapMinutes, daysWorked.get(student.name) || 0, closesGapFully);
          if (score > bestScore) {
            bestScore = score;
            best = { student, interval };
          }
        }
      }
      if (best) {
        const reason =
          forcedReason ||
          (best.student.role === 'Floater' && seatInstance.location !== 'Back Office'
            ? 'floater: covering Front Desk'
            : best.student.primaryLocation && best.student.primaryLocation !== seatInstance.location
              ? `mix: normally ${best.student.primaryLocation}`
              : '');
        const lunchNote = isFullOfficeDay(best.interval) ? 'includes unpaid lunch 12-1 PM (8 hrs counted)' : '';
        const fullReason = [reason, lunchNote].filter(Boolean).join('; ');
        generatedRows.push({
          studentName: best.student.name,
          day,
          location: seatInstance.location,
          start: best.interval.start,
          end: best.interval.end,
          reason: fullReason,
        });
        const workedMinutes = workedMinutesFor(best.interval);
        consume(best.student, best.interval);
        usedToday.add(best.student.name);
        daysWorked.set(best.student.name, (daysWorked.get(best.student.name) || 0) + 1);
        weeklyMinutes.set(best.student.name, (weeklyMinutes.get(best.student.name) || 0) + workedMinutes);
        seatInstance.gap = subtractInterval(seatInstance.gap, best.interval);
        progressed = true;
        break; // gap array changed shape, restart the scan
      }
    }
  }
}

// A student's cap for THIS Back Office day: their fair share of remaining
// weekly budget spread over remaining weekdays (floored at the 4-hour
// minimum) - without this, a fully-available student would burn all 20
// hours in the first 2-3 days and vanish for the rest of the week even
// though they were still available.
function backOfficeDailyBudget(studentName, ctx) {
  const remainingBudget = WEEKLY_CAP_MINUTES - (ctx.weeklyMinutes.get(studentName) || 0);
  if (remainingBudget <= 0) return 0;
  const fairShare = Math.ceil(remainingBudget / ctx.daysRemaining);
  return Math.min(remainingBudget, Math.max(MIN_SHIFT_MINUTES, fairShare));
}

// Back Office has NO seat cap and is NOT a "stop once someone covers it"
// shared gap like Front Desk seats - every available Back Office/Floater
// student gets their OWN independent slot (multiple people overlapping in
// time is expected and fine, not something to avoid), maximizing everyone's
// hours toward the 20-hour cap rather than minimizing to bare coverage.
// Returns the assigned intervals so the caller can compute - for visibility
// only, not to gate further assignment - whatever stretch of the day nobody
// ended up covering.
function assignBackOfficeIndependently(pool, ctx) {
  const { day, getAvailability, consume, usedToday, weeklyMinutes, daysWorked, generatedRows } = ctx;
  const assignedIntervals = [];
  for (const student of pool) {
    if (usedToday.has(student.name)) continue;
    const dailyBudget = backOfficeDailyBudget(student.name, ctx);
    if (dailyBudget <= 0) continue;
    const avail = getAvailability(student);
    if (avail.length === 0) continue;
    let longest = avail[0];
    for (const iv of avail) {
      if (iv.end - iv.start > longest.end - longest.start) longest = iv;
    }
    const cappedEnd = Math.min(longest.end, longest.start + dailyBudget);
    if (cappedEnd <= longest.start) continue;
    const interval = { start: longest.start, end: cappedEnd };
    if (interval.end - interval.start < MIN_SHIFT_MINUTES) continue; // 4-hour hard minimum
    const reason = isFullOfficeDay(interval) ? 'includes unpaid lunch 12-1 PM (8 hrs counted)' : '';
    generatedRows.push({ studentName: student.name, day, location: 'Back Office', start: interval.start, end: interval.end, reason });
    const workedMinutes = workedMinutesFor(interval);
    consume(student, interval);
    usedToday.add(student.name);
    daysWorked.set(student.name, (daysWorked.get(student.name) || 0) + 1);
    weeklyMinutes.set(student.name, (weeklyMinutes.get(student.name) || 0) + workedMinutes);
    assignedIntervals.push(interval);
  }
  return assignedIntervals;
}

// students: [{ name, role: 'Front Desk'|'Back Office'|'Floater', primaryLocation }]
//   Caller is expected to have already filtered to Active students. Floaters
//   are cross-trained for both areas: they default to Back Office duty but
//   can flex to any Front Desk seat (including S701, unlike regular Back
//   Office) once regular Front Desk students can't cover a gap.
// classRows / timeOffRows: raw Smartsheet rows (via getRows) for the whole sheet.
// manualRows: Work Schedule rows for the target semester where Source === 'Manual'.
function generateWeeklySchedule({ students, classRows, timeOffRows, manualRows, asOfDate }) {
  const unavailableStudents = computeUnavailableStudents(timeOffRows, asOfDate);
  const { byStudent: manualByStudent, bySeat: manualBySeat } = buildManualOccupancy(manualRows);

  const frontDesk = students.filter((s) => s.role === 'Front Desk');
  const backOffice = students.filter((s) => s.role === 'Back Office');
  const floaters = students.filter((s) => s.role === 'Floater');
  // Floaters are a distinct, strictly-lower-priority tier than regular Front
  // Desk mixing: a Floater only gets pulled to Front Desk once no regular
  // Front Desk student (home or mixed) can cover the gap - otherwise a
  // Floater just stays on their own Back Office default duty.

  const generatedRows = [];
  const gaps = [];
  const warnings = [];

  if (frontDesk.length === 0) warnings.push('No students have Role = Front Desk.');
  const knownRoles = new Set(['Front Desk', 'Back Office', 'Floater']);
  const unrecognizedRoleNames = students.filter((s) => !knownRoles.has(s.role)).map((s) => s.name);
  if (unrecognizedRoleNames.length > 0) {
    warnings.push(
      `These active students have no recognized Role (must be "Front Desk", "Back Office", or "Floater") and were skipped: ${unrecognizedRoleNames.join(', ')}.`
    );
  }

  // Both persist across the whole week (not reset per day) - this is what
  // makes the 20-hour cap actually weekly, and the day-spread preference
  // actually week-aware.
  const weeklyMinutes = new Map();
  const daysWorked = new Map();

  // Manual rows are pre-existing commitments the generator didn't create,
  // but their hours still count against the same 20-hour weekly cap and
  // their day still counts toward the same day-spread tie-break - without
  // this, a student with Manual hours already on the books could get handed
  // a full Generated week on top, blowing well past 20 hours combined.
  const manualMinutesByStudent = new Map();
  const manualDaysByStudent = new Map(); // name -> Set(day)
  for (const row of manualRows) {
    const name = row['Student Name'];
    const start = parseTimeToMinutes(row['Start Time']);
    const end = parseTimeToMinutes(row['End Time']);
    if (!name || start == null || end == null || end <= start) continue;
    manualMinutesByStudent.set(name, (manualMinutesByStudent.get(name) || 0) + workedMinutesFor({ start, end }));
    if (!manualDaysByStudent.has(name)) manualDaysByStudent.set(name, new Set());
    manualDaysByStudent.get(name).add(row['Day']);
  }
  for (const [name, minutes] of manualMinutesByStudent) {
    weeklyMinutes.set(name, (weeklyMinutes.get(name) || 0) + minutes);
  }
  for (const [name, days] of manualDaysByStudent) {
    daysWorked.set(name, (daysWorked.get(name) || 0) + days.size);
  }

  // One persistent context per day, built once and reused across all three
  // passes below - this is what lets S701 (pass 2) see the usedToday/
  // weeklyMinutes/daysWorked state S700+TLS (pass 1) already left behind for
  // that same day, while S700+TLS get first claim on each day's capacity
  // across the WHOLE week before S701 ever gets a turn.
  const perDay = new Map();
  for (const [dayIndex, day] of WEEKDAYS.entries()) {
    const availability = new Map(); // studentName -> remaining {start,end}[] for this day
    // One continuous shift per day: seeded with anyone who already has a
    // Manual row this day, so the generator can't hand them a 2nd block.
    const usedToday = new Set();
    for (const [name, dayMap] of manualByStudent) {
      if (dayMap.has(day)) usedToday.add(name);
    }
    const daysRemaining = WEEKDAYS.length - dayIndex; // includes today - drives Back Office's fair daily share

    const getAvailability = (student) => {
      if (!availability.has(student.name)) {
        const manualOccupied = (manualByStudent.get(student.name) || new Map()).get(day) || [];
        availability.set(
          student.name,
          computeAvailability({
            day,
            classRows: classRows.filter((r) => r['Student Name'] === student.name),
            manualOccupied,
            unavailableAllDay: unavailableStudents.has(student.name),
          })
        );
      }
      return availability.get(student.name);
    };

    const consume = (student, block) => {
      availability.set(student.name, subtractInterval(getAvailability(student), block));
    };

    const seatBase = () => [{ start: OFFICE_START, end: OFFICE_END }];
    const s700Manual = (manualBySeat.get('S700') || new Map()).get(day) || [];
    const tlsManual = (manualBySeat.get('TLS') || new Map()).get(day) || [];
    const s701Manual = (manualBySeat.get('S701') || new Map()).get(day) || [];
    const backOfficeManual = (manualBySeat.get('Back Office') || new Map()).get(day) || [];

    perDay.set(day, {
      ctx: { day, daysRemaining, getAvailability, consume, usedToday, weeklyMinutes, daysWorked, generatedRows },
      // S700 physically has 2 seats. This required instance guarantees the
      // FIRST one is always covered 8-5; the second is filled separately,
      // after everything else, purely as bonus capacity to help
      // under-utilized students catch up on hours - see Pass 4 below.
      s700Instance: { location: 'S700', gap: subtractIntervals(seatBase(), s700Manual) },
      tlsInstance: { location: 'TLS', gap: subtractIntervals(seatBase(), tlsManual) },
      s701Instance: { location: 'S701', gap: subtractIntervals(seatBase(), s701Manual) },
      // Back Office needs at least one person covering it throughout the
      // day too, same guarantee as S700/TLS - unlike those seats there's no
      // cap on how many people can be there at once, so this is really just
      // a coverage floor, not a seat-capacity limit.
      backOfficeInstance: { location: 'Back Office', gap: subtractIntervals(seatBase(), backOfficeManual) },
    });
  }

  // Pass 1a: S700 then TLS, filled ONLY from their own home (Primary
  // Location) students, across the whole week. Staying at your home seat
  // takes priority over mixing, per direction - a student never gets moved
  // just because someone else happens to be a better tie-break candidate.
  for (const day of WEEKDAYS) {
    const { ctx, s700Instance, tlsInstance } = perDay.get(day);
    fillSeatFromPool(s700Instance, homePool(frontDesk, 'S700'), ctx);
    fillSeatFromPool(tlsInstance, homePool(frontDesk, 'TLS'), ctx);
  }

  // Pass 1b: only THEN, for whatever S700/TLS gap home students genuinely
  // couldn't cover, mix in the rest of the Front Desk roster - moving
  // someone off their home seat is the fallback, not the default. Floaters
  // are tried only after regular Front Desk mixing is exhausted, and Back
  // Office (the true last resort - avoidOrphans off) only after that.
  for (const day of WEEKDAYS) {
    const { ctx, s700Instance, tlsInstance } = perDay.get(day);
    fillSeatFromPool(s700Instance, frontDesk, ctx);
    fillSeatFromPool(tlsInstance, frontDesk, ctx);
    for (const seatInstance of [s700Instance, tlsInstance]) {
      fillSeatFromPool(seatInstance, floaters, ctx);
    }
    for (const seatInstance of [s700Instance, tlsInstance]) {
      fillSeatFromPool(seatInstance, backOffice, ctx, 'flex: pulled from Back Office', false);
    }
    // Absolute last resort: S700/TLS full 8-5 coverage outranks the 4-hour
    // minimum. Whatever sliver of the day nobody could legally cover above
    // (always under 4 hours, or every normal candidate would've taken it)
    // gets offered with the minimum waived - never for S701 or Back Office,
    // and only after every normal-length option above has already been
    // exhausted. Kept as three separate tiered calls (not one merged pool)
    // so a Floater still gets first crack before a regular Back Office
    // student, same priority order as the normal-length cascade just above -
    // a flat merged pool would let plain overlap/days-worked scoring pick a
    // Back Office student over an equally-available Floater, which isn't
    // the intended fallback order.
    for (const seatInstance of [s700Instance, tlsInstance]) {
      fillSeatFromPool(
        seatInstance,
        frontDesk,
        ctx,
        'short shift: only way to close a full coverage day',
        false,
        true
      );
    }
    for (const seatInstance of [s700Instance, tlsInstance]) {
      fillSeatFromPool(
        seatInstance,
        floaters,
        ctx,
        'short shift: only way to close a full coverage day',
        false,
        true
      );
    }
    for (const seatInstance of [s700Instance, tlsInstance]) {
      fillSeatFromPool(
        seatInstance,
        backOffice,
        ctx,
        'short shift: only way to close a full coverage day',
        false,
        true
      );
    }
  }

  // Pass 1c: on any day S700 ended up covered by exactly one person for the
  // whole 8-5 day, that person will need their lunch break with nobody else
  // physically at S700 - give S701 the SAME week-wide priority as S700/TLS
  // for those specific days, instead of making it wait for the lowest-
  // priority pass below. This is what actually guarantees "make sure S701
  // covers them": someone's stationed nearby who can step in during lunch.
  // Floaters aren't tried here either - Pass 2b's floater tier (which still
  // runs for every day, including these) is the true last resort for S701.
  const daysNeedingS701Backup = WEEKDAYS.filter((day) => {
    const s700RowsThatDay = generatedRows.filter((r) => r.day === day && r.location === 'S700');
    return s700RowsThatDay.length === 1 && isFullOfficeDay(s700RowsThatDay[0]);
  });
  for (const day of daysNeedingS701Backup) {
    const { ctx, s701Instance } = perDay.get(day);
    fillSeatFromPool(s701Instance, homePool(frontDesk, 'S701'), ctx);
    fillSeatFromPool(s701Instance, frontDesk, ctx);
  }

  // Pass 2a: on every other day, S701 is the overflow/flex seat - lowest
  // priority, filled only from whatever capacity S700/TLS didn't already
  // claim across the whole week, starting with S701's own home students first.
  for (const day of WEEKDAYS) {
    const { ctx, s701Instance } = perDay.get(day);
    fillSeatFromPool(s701Instance, homePool(frontDesk, 'S701'), ctx);
  }

  // Pass 2b: mix in the rest of the Front Desk roster for any S701 gap home
  // students couldn't cover, then Floaters as the true last resort
  // (avoidOrphans off - nothing else will ever try to cover S701 after this).
  // Floaters are the one way S701 ever gets help beyond its own home
  // students and regular mixing; regular Back Office still never touches
  // S701. Left uncovered (reported) if there's still nothing left.
  for (const day of WEEKDAYS) {
    const { ctx, s701Instance } = perDay.get(day);
    fillSeatFromPool(s701Instance, frontDesk, ctx);
    fillSeatFromPool(s701Instance, floaters, ctx, undefined, false);
  }

  // Pass 3: every available Back Office/Floater student gets their OWN
  // independent slot (not a shared gap that stops once "someone" covers it)
  // - multiple people at once is fine and expected, and this is what lets
  // everyone actually reach toward their 20-hour cap instead of being
  // crowded out by whoever got picked first. Day-share capped so nobody
  // front-loads their whole week into 2-3 days. `backOfficeInstance.gap` is
  // reduced by whatever got assigned purely so any stretch nobody ended up
  // covering can still be surfaced below - it never blocks or limits who
  // gets scheduled.
  for (const day of WEEKDAYS) {
    const { ctx, backOfficeInstance } = perDay.get(day);
    const assigned = assignBackOfficeIndependently([...backOffice, ...floaters], ctx);
    backOfficeInstance.gap = subtractIntervals(backOfficeInstance.gap, assigned);
  }

  // Pass 4: S700's second physical seat, filled opportunistically to help
  // whoever's furthest below the 20-hour cap catch up - never at the
  // expense of any seat's required coverage above, since this only runs
  // after every other pass has already claimed what it needed. Scored
  // purely by current weekly minutes (lowest wins), not days-worked or
  // gap-closure, since maximizing hours for the most under-utilized person
  // is the entire point of this pass. Deliberately NOT added to the
  // gap-reporting loop below: leaving this seat partially or fully empty on
  // a given day is completely fine, it's bonus capacity, not a requirement.
  for (const day of WEEKDAYS) {
    const { ctx } = perDay.get(day);
    const s700SecondSeat = { location: 'S700', gap: [{ start: OFFICE_START, end: OFFICE_END }] };
    fillSeatFromPool(
      s700SecondSeat,
      [...frontDesk, ...floaters, ...backOffice],
      ctx,
      'bonus: 2nd S700 seat - extra hours',
      false,
      false,
      true
    );
  }

  // Anything still uncovered is reported, not silently dropped.
  for (const day of WEEKDAYS) {
    const { s700Instance, tlsInstance, s701Instance, backOfficeInstance } = perDay.get(day);
    for (const seatInstance of [s700Instance, tlsInstance, s701Instance, backOfficeInstance]) {
      for (const gap of seatInstance.gap) {
        gaps.push({ day, location: seatInstance.location, start: gap.start, end: gap.end });
      }
    }
  }

  return { generatedRows: mergeAdjacentRows(generatedRows), gaps, warnings };
}

// Collapses back-to-back rows for the same student/day/location/reason (e.g.
// a flex assignment that got greedily built up across two restart passes)
// into a single row, so the calendar doesn't show artificial shift splits.
function mergeAdjacentRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.day}|${row.location}|${row.studentName}|${row.reason}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const merged = [];
  for (const group of groups.values()) {
    group.sort((a, b) => a.start - b.start);
    let current = null;
    for (const row of group) {
      if (current && row.start <= current.end) {
        current.end = Math.max(current.end, row.end);
      } else {
        if (current) merged.push(current);
        current = { ...row };
      }
    }
    if (current) merged.push(current);
  }
  return merged;
}

module.exports = {
  OFFICE_START,
  OFFICE_END,
  MIN_SHIFT_MINUTES,
  WEEKDAYS,
  parseTimeToMinutes,
  formatMinutesToTime,
  computeAvailability,
  generateWeeklySchedule,
};
