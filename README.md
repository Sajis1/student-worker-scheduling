# Student Worker Scheduling & Management System

Internal tool for the UHD PMO (Project Management Office) to manage student worker
class schedules, time-off requests, and (in later phases) work schedule generation.

## Architecture

- **Smartsheet is the single source of truth.** There is no separate database.
- **`backend/`** is a small Express API. It is the *only* thing that ever talks to
  the Smartsheet API directly, because it holds the Smartsheet API token as a
  server-side secret. It exposes a small REST API of its own to the frontend.
- **`frontend/`** is plain HTML/CSS/JS with no build step and no framework. It only
  ever calls `backend/`, never Smartsheet directly. This is intentional so a future
  student developer can open the files and understand them without tooling
  knowledge.
- **No login / authentication system.** UHD Azure AD SSO was not available for
  Phase 1 (no access to register an app in UHD's tenant). Instead, students pick
  their own name from a dropdown populated from the Student Master sheet, filtered
  to rows where `Active` is checked. This is a known, accepted tradeoff for Phase 1.
- **Notifications are not sent by the backend.** Phase 3 will use Power Automate
  watching the Smartsheet `Status` column for changes to trigger emails.

```
frontend (HTML/CSS/JS) --> backend (Express) --> Smartsheet API
```

## Phases

- **Phase 1 (this scaffold):** architecture, Student Master / Class Schedule /
  Time Off Requests sheets, student portal (pick name, submit class schedule,
  submit/view time-off requests).
- **Phase 2 (next):** manager dashboard, live calendar view, automatic schedule
  generation. See "Office Coverage Rules" below for the full scheduling logic.
  Managers can manually override anything the generator produces.
- **Phase 3:** reports, exports, time-off approval workflow polish, Power
  Automate email notifications.
- **Phase 4:** future enhancements (analytics, historical schedules,
  Teams/Outlook integration, AI scheduling suggestions).

## Smartsheet sheets

You (not Claude) create these sheets by hand in Smartsheet. **Column names must
match exactly** (case-sensitive) — the backend looks up columns by title, not by
position.

### 1. Student Master

Used to populate the "pick your name" dropdown. Only rows with `Active` checked
are shown to students.

| Column name    | Type            | Notes                                  |
|----------------|-----------------|-----------------------------------------|
| Student Name   | Text/Number     | Primary column. Full name as displayed. |
| Student ID     | Text/Number     | UHD student ID / employee ID.           |
| Email          | Text/Number     | UHD email address.                      |
| Active         | Checkbox        | Only checked rows appear in the dropdown.|
| Position       | Text/Number     | e.g. "Student Worker".                  |
| Supervisor     | Text/Number     | Manager's name.                         |
| Role           | Dropdown        | "Front Desk", "Back Office", or "Floater". Which pool this student belongs to for scheduling (Phase 2) — see "Floater" note below. |
| Primary Location | Dropdown      | "S700", "TLS", or "S701". This student's default/home seat. Blank for Back Office students — they don't have one until the coverage rules flex them to S701. |

### 2. Class Schedule

Each row is one class block for one student. A student with 4 classes has 4 rows.

| Column name     | Type        | Notes                                        |
|------------------|-------------|-----------------------------------------------|
| Student Name     | Text/Number | Must match a name from Student Master exactly.|
| Day              | Dropdown    | Monday, Tuesday, Wednesday, Thursday, Friday, Saturday, Sunday |
| Start Time       | Text/Number | e.g. "09:00 AM". Stored as text in Phase 1.   |
| End Time         | Text/Number | e.g. "10:15 AM".                              |
| Course/Notes     | Text/Number | Optional, e.g. course number.                 |
| Semester         | Text/Number | e.g. "Fall 2026".                             |

### 3. Time Off Requests

| Column name     | Type        | Notes                                          |
|------------------|-------------|--------------------------------------------------|
| Student Name     | Text/Number | Must match a name from Student Master exactly.  |
| Start Date       | Date        |                                                  |
| End Date         | Date        |                                                  |
| Reason           | Text/Number | Optional.                                       |
| Status           | Dropdown    | Pending, Approved, Denied. Defaults to Pending. |
| Submitted Date   | Date        | Set automatically by the backend on submit.     |

### 4. Work Schedule

Holds the generated (and manually overridden) weekly schedule. **This is a
recurring weekly pattern for a semester, not dated instances** — one row means
"this student works this day/location/time every week of that semester."

| Column name  | Type     | Notes                                                    |
|--------------|----------|--------------------------------------------------------------|
| Student Name | Text/Number | Must match Student Master exactly.                       |
| Day          | Dropdown | Monday–Friday only (office hours are M–F).                  |
| Location     | Dropdown | S700, TLS, S701, Back Office                                |
| Start Time   | Text/Number | e.g. "8:00 AM" — text, same style as Class Schedule.      |
| End Time     | Text/Number | e.g. "12:00 PM"                                           |
| Semester     | Text/Number | e.g. "Fall 2026"                                          |
| Source       | Dropdown | "Generated" or "Manual" — always server-set. This is what lets manual overrides survive regeneration. |
| Notes        | Text/Number | Optional — a manager's override reason, or an auto-note like "flex: pulled from S701". |
| Last Updated | Date     | Server-stamped on every create/update.                       |

**How overrides survive regeneration:** `POST /api/work-schedule/generate` only
ever deletes+recreates rows where `Source` is `Generated`, for the target
semester. `Source: 'Manual'` rows are never deleted by Generate, and the
generator treats their day/time as already occupied (both for that student and
for that seat) so it won't double-book over them. Editing any row via the
dashboard (`PUT /api/work-schedule/:rowId`) unconditionally sets
`Source: 'Manual'`, regardless of what it was before — that's the entire
override mechanism.

## Office Coverage Rules (Phase 2 scheduling logic)

This is the scheduling policy the Phase 2 auto-scheduler must implement. Captured
here so it isn't lost in chat history.

**S700 and TLS must always have full 8:00 AM–5:00 PM Monday–Friday coverage —
this is the top scheduling priority**, and outranks spreading hours evenly
across the roster whenever the two genuinely conflict. If one student is the
only one who can single-handedly close a whole day's gap, they get picked for
that whole day even if it means they work more days this week than someone
else. See the scoring rule under "How this is actually implemented" below.

**Office hours:** Monday–Friday, 8:00 AM – 5:00 PM.
**Students may never be scheduled during their class times** (from Class Schedule) —
this applies whether or not the student has actually submitted a class schedule;
**every class block also gets a 30-minute buffer on both sides** — a shift
never starts the instant class ends or has to end the instant class begins,
so students get a small break to get from class to work (or work to class).
The buffer is clamped to office hours (8 AM–5 PM); a class right at the
start or end of the day doesn't create a buffer reaching outside office
hours, since there's nothing to protect out there.
a student with zero Class Schedule rows is simply treated as free all day.
**Minimum shift: 4 hours, except as an absolute last resort for S700/TLS.**
No shift is ever generated shorter than this — if the only coverage
available for a gap would be under 4 hours, the gap is left uncovered and
reported, rather than assigning a short shift. **The one exception: if a
sub-4-hour sliver is the only thing standing between S700 or TLS and full
8-5 coverage for the day, and nothing else (home pool, mixed Front Desk,
Floaters, Back Office cascade) could close it at normal length, a short
shift is assigned anyway** — full S700/TLS coverage outranks the 4-hour
floor. This never applies to S701 or Back Office; those gaps are still just
reported. A short shift like this is tagged in Notes with "short shift:
only way to close a full coverage day" so it's obvious at a glance on the
dashboard.
**Maximum 20 hours per student per week** (hard cap, enforced across the whole
week, not per day).
**One continuous shift per day per student** — a student is never split into two
separate blocks on the same day (e.g. clocking in for a morning block, leaving,
then coming back for a separate afternoon block). Once a student is assigned
anything on a given day, they're done for that day. **A full 8am-5pm day
includes a mandatory unpaid 1-hour lunch break, 12:00-1:00 PM** — the row
stays a single 8:00 AM-5:00 PM block (not split visually), but only 8 of the
9 hours count toward the 20-hour weekly cap and the Weekly Hours summary; the
row's Notes get an "includes unpaid lunch 12-1 PM (8 hrs counted)" tag so it's
still visible. The lunch hour is *not* left as an open coverage gap for that
seat in isolation — see the S700-S701 lunch rule below.

**Staffing:** Front Desk and Back Office student workers, plus any Floaters
cross-trained for both (see below). Exact headcount lives in Student Master,
not in code.

**Front Desk seats — 2 required, S700's 2nd seat and S701 both opportunistic:**
- S700 — required, 1 seat for scheduling purposes, filled first and
  guaranteed 8-5 coverage like TLS. Physically has a 2nd chair, which gets
  filled **after everything else**, purely as bonus capacity to help
  whoever's furthest below the 20-hour weekly cap catch up on hours — it's
  never used to help close a coverage gap (that's what the required 1st
  seat, mixing, Floaters, and the Back Office cascade are for) and it's
  fine for it to sit empty on days nobody needs the extra hours. Tagged in
  Notes with "bonus: 2nd S700 seat - extra hours" so it's obviously
  distinct from required coverage. A manager can always manually add or
  edit a second S700 shift too.
- TLS — required, 1 seat.
- **S701 — the overflow/flex seat.** It gets *no equal claim* on weekly
  capacity: S700 and TLS are filled across the entire week first, and S701
  only picks up whatever's genuinely left over afterward. It's expected and
  fine for S701 to end up with real gaps on some days — that's the tradeoff
  that lets S700/TLS reach full 5-day coverage instead of all three seats
  running short on Thursday/Friday.
  **Exception: on any day S700 ends up covered by exactly one person for the
  entire 8-5 day**, S701 jumps up to the SAME week-wide priority as S700/TLS
  for that specific day, so there's actually someone stationed nearby who can
  step in for S700 during that person's lunch. This is the one case where
  S701 doesn't just get leftovers.

**Students stay at their home (Primary Location) seat first.** Mixing across
S700/TLS/S701 is a fallback, not a default — a student only gets moved off
their home seat once their home seat's own students genuinely can't cover a
gap. A row gets a `mix: normally X` note whenever this fallback fires.

**Coverage cascade** — S700 and TLS can additionally pull in a Back Office
student as the true last resort, once no Front Desk student (home first, then
the full mixed pool) can cover the gap. **S701 is never backed up by regular
Back Office** — if nobody's available for it, it's reported as an uncovered
gap, unless a Floater can cover it (see below).

**Floaters** are students cross-trained for both areas (e.g. Samantha).
Unlike regular Back Office students, a Floater is eligible to help cover
*any* Front Desk seat — including S701, which regular Back Office never
touches. A Floater's default resting place is Back Office, same as everyone
else with no Front Desk shift that day. **A Floater is strictly lower
priority than a regular Front Desk student for mixing** — a Floater only
gets pulled to Front Desk once no regular Front Desk student (home or mixed)
can cover the gap; otherwise they just stay on Back Office duty. This is the
intended way to get S701 backup without loosening the rule for staff who
aren't cross-trained for the front desk: mark only the students who actually
are as "Floater," not everyone in Back Office.

**Semester schedule generation order:**
1. Read every student's class schedule (whether or not they've actually
   submitted one — a student with no rows is just treated as free all day).
2. Remove times that conflict with class.
3. Remove periods covered by approved time off.
4. Fill S700 and TLS across the entire week from their own home students
   first, then mix in the rest of the Front Desk roster for whatever gap
   remains, then Floaters, then escalate any still-remaining gap to Back
   Office.
5. Only then fill S701, across the entire week — home students first, then
   mixed Front Desk, then Floaters as the true last resort — from whatever
   capacity is genuinely left over.
6. Managers can always manually override anything the generator produced.

**Avoiding unfillable fragments — but only self-inflicted ones:** at every
tier except a seat's absolute last resort, the generator prefers to leave a
gap fully open rather than lock in an assignment that runs a candidate right
up against their **20-hour weekly cap**, stranding an awkward sub-4-hour
sliver behind that nobody could ever legally fill. That's a fixable, self-
inflicted fragment - a different, less-worked candidate could often cover the
whole remaining stretch cleanly instead. This does **not** apply to a gap
caused by a candidate's own real availability (e.g. a class right before or
after their free window) — that gap is real no matter who's picked, and
skipping the candidate over it would only throw away a legitimate partial
shift in favor of someone with cleaner full-day availability. Concretely:
if Jenny (S701 home) is only free 11:15 AM–5 PM because of a morning class,
she still gets picked for that real window — the 8–11:15 AM gap is reported
as-is, and a Floater is *not* pulled in to cover the whole day just because
it would look tidier. Home priority beats gap-minimization; only the weekly
cap's own artificial truncation gets worked around.

### How this is actually implemented — `backend/src/scheduler.js`

Pure module, no Express or Smartsheet calls, so it can be exercised without
network access. Time is represented in minutes-since-midnight.

- **`computeAvailability` pads every class block by `CLASS_BUFFER_MINUTES`
  (30 min) on both sides before subtracting it from the office day**,
  clamped to 8 AM–5 PM — this is what guarantees a student's shift never
  starts the instant their class ends or has to end the instant their next
  class begins. It's applied once, at the availability-computation level,
  so every downstream pass (home pool, mixing, Floaters, Back Office,
  the S700 2nd seat) automatically respects it without any special-casing.
- Runs in seven passes over the whole week, sharing one persistent per-day
  state (availability/usedToday/weeklyMinutes/daysWorked) across all of them:
  **Pass 1a** fills S700 then TLS for every day from home (Primary-Location-
  matched) students only; **Pass 1b** mixes in the rest of the Front Desk
  roster for whatever S700/TLS gap remains, then Floaters, then cascades to
  Back Office (the true last resort); **Pass 1c** identifies which days ended
  up with S700 covered by exactly one person for the full 8-5 day, and for
  those days ONLY, fills S701 (home then mixed Front Desk) with the same
  priority S700/TLS just got — this is the lunch-backup rule; **Pass 2a**
  fills S701 for every remaining day from its own home students (idempotent
  no-op for days pass 1c already handled); **Pass 2b** mixes in the rest of
  the Front Desk roster, then Floaters as the true last resort, for whatever
  S701 gap remains; **Pass 3** independently assigns every available Back
  Office/Floater student their own day-share-capped slot (not a shared gap -
  see below) from whatever's left of their availability after all the Front
  Desk passes above; **Pass 4** opportunistically fills S700's 2nd physical
  seat from the full combined roster, purely to help whoever's furthest
  below the 20-hour cap catch up on hours (see below). Running each tier
  across the *whole week* before moving to the next tier is what makes
  "home first," "S701 is lowest priority," "Floaters are last resort," and
  "S701 backs up a lone S700" all genuinely week-wide rules, not per-day ones.
- Each seat is filled greedily from whichever pool that pass is using:
  repeatedly pick the best-scoring candidate, assign their available overlap
  with the seat's remaining uncovered time, and repeat until the seat is
  covered or the pool is exhausted — it's a heuristic, not a globally optimal
  solver. S700's second seat is *not* attempted by the generator at all.
  Regular Back Office students are only ever added in the separate
  Back-Office-cascade step for S700/TLS (never for S701); Floaters are the
  one pool eligible for every seat, but only after regular Front Desk mixing
  is exhausted.
- **`fillSeatFromPool`'s `avoidOrphans` parameter (true by default) is the
  fragment-avoidance rule**: a candidate is skipped only when `cappedEnd <
  overlap.end` (their weekly budget, not their real availability, is what cut
  the assignment short) **and** that truncation would leave a sub-4-hour
  sliver of the *current* gap window behind. A gap caused by the candidate's
  own availability window starting late or ending early is never grounds to
  skip them — there's no `wasCapTruncated` flag in that case, so the check
  doesn't fire and they're used for whatever real time they have. `avoidOrphans`
  is turned off (`false`) entirely only for a seat's absolute last-resort tier
  in a given pass chain — the Back Office cascade for S700/TLS, and the
  Floater tier for S701 — so a real gap still gets *something* rather than
  staying open once nothing better remains to try.
- **A student with a Role that isn't exactly "Front Desk", "Back Office", or
  "Floater" (including blank) is silently excluded from scheduling** and
  surfaced in the response's `warnings[]` array by name, rather than causing
  an error or silently vanishing without explanation.
- **Scoring (`candidateScore`) puts full, gap-free coverage of the *current*
  gap first, above everything else.** A candidate whose available overlap
  exactly matches the seat's whole remaining gap window (`closesGapFully`)
  always wins, even over someone who's worked fewer days so far — S700/TLS
  actually having zero gaps every day matters more than an evenly-spread
  roster. Only when nobody can achieve full closure does the tie-break fall
  back to **whoever has worked fewer days so far this week**, and only after
  that does raw overlap length matter. This is what spreads the roster across
  all 5 days when a single person genuinely can't cover a whole day alone,
  while still handing an entire day to one fully-available person when that's
  what it takes to avoid a gap. Concretely: on a day where one student
  (S701-primary, say) has zero classes and could single-handedly cover TLS
  8 AM–5 PM, they now win that day even if they already worked Monday and
  Tuesday — beating two other partially-available students who'd each leave
  a stub of the day uncovered if picked instead.
- **Any candidate whose available overlap is under 4 hours (240 minutes) is
  skipped entirely** for that pick — a gap either gets a real 4+ hour shift or
  stays a reported gap, never a short filler shift. **Exception: `fillSeatFromPool`'s
  `allowShortShift` parameter (false by default)** waives this check entirely.
  It's turned on for exactly one call per day, per seat, and only for S700/TLS:
  a final pass, after home pool, mixed Front Desk, Floaters, and the Back
  Office cascade have all already run and a gap still remains, offered to the
  full combined roster (`frontDesk + floaters + backOffice`) with
  `avoidOrphans` off too. This is what closes a gap like "8:00-11:15 AM left
  over after everyone else who could legally take a 4+ hour chunk already has"
  — genuinely nobody's fault, just a structural leftover smaller than the
  minimum, and S700/TLS's "always covered" rule wins over the 4-hour floor
  once every normal-length option is exhausted. Tagged in Notes with "short
  shift: only way to close a full coverage day" (overriding the usual
  `mix:`/`floater:` tag) so it's never mistaken for a normal assignment.
- **A student can be picked at most once per day** — as soon as they're
  assigned anything, they're removed from consideration for every other seat
  that same day. This guarantees one continuous shift per day.
- **Whenever a single assigned block is the exact full office day (8:00 AM to
  5:00 PM), the row stays one continuous block** (not split) but gets an
  "includes unpaid lunch 12-1 PM (8 hrs counted)" note via `isFullOfficeDay()`
  / `workedMinutesFor()`, and only 8 of the 9 hours count toward the weekly
  cap and the Weekly Hours summary. This is scoped narrowly on purpose: it
  only fires for an exact full-day block, not any shift over some length,
  since the only rule actually stated is "working 8-5 means a mandatory
  1-hour lunch." A shift truncated short of 5:00 PM by the weekly cap (e.g.
  8:00 AM-4:00 PM) does *not* get this treatment. The manager dashboard's
  Weekly Hours summary applies the same 60-minute deduction client-side by
  checking each row's Notes for "unpaid lunch."
- **A running weekly-minutes total per student caps every pick at 20 hours
  (1200 minutes) total**, persisted across the whole Monday–Friday loop.
  Once their budget hits zero they're excluded from every remaining day.
  **The cap-truncation math (`budgetCappedEnd`) is lunch-aware**: a full
  8 AM–5 PM day only actually *costs* 480 worked minutes against the cap
  (thanks to the unpaid-lunch deduction), even though it spans 540 raw
  calendar minutes. Naively capping by raw minutes used to truncate a
  fully-available candidate's last hour whenever their remaining budget was
  exactly 480 — e.g. someone with 480 minutes left would get cut off at 4:00
  PM instead of 5:00 PM, which then tripped `avoidOrphans` (a 60-minute
  tail nobody could legally cover) and disqualified them entirely, even
  though they could really work the whole day for exactly 480 counted
  minutes. `budgetCappedEnd` now checks whether the discounted lunch-day
  cost fits the remaining budget *before* falling back to a raw-minute cap,
  so a candidate who can genuinely close a whole day within their remaining
  20-hour budget is never short-changed by an accounting quirk of the lunch
  rule. This is what let a student with exactly 480 minutes left close a
  previously-unfillable Wednesday-morning TLS gap.
  > **Known tradeoff:** 1200 minutes doesn't divide evenly into 480-minute
  > (8-hour, lunch-adjusted) days, so a fully-available student typically
  > ends up with 2 full days and a partial 3rd. With the current roster, S700
  > and TLS reach full 5-day coverage; S701 absorbs whatever shortfall is
  > left, usually still getting partial coverage most days (helped by the
  > lunch-backup rule above) but not always the full 9 hours — a real
  > capacity signal (surfaced in `gaps[]`), not a bug. Adding another backup
  > student is the direct fix if full 5-day/9-hour coverage on every seat is
  > needed every week.
- **Back Office is NOT a shared "stop once someone covers it" gap like the
  Front Desk seats** — it has no seat-capacity limit at all. Every available
  Back Office/Floater student gets their own independent slot via
  `assignBackOfficeIndependently()`, and multiple students overlapping in
  time is expected and encouraged, not something the generator tries to
  avoid. This maximizes how close everyone gets to their 20-hour cap, rather
  than stopping at the minimum needed to keep one person present.
- **Back Office day-spreading uses a different mechanism than Front Desk**:
  `backOfficeDailyBudget()` caps each student's *own* daily pick at their
  fair daily share (remaining weekly budget ÷ remaining weekdays, floored at
  the 4-hour minimum). Front Desk seats don't need this — their spreading
  comes from the days-worked scoring competition between candidates — but
  Back Office assignment has no equivalent competition to lean on (nobody's
  competing for anybody else's slot), so without this explicit per-student
  cap a fully-available student would burn all 20 hours in the first 2-3
  days and vanish from the schedule for the rest of the week.
- After independent assignment, whatever stretch of the day nobody happened
  to cover is still surfaced in `gaps[]` — informational only, it never
  limits or gates who gets scheduled. A Back Office gap most often just means
  there weren't enough Back Office/Floater students with availability at
  that specific hour, not that the generator held anyone back.
- **Pass 4 fills S700's 2nd physical seat, strictly after every other pass**,
  from the full combined roster (`frontDesk + floaters + backOffice`), using
  a different scoring mode entirely: `fillSeatFromPool`'s `maximizeUnderutilized`
  flag ranks candidates by lowest current `weeklyMinutes` first (not the
  usual closure-bonus/days-worked scoring), so whoever's banked the fewest
  hours so far wins the slot — this is what let Natalie, whose fragmented
  class schedule kept losing her the competition for the required seats,
  actually catch up toward 20 hours once the required coverage everywhere
  else was already locked in. It's a separate `{location: 'S700', gap: [...]}`
  seat instance, so it never touches or reduces the required 1st seat's own
  gap tracking, and it's deliberately excluded from the final `gaps[]`
  report — an empty slot here is not a problem.
- **S700's two seats have no separate identity in the data** (there's no "seat
  A vs seat B" column) — the generator only ever fills one anyway. A manual
  edit that adds a second S700 shift is fine; the manager dashboard does a
  client-side check and visually flags a cell if manual edits ever create more
  overlapping assignments than a seat can physically hold.
- **Students who haven't submitted any Class Schedule rows are still
  included** and scheduled as if free all day — the generator's student list
  comes straight from Student Master (filtered to Active), not from who has
  class-schedule data.

> **Time off vs. the recurring weekly pattern — read this before being
> surprised by it.** Time Off Requests are date-ranged ("July 15–24"), but Work
> Schedule has no dates at all — it just repeats every week of the semester.
> Those two shapes don't reconcile automatically. `POST
> /api/work-schedule/generate` takes an `asOfDate` (the manager dashboard
> defaults it to today, but it's editable). A student with an *approved* time
> off request covering `asOfDate` is left out of the generated pattern
> entirely. When their time off ends, **the manager must re-run Generate** for
> them to reappear — it doesn't happen automatically. Short, one-off absences
> (a single sick day) aren't a good fit for this mechanism at all; the expected
> workflow is for the manager to manually edit that one day's calendar entry
> instead of relying on Time Off + regeneration.

## Setup

### 1. Create the Smartsheet sheets

Create the four sheets above in your Smartsheet account with those exact column
names. Note each sheet's Sheet ID (Smartsheet: right-click sheet tab or
File > Properties, or use "Sheet ID" via the app).

### 2. Generate a Smartsheet API token

Smartsheet account > Apps & Integrations > API Access > Generate new access token.

### 3. Configure the backend

```
cd backend
copy .env.example .env
```

Fill in `.env`:

```
SMARTSHEET_API_TOKEN=your_token_here
STUDENT_MASTER_SHEET_ID=your_sheet_id_here
CLASS_SCHEDULE_SHEET_ID=your_sheet_id_here
TIME_OFF_SHEET_ID=your_sheet_id_here
WORK_SCHEDULE_SHEET_ID=your_sheet_id_here
PORT=3001
```

### 4. Run the backend

```
cd backend
npm install
npm start
```

Visit `http://localhost:3001/api/health` — it should return `{"ok":true}`.

### 5. Run the frontend

The frontend has no build step. Just open `frontend/index.html` in a browser, or
serve the folder with any static file server. It expects the backend at
`http://localhost:3001` (see `frontend/js/api.js` — change `BASE_URL` there if
your backend runs elsewhere).

### 6. Run the manager dashboard

Also no build step: open `frontend/manager.html` directly in a browser (same
running backend as the student portal). There's no login/identification here
either, same accepted tradeoff. Not embedded in SharePoint or hosted anywhere
beyond localhost yet — both are out of scope for now.

The dashboard's bottom panel, "Weekly Hours," lists every student's total
scheduled hours for the semester currently shown on the calendar (computed
client-side from the same rows the calendar renders, so it's always in sync
with manual edits too, not just freshly generated schedules).

## Backend API (frontend-facing, not Smartsheet's API)

| Method | Path                  | Purpose                                    |
|--------|------------------------|---------------------------------------------|
| GET    | /api/students          | Active students for the name dropdown.     |
| GET    | /api/students/roster   | All students (active or not) with Role/Primary Location — manager dashboard only, never exposed to the student portal. |
| GET    | /api/class-schedule?student=Name | A student's class schedule rows. |
| POST   | /api/class-schedule    | Add one class schedule row.                |
| GET    | /api/time-off?student=Name | A student's time-off requests.          |
| POST   | /api/time-off          | Submit a new time-off request (Status defaults to Pending). |
| PATCH  | /api/time-off/:rowId/status | Manager approves/denies a request (`{status: 'Approved'\|'Denied'}`). |
| GET    | /api/work-schedule?student=&semester= | Work Schedule rows, optionally filtered. |
| POST   | /api/work-schedule/generate | Runs the scheduler for a semester/asOfDate; replaces that semester's Generated rows, leaves Manual rows untouched. |
| POST   | /api/work-schedule     | Manually add one shift (always `Source: 'Manual'`). |
| PUT    | /api/work-schedule/:rowId | Edit a shift (always forces `Source: 'Manual'`). |
| DELETE | /api/work-schedule/:rowId | Delete a shift, regardless of Source.     |

## What's NOT done yet

- The scheduling algorithm is a greedy heuristic, not a globally-optimal
  solver — see the callout above.
- The manager dashboard's calendar grid still visually reserves 2 rows worth
  of space for S700 in case a manager manually adds a second shift there —
  the generator itself never produces one on its own anymore.
- No request locking/concurrency control (e.g. two people editing the same
  shift at once is last-write-wins) — same class of tradeoff as the no-auth
  decision.
- Real hosting and embedding the manager dashboard in SharePoint remain
  explicitly out of scope — everything still only runs on localhost.
- Phase 3 (reports/exports, full time-off approval workflow polish with audit
  trail, Power Automate email notifications) hasn't been started.
