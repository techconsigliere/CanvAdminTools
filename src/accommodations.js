/*
 * Quiz Accommodations for Canvas Classic Quizzes, v0.4
 * techconsigliere
 *
 * Run from any page inside a Canvas course. It uses the signed-in user's own
 * session and permissions. It reads the course's quizzes, the student roster,
 * existing quiz extensions, and date overrides; previews what the chosen
 * accommodations would change; and, only after the instructor confirms, writes
 * those changes to Canvas and re-reads them to verify.
 *
 * Extensions are only ever raised, never reduced or removed. Where a quiz's
 * availability window is too short for a student's accommodated time, the
 * instructor can opt in to an individual date override for that student; the
 * quiz's dates for the rest of the class never change.
 *
 * It stores nothing in the browser and sends nothing anywhere except the
 * Canvas host it runs on.
 *
 * v0.4
 *  - Roster includes invited students (enrolled but not yet accepted), who are
 *    most of the roster in week one, which is exactly when accommodation
 *    letters arrive. Their rows are tagged.
 *  - A 403 from a tripped rate limiter no longer reports itself as a
 *    permissions problem. The tool backs off, retries, and says which it was.
 */
(() => {
  'use strict';

  const TOOL_ID = 'qacc-tool';
  const VERSION = '0.4.1';
  const HOME = 'https://techconsigliere.github.io/CanvAdminTools/teacher/';
  const CONCURRENCY = 3;        // reads in flight at once while loading
  const RATE_FLOOR = 150;       // pause briefly when X-Rate-Limit-Remaining drops below this
  const RATE_RETRIES = 3;       // retries after a rate-limit refusal
  const RATE_BACKOFF = 2000;    // ms, multiplied by the attempt number

  // Running the bookmarklet a second time closes the panel.
  const alreadyOpen = document.getElementById(TOOL_ID);
  if (alreadyOpen) { alreadyOpen.remove(); return; }

  const match = location.pathname.match(/^\/courses\/(\d+)/);
  if (!match) {
    alert('Quiz Accommodations: open a page inside a Canvas course, then run it again.');
    return;
  }
  const courseId = match[1];
  const previousFocus = document.activeElement;

  // The access center's criteria. Extra time is one choice; the extra attempt is independent.
  const TIME_PRESETS = {
    none: { label: 'No extra time',        extra: () => 0 },
    p50:  { label: '50% additional time',  extra: (limit) => Math.ceil(limit * 0.5) },
    p100: { label: '100% additional time', extra: (limit) => limit },
  };

  const TYPE_LABELS = {
    practice_quiz: 'Practice quiz',
    graded_survey: 'Graded survey',
    survey: 'Ungraded survey',
  };

  const ACTION_TEXT = {
    write: 'would write',
    ok: 'already set',
    kept: 'larger existing grant kept',
  };

  // How the instructor can resolve a window that's too short, for one student only.
  const DATE_FIX_LABELS = {
    none: 'Leave dates as they are',
    extend: 'Extend "Available until" for this student',
    earlier: 'Open earlier for this student',
  };

  // API field name -> our quiz/date property name.
  const DATE_FIELDS = { unlock_at: 'unlockAt', due_at: 'dueAt', lock_at: 'lockAt' };

  const RATE_MESSAGE = 'Canvas is rate limiting these requests, which is a throttle, not a ' +
    'permissions problem. Wait a minute and run it again.';

  // Becomes true once Canvas has shown us an extension for a student who hasn't
  // started a quiz (a "settings_only" quiz submission). Until then we can't be
  // sure the extension list includes them, which matters for the never-reduce rule.
  let settingsOnlyConfirmed = false;

  /* ---------------- Canvas API ---------------- */

  class ApiError extends Error {
    constructor(status, detail, rateLimited = false) {
      super(`Canvas returned ${status}${detail ? `: ${detail}` : ''}`);
      this.status = status;
      this.rateLimited = rateLimited;
    }
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Session-authenticated Canvas responses may start with "while(1);" as
  // JSON-hijacking protection, so strip it before parsing instead of res.json().
  const parseCanvasJson = (text) => JSON.parse(text.replace(/^while\(1\);/, ''));

  function firstErrors(body) {
    const errs = body && body.errors;
    if (Array.isArray(errs)) return errs.map((e) => e.message || String(e)).join('; ');
    if (errs && typeof errs === 'object') {
      return Object.values(errs).flat().map((e) => e.message || String(e)).join('; ');
    }
    return (body && body.message) || '';
  }

  // Canvas answers a tripped rate limiter with 403 and a body that names it,
  // which is indistinguishable from a permissions refusal unless you read the
  // body. Telling a teacher they lack rights they actually hold sends them to
  // the help desk with the wrong diagnosis, so check, back off, and retry. A
  // throttled request is refused at the gate and never processed, so retrying
  // it cannot double-apply a write.
  async function request(url, init) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, init);
      if (res.ok) return res;

      const text = await res.text();
      const limited = res.status === 403 && /rate limit exceeded/i.test(text);
      if (limited && attempt < RATE_RETRIES) {
        await sleep(RATE_BACKOFF * (attempt + 1));
        continue;
      }
      let detail = '';
      if (limited) {
        detail = 'rate limit exceeded';
      } else {
        try { detail = firstErrors(parseCanvasJson(text)); } catch { /* keep status only */ }
      }
      throw new ApiError(res.status, detail, limited);
    }
  }

  // Canvas paginates with an RFC 5988 Link header; follow rel="next" until it's gone.
  function nextLink(header) {
    if (!header) return null;
    for (const part of header.split(',')) {
      const m = part.match(/<([^>]+)>;\s*rel="next"/);
      if (m) return m[1];
    }
    return null;
  }

  async function getAll(path, unwrap = (body) => body) {
    let url = path + (path.includes('?') ? '&' : '?') + 'per_page=100';
    const items = [];
    while (url) {
      const res = await request(url, {
        credentials: 'same-origin',
        cache: 'no-store',  // verification reads must come from Canvas, never the browser cache
        headers: { Accept: 'application/json' },
      });
      items.push(...unwrap(parseCanvasJson(await res.text())));
      const remaining = Number(res.headers.get('X-Rate-Limit-Remaining'));
      if (remaining && remaining < RATE_FLOOR) await sleep(1000);
      url = nextLink(res.headers.get('Link'));
    }
    return items;
  }

  async function readSubmissions(quizId) {
    const subs = await getAll(
      `/api/v1/courses/${courseId}/quizzes/${quizId}/submissions`,
      (body) => body.quiz_submissions || []
    );
    const byUser = new Map();
    for (const s of subs) {
      byUser.set(s.user_id, s);
      if (s.workflow_state === 'settings_only') settingsOnlyConfirmed = true;
    }
    return byUser;
  }

  const readOverrides = (assignmentId) =>
    getAll(`/api/v1/courses/${courseId}/assignments/${assignmentId}/overrides`);

  // Canvas puts the CSRF token in a cookie; state-changing requests must echo it
  // back in a header. URL-decode it first, since the cookie value is encoded.
  function csrfToken() {
    const m = document.cookie.match(/(?:^|;\s*)_csrf_token=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  async function send(method, path, body, token) {
    await request(path, {
      method,
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-CSRF-Token': token,
      },
      body: JSON.stringify(body),
    });
  }

  // One sentence naming why Canvas refused, for a failure that should stop the run.
  function refusalMessage(err, action, permission) {
    if (err.rateLimited) return `Stopped. ${RATE_MESSAGE} Nothing further was written.`;
    if (err.status === 401 || err.status === 403) {
      return `Stopped. Canvas denied the ${action}; you need permission to ${permission} in this course.`;
    }
    return null;
  }

  // Run fn over items with at most `limit` calls in flight.
  async function mapPool(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const i = next++;  // safe without a lock: JS runs this line atomically between awaits
        results[i] = await fn(items[i], i);
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
  }

  const toDate = (v) => (v ? new Date(v) : null);

  async function loadCourse(report) {
    report('Loading quizzes…');
    const rawQuizzes = await getAll(`/api/v1/courses/${courseId}/quizzes`);

    report('Loading the student roster…');
    // type[]=StudentEnrollment leaves out the Student View test student.
    // Invited students are enrolled but haven't accepted or logged in yet. They
    // are most of the roster in week one, which is when accommodation letters
    // arrive, so leaving them out hides exactly the students this tool exists for.
    const enrollments = await getAll(
      `/api/v1/courses/${courseId}/enrollments` +
      `?type[]=StudentEnrollment&state[]=active&state[]=invited`
    );
    // A student in two cross-listed sections has two enrollments; keep one row
    // per person, and treat them as active if any one enrollment is active.
    const students = new Map();
    for (const e of enrollments) {
      const invited = e.enrollment_state === 'invited';
      const existing = students.get(e.user_id);
      if (!existing) {
        students.set(e.user_id, {
          id: e.user_id,
          name: e.user?.sortable_name || e.user?.name || `User ${e.user_id}`,
          invited,
        });
      } else if (existing.invited && !invited) {
        existing.invited = false;
      }
    }

    let read = 0;
    const loaded = await mapPool(rawQuizzes, CONCURRENCY, async (q) => {
      const subs = await readSubmissions(q.id);
      // Ungraded quizzes have no assignment, so they have no overrides to read.
      const overrides = q.assignment_id ? await readOverrides(q.assignment_id) : [];
      report(`Reading existing extensions and dates: quiz ${++read} of ${rawQuizzes.length}…`);
      return { subs, overrides };
    });

    const quizzes = rawQuizzes.map((q, i) => ({
      id: q.id,
      title: q.title,
      url: q.html_url,
      assignmentId: q.assignment_id || null,
      timeLimit: q.time_limit || 0,  // null or 0 means untimed
      attempts: q.allowed_attempts,  // -1 means unlimited
      unlockAt: toDate(q.unlock_at), // for an instructor, these are the class-wide dates
      dueAt: toDate(q.due_at),
      lockAt: toDate(q.lock_at),
      onlyOverrides: Boolean(q.only_visible_to_overrides),
      published: q.published,
      type: q.quiz_type,             // assignment, practice_quiz, graded_survey, survey
      subs: loaded[i].subs,          // Map of user_id -> quiz submission
      overrides: loaded[i].overrides,
    }));

    return {
      quizzes,
      students: [...students.values()].sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  /* ---------------- Dates ---------------- */

  // An override only carries the date fields it actually changes; Canvas leaves
  // the others out of the JSON, and the student inherits the quiz's own date.
  // So a missing key means "inherit," while a key present with null means
  // "this student has no such date."
  function effectiveDates(quiz, override) {
    const dates = {};
    for (const [field, prop] of Object.entries(DATE_FIELDS)) {
      dates[prop] = override && field in override ? toDate(override[field]) : quiz[prop];
    }
    return dates;
  }

  // Which dates apply to this student, and whether the tool can safely change
  // them. Anything it can't reason about precisely goes to the instructor.
  function dateContext(quiz, overrides, studentId) {
    const base = effectiveDates(quiz, null);
    if (!quiz.assignmentId) {
      return { manual: 'Ungraded quiz: adjust dates on the quiz edit page.', dates: base };
    }
    if (quiz.onlyOverrides) {
      return { manual: 'Quiz is assigned only to specific students or sections: adjust on the quiz edit page.', dates: base };
    }
    if (overrides.some((o) => o.course_section_id || o.group_id)) {
      return { manual: 'Quiz has section or group dates: adjust on the quiz edit page.', dates: base };
    }
    const mine = overrides.find((o) => (o.student_ids || []).includes(studentId));
    if (mine && mine.student_ids.length > 1) {
      return {
        manual: 'Student shares an individual date override with other students: adjust on the quiz edit page.',
        dates: effectiveDates(quiz, mine),
      };
    }
    return { override: mine || null, dates: effectiveDates(quiz, mine) };
  }

  const sameTime = (a, b) => (!a && !b) || (a && b && Math.abs(a - b) < 1000);

  function sameOverride(a, b) {
    if (!a || !b) return !a && !b;
    return a.id === b.id &&
      Object.keys(DATE_FIELDS).every((f) => (f in a) === (f in b) && sameTime(toDate(a[f]), toDate(b[f])));
  }

  // The dates that move for a fix. applyDateFix fills in the rest.
  function fixDates(mode, dates, shortfall) {
    const ms = shortfall * 60000;
    if (mode === 'extend') {
      // Move "Available until" later, and the due date with it so the extended
      // finish isn't marked late.
      const fields = { lock_at: new Date(dates.lockAt.getTime() + ms) };
      if (dates.dueAt) fields.due_at = new Date(dates.dueAt.getTime() + ms);
      return fields;
    }
    if (mode === 'earlier') return { unlock_at: new Date(dates.unlockAt.getTime() - ms) };
    return {};
  }

  /* ---------------- Inference and planning ---------------- */

  const extOf = (sub) => ({ time: sub?.extra_time || 0, attempts: sub?.extra_attempts || 0 });

  // Work out which criteria a student's existing extensions already reflect,
  // so reruns open with accommodated students pre-selected.
  function infer(student, quizzes) {
    const result = { time: 'none', attempt: false, custom: false, notes: [] };

    const timed = quizzes.filter((q) => q.timeLimit > 0);
    const granted = timed
      .map((q) => ({ q, extra: extOf(q.subs.get(student.id)).time }))
      .filter((g) => g.extra > 0);
    if (granted.length) {
      const fits = ['p50', 'p100'].filter((key) =>
        granted.every((g) => g.extra === TIME_PRESETS[key].extra(g.q.timeLimit)));
      if (fits.length === 1) {
        result.time = fits[0];
        result.notes.push(
          `${TIME_PRESETS[fits[0]].label} on ${granted.length} of ${timed.length} timed quizzes`);
      } else {
        result.custom = true;
        result.notes.push(`Extra time on ${granted.length} quizzes doesn't match one preset`);
      }
    }

    const limited = quizzes.filter((q) => q.attempts > 0);
    const extraAttempts = limited
      .map((q) => extOf(q.subs.get(student.id)).attempts)
      .filter((n) => n > 0);
    if (extraAttempts.length) {
      if (extraAttempts.every((n) => n === 1)) {
        result.attempt = true;
        result.notes.push(
          `One extra attempt on ${extraAttempts.length} of ${limited.length} limited-attempt quizzes`);
      } else {
        result.custom = true;
        result.notes.push('Has extra attempts other than one');
      }
    }
    return result;
  }

  const compare = (current, target) =>
    current === target ? 'ok' : current > target ? 'kept' : 'write';

  // Compare one student's chosen criteria with what one quiz already has.
  // Never plans a reduction: a larger existing grant is reported as kept.
  function planCell(quiz, student, choice, now) {
    const sub = quiz.subs.get(student.id);
    const before = extOf(sub);
    const ctx = dateContext(quiz, quiz.overrides, student.id);
    const cell = {
      before, hadSub: Boolean(sub), fields: {}, ctx,
      time: null, attempt: null, startBy: null, dateIssue: null, warnings: [],
    };

    if (choice.time !== 'none' && quiz.timeLimit > 0) {
      const target = TIME_PRESETS[choice.time].extra(quiz.timeLimit);
      cell.time = { current: before.time, target, action: compare(before.time, target) };
      if (cell.time.action === 'write') cell.fields.extra_time = target;

      // "Available until" cuts off extra time, so check the student's own window.
      const { unlockAt, lockAt } = ctx.dates;
      const needed = quiz.timeLimit + Math.max(before.time, target);
      if (lockAt) {
        cell.startBy = new Date(lockAt.getTime() - needed * 60000);
        const windowMin = unlockAt ? (lockAt - unlockAt) / 60000 : Infinity;
        if (windowMin < needed) {
          // Round up: a window ending at 11:59:59 is a few seconds short of a whole minute.
          cell.dateIssue = { needed, windowMin: Math.floor(windowMin), shortfall: Math.ceil(needed - windowMin) };
        } else if (lockAt > now && cell.startBy < now) {
          cell.warnings.push('Too late now to start and still get the full accommodated time');
        }
      }
    }

    if (choice.attempt && quiz.attempts > 0) {
      cell.attempt = { current: before.attempts, target: 1, action: compare(before.attempts, 1) };
      if (cell.attempt.action === 'write') cell.fields.extra_attempts = 1;
    }

    cell.writes = Object.keys(cell.fields).length > 0;
    // In Classic Quizzes, workflow_state "untaken" means an attempt is open right now.
    if (cell.writes && sub?.workflow_state === 'untaken') {
      cell.warnings.push("Attempt in progress now; Apply skips this until it's submitted");
    }
    return cell;
  }

  /* ---------------- Applying ---------------- */

  const STOP_UNSEEN =
    "Stopped. Canvas didn't return this student's extension when the tool re-read it, so this " +
    "course's extension list appears to leave out students who haven't started a quiz. The tool " +
    "can't see hand-granted extensions for those students, so it stopped rather than risk " +
    "overwriting one. Check this student on the quiz's Moderate page.";

  async function applyExtensions(quiz, entries, token, counts) {
    // 1. Re-read just before writing, so a change made since the preview
    //    (a TA in another tab, say) is never overwritten with stale numbers.
    const fresh = await readSubmissions(quiz.id);
    const toSend = [];
    for (const e of entries) {
      const sub = fresh.get(e.student.id);
      const now = extOf(sub);
      if (now.time !== e.before.time || now.attempts !== e.before.attempts) {
        e.mark('skip', 'Extension not written: changed since the preview. Run Preview again.');
        counts.skipped++;
      } else if (sub?.workflow_state === 'untaken') {
        e.mark('skip', "Extension not written: attempt in progress. Run again after it's submitted.");
        counts.skipped++;
      } else {
        toSend.push({ e, sub, now });
      }
    }
    if (!toSend.length) return null;

    // 2. Write. When Canvas returned a record for this student, the current
    //    values were just read, so resend the untouched field at its current
    //    value; that holds whether Canvas keeps or resets a field left out of
    //    the request. With no record, the current values aren't actually
    //    known, so send only the field being raised.
    try {
      await send('POST', `/api/v1/courses/${courseId}/quizzes/${quiz.id}/extensions`, {
        quiz_extensions: toSend.map(({ e, sub, now }) => ({
          user_id: e.student.id,
          ...(sub ? { extra_time: now.time, extra_attempts: now.attempts } : {}),
          ...e.fields,
        })),
      }, token);
    } catch (err) {
      for (const { e } of toSend) e.mark('fail', `Extension not written: ${err.message}`);
      counts.failed += toSend.length;
      return refusalMessage(err, 'write', 'moderate quizzes');
    }

    // 3. Re-read and confirm Canvas now holds exactly what was intended:
    //    raised fields at their targets, and untouched fields unchanged.
    const after = await readSubmissions(quiz.id);
    quiz.subs = after;
    let stop = null;
    for (const { e } of toSend) {
      const sub = after.get(e.student.id);
      if (!sub) {
        e.mark('fail', 'Extension sent, but Canvas did not return it on re-read.');
        counts.failed++;
        stop = STOP_UNSEEN;
        continue;
      }
      const v = extOf(sub);
      const timeOk = v.time === ('extra_time' in e.fields ? e.fields.extra_time : e.before.time);
      const attemptsOk =
        v.attempts === ('extra_attempts' in e.fields ? e.fields.extra_attempts : e.before.attempts);
      if (timeOk && attemptsOk) {
        e.mark('done', 'Extension written and verified');
        counts.written++;
      } else {
        e.mark('fail', `Re-read shows +${v.time} min and +${v.attempts} attempts, not what was sent.`);
        counts.failed++;
        stop = 'Stopped. Canvas saved something other than what was sent; review the marked cell ' +
          "on the quiz's Moderate page before running again.";
      }
    }
    return stop;
  }

  // Creates or updates one student's individual date override, then verifies it.
  async function applyDateFix(quiz, e, token, counts) {
    const fix = e.dateFix;
    const base = `/api/v1/courses/${courseId}/assignments/${quiz.assignmentId}/overrides`;

    // Re-read first: if anyone changed this quiz's overrides since the preview,
    // the computed dates may be wrong, so don't write.
    const fresh = await readOverrides(quiz.assignmentId);
    const ctx = dateContext(quiz, fresh, e.student.id);
    if (ctx.manual || !sameOverride(ctx.override, fix.ctx.override)) {
      e.mark('skip', 'Dates not changed: date settings changed since the preview. Run Preview again.');
      counts.skipped++;
      return null;
    }

    // Write all three dates explicitly: the moved ones at their new values, the
    // others at the student's current values. Leaving a date out would make the
    // student inherit it invisibly, and the quiz edit page would show that date
    // as blank on the student's card, which reads as "no date at all."
    const moved = fixDates(fix.mode, ctx.dates, fix.shortfall);
    const fields = {};
    for (const [f, prop] of Object.entries(DATE_FIELDS)) {
      fields[f] = f in moved ? moved[f] : ctx.dates[prop];
    }
    const payload = {};
    for (const [f, d] of Object.entries(fields)) payload[f] = d ? d.toISOString() : null;
    try {
      if (ctx.override) {
        await send('PUT', `${base}/${ctx.override.id}`, { assignment_override: payload }, token);
      } else {
        await send('POST', base, { assignment_override: { student_ids: [e.student.id], ...payload } }, token);
      }
    } catch (err) {
      e.mark('fail', `Dates not changed: ${err.message}`);
      counts.failed++;
      return refusalMessage(err, 'date change', 'edit quizzes');
    }

    // Verify: the student must now have their own override carrying all three
    // dates, each at exactly the value sent.
    const after = await readOverrides(quiz.assignmentId);
    quiz.overrides = after;
    const now = dateContext(quiz, after, e.student.id);
    const ok = !now.manual && now.override &&
      Object.entries(DATE_FIELDS).every(([f, prop]) =>
        f in now.override && sameTime(now.dates[prop], fields[f]));
    if (ok) {
      const moved = fix.mode === 'extend'
        ? `Available until is now ${fmt(now.dates.lockAt)} for this student`
        : `Available from is now ${fmt(now.dates.unlockAt)} for this student`;
      e.mark('done', `${moved}; verified`);
      counts.dates++;
      return null;
    }
    e.mark('fail', "Date change sent, but the re-read dates don't match. Check the quiz edit page.");
    counts.failed++;
    return "Stopped. Canvas saved different dates than were sent; review the marked cell on the quiz's " +
      'edit page before running again.';
  }

  // Works one quiz at a time: extensions first, then any date fixes.
  // `plan` is [{ quiz, entries }]; see renderPreview for an entry's shape.
  async function applyPlan(plan, report) {
    const token = csrfToken();
    if (!token) throw new Error("Couldn't find Canvas's security token. Reload the page and try again.");

    const counts = { written: 0, dates: 0, skipped: 0, failed: 0 };
    let stop = null;

    for (let qi = 0; qi < plan.length && !stop; qi++) {
      const { quiz, entries } = plan[qi];
      report(`Working on quiz ${qi + 1} of ${plan.length}: ${quiz.title}`);

      const extEntries = entries.filter((e) => e.writes);
      if (extEntries.length) stop = await applyExtensions(quiz, extEntries, token, counts);

      for (const e of entries) {
        if (stop) break;
        if (e.dateFix && e.dateFix.mode !== 'none') stop = await applyDateFix(quiz, e, token, counts);
      }
    }

    if (stop) {
      for (const { entries } of plan) {
        for (const e of entries) if (e.hasWork() && !e.marked) e.mark('skip', 'Not attempted (run stopped)');
      }
    }
    return { ...counts, stop };
  }

  /* ---------------- DOM helpers ---------------- */

  // Build elements without innerHTML. Every string becomes a text node, so a
  // quiz title or student name containing markup can't inject into the page.
  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) {
      if (child == null || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  const fmt = (date) => date.toLocaleString([], {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });

  function describeChoice(choice) {
    const parts = [];
    if (choice.time !== 'none') parts.push(TIME_PRESETS[choice.time].label);
    if (choice.attempt) parts.push('one extra attempt');
    return parts.join(' + ');
  }

  function quizTags(q) {
    const tags = [
      q.timeLimit ? `${q.timeLimit} min` : 'Untimed',
      q.attempts === -1 ? 'Unlimited attempts' : `${q.attempts} attempt${q.attempts === 1 ? '' : 's'}`,
    ];
    if (q.unlockAt) tags.push(`Available from ${fmt(q.unlockAt)}`);
    if (q.lockAt) tags.push(`Available until ${fmt(q.lockAt)}`);
    if (!q.published) tags.push('Unpublished');
    if (q.type !== 'assignment') tags.push(TYPE_LABELS[q.type] || q.type);
    return tags.map((t) => el('span', { class: 'tag' }, t));
  }

  function changeLine(label, current, target, unit, action) {
    const text = action === 'write'
      ? `${label}: +${current} → +${target}${unit}`
      : `${label}: +${current}${unit}`;
    return el('div', { class: action }, `${text} (${ACTION_TEXT[action]})`);
  }

  // Returns the cell, plus the date-fix <select> when one is offered.
  function renderCell(cell, tally, studentName, quizTitle) {
    const lines = [];
    let dateSelect = null;
    if (cell.time) {
      tally[cell.time.action]++;
      lines.push(changeLine('Time', cell.time.current, cell.time.target, ' min', cell.time.action));
    }
    if (cell.attempt) {
      tally[cell.attempt.action]++;
      lines.push(changeLine('Attempts', cell.attempt.current, 1, '', cell.attempt.action));
    }
    if (cell.startBy && !cell.dateIssue) {
      lines.push(el('div', { class: 'muted' }, `Start by ${fmt(cell.startBy)}`));
    }
    if (cell.dateIssue) {
      tally.warnings++;
      const { needed, windowMin, shortfall } = cell.dateIssue;
      lines.push(el('div', { class: 'warn' },
        `⚠ The availability window is ${shortfall} min shorter than this student's accommodated ` +
        `time (${needed} min needed, ${windowMin} min open).`));
      if (cell.ctx.manual) {
        lines.push(el('div', { class: 'kept' }, cell.ctx.manual));
      } else {
        tally.dateFixable++;
        dateSelect = el('select', {
          'aria-label': `Date adjustment for ${studentName} on ${quizTitle}`,
        }, Object.entries(DATE_FIX_LABELS).map(([mode, label]) =>
          el('option', { value: mode }, mode === 'none' ? label : `${label} (${shortfall} min)`)));
        lines.push(el('div', { class: 'datefix' }, dateSelect));
      }
    }
    for (const w of cell.warnings) {
      tally.warnings++;
      lines.push(el('div', { class: 'warn' }, `⚠ ${w}`));
    }
    if (!lines.length) lines.push(el('span', { class: 'muted' }, 'Not applicable'));
    return { td: el('td', {}, lines), dateSelect };
  }

  function currentNote(found) {
    return found.notes.length
      ? [found.custom ? el('strong', { class: 'kept' }, 'Custom, review. ') : null,
         found.notes.join('; ')]
      : el('span', { class: 'muted' }, 'None');
  }

  function planCounts(plan) {
    let ext = 0, dates = 0;
    for (const { entries } of plan || []) {
      for (const e of entries) {
        if (e.writes) ext++;
        if (e.dateFix && e.dateFix.mode !== 'none') dates++;
      }
    }
    return { ext, dates };
  }

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  /* ---------------- Panel ---------------- */

  const CSS = `
#${TOOL_ID}{position:fixed;inset:4vh 4vw;z-index:100000;background:#fff;color:#2d3b45;
 border:1px solid #c7cdd1;border-radius:8px;box-shadow:0 10px 40px rgba(0,0,0,.3);
 display:flex;flex-direction:column;font:14px/1.45 Lato,"Helvetica Neue",Arial,sans-serif}
#${TOOL_ID} header{display:flex;align-items:center;justify-content:space-between;gap:12px;
 padding:12px 18px;border-bottom:1px solid #c7cdd1}
#${TOOL_ID} h2{margin:0;font-size:18px}
#${TOOL_ID} h3{margin:16px 0 6px;font-size:16px}
#${TOOL_ID} .panel-body{overflow:auto;padding:14px 18px;flex:1}
#${TOOL_ID} .notice{background:#eef6fb;border-left:4px solid #0374b5;padding:8px 12px;margin:0 0 12px}
#${TOOL_ID} .scroll{overflow-x:auto}
#${TOOL_ID} table{border-collapse:collapse;width:100%;margin:8px 0 16px}
#${TOOL_ID} caption{text-align:left;color:#56606a;padding-bottom:6px}
#${TOOL_ID} th,#${TOOL_ID} td{border:1px solid #e1e4e6;padding:6px 8px;text-align:left;vertical-align:top}
#${TOOL_ID} thead th{background:#f5f5f5}
#${TOOL_ID} .tag{display:inline-block;font-size:12px;font-weight:normal;padding:0 6px;
 margin:3px 4px 0 0;border-radius:3px;background:#eef0f1}
#${TOOL_ID} .tag.invited{background:#fdf6ec;color:#8a5300}
#${TOOL_ID} .write,#${TOOL_ID} .done{color:#0b6b2e;font-weight:bold}
#${TOOL_ID} .ok,#${TOOL_ID} .muted{color:#56606a}
#${TOOL_ID} .kept,#${TOOL_ID} .skip{color:#8a5300}
#${TOOL_ID} .warn,#${TOOL_ID} .fail{color:#b3261e;font-weight:bold}
#${TOOL_ID} .result{margin-top:4px;padding-top:4px;border-top:1px dashed #c7cdd1}
#${TOOL_ID} .datefix{margin-top:4px}
#${TOOL_ID} .datefix select,#${TOOL_ID} .bulk select{max-width:100%}
#${TOOL_ID} .bulk{background:#fdf6ec;border-left:4px solid #8a5300;padding:8px 12px;margin:8px 0}
#${TOOL_ID} button{font:inherit;padding:6px 14px;border-radius:4px;border:1px solid #0374b5;
 background:#0374b5;color:#fff;cursor:pointer}
#${TOOL_ID} button.secondary{background:#fff;color:#0374b5}
#${TOOL_ID} button:disabled{opacity:.5;cursor:not-allowed}
#${TOOL_ID} :focus-visible{outline:2px solid #0374b5;outline-offset:2px}
#${TOOL_ID} .credit{padding:8px 18px;border-top:1px solid #c7cdd1;font-size:12px;color:#56606a}
#${TOOL_ID} .credit a{color:#0374b5}
#${TOOL_ID} input[type=search]{font:inherit;padding:5px 8px;width:min(320px,100%);
 border:1px solid #c7cdd1;border-radius:4px}
`;

  const status = el('p', { role: 'status', class: 'muted' }, 'Starting…');
  const panelBody = el('div', { class: 'panel-body' },
    el('p', { class: 'notice' },
      'Choose accommodations, preview the changes, then apply. Apply only adds extra time or an ' +
      'extra attempt; it never reduces or removes an existing extension. Date adjustments apply ' +
      "to one student only and never change the quiz's dates for the class."),
    status);
  const heading = el('h2', { id: `${TOOL_ID}-title`, tabindex: '-1' }, 'Quiz Accommodations');
  const panel = el('div', { id: TOOL_ID, role: 'dialog', 'aria-labelledby': `${TOOL_ID}-title` },
    el('style', {}, CSS),
    el('header', {},
      heading,
      el('button', { type: 'button', class: 'secondary', onclick: close }, 'Close')),
    panelBody,
    // Credit line: tool, version, maker, and a way back to the install page.
    // A plain link, so nothing is fetched or run.
    el('footer', { class: 'credit' },
      `Quiz accommodations ${VERSION} \u00b7 Technology Consigliere \u00b7 `,
      el('a', { href: HOME, target: '_blank', rel: 'noopener noreferrer' }, 'Help and updates')));

  let running = false;

  function onKey(e) { if (e.key === 'Escape' && !running) close(); }

  function close() {
    if (running && !confirm('Changes are still being written. Close anyway? Quizzes not yet reached will not be changed.')) {
      return;
    }
    document.removeEventListener('keydown', onKey);
    panel.remove();
    if (previousFocus && previousFocus.focus) previousFocus.focus();
  }

  function render({ quizzes, students }) {
    if (!quizzes.length) { status.textContent = 'This course has no Classic Quizzes.'; return; }
    if (!students.length) { status.textContent = 'This course has no enrolled students.'; return; }

    const timedCount = quizzes.filter((q) => q.timeLimit > 0).length;
    const invitedCount = students.filter((s) => s.invited).length;
    status.textContent =
      `${quizzes.length} quizzes (${timedCount} timed), ${students.length} enrolled students` +
      (invitedCount ? `, ${invitedCount} of whom haven't accepted the course invitation yet.` : '.');

    let plan = null;  // set by a preview; cleared whenever selections change
    const choices = new Map();
    const noteCells = new Map();
    const controls = [];

    const previewNote = el('span', { role: 'status', class: 'muted' });

    // Apply is available only when the current preview has something to do.
    const refreshApply = () => {
      const c = planCounts(plan);
      applyBtn.disabled = running || !plan || c.ext + c.dates === 0;
      if (plan) {
        previewNote.textContent = c.ext + c.dates === 0
          ? ' Nothing to write; everything is already in place.'
          : '';
      }
    };

    const invalidate = () => {
      if (!plan) return;
      plan = null;
      refreshApply();
      previewNote.textContent = ' Selections changed. Run Preview again before applying.';
    };

    const rows = students.map((s) => {
      const found = infer(s, quizzes);
      choices.set(s.id, { time: found.time, attempt: found.attempt });

      const select = el('select', {
        'aria-label': `Extra time for ${s.name}`,
        onchange: (e) => { choices.get(s.id).time = e.target.value; invalidate(); },
      }, Object.entries(TIME_PRESETS).map(([key, preset]) =>
        el('option', { value: key, selected: key === found.time }, preset.label)));

      const box = el('input', {
        type: 'checkbox',
        'aria-label': `One extra attempt for ${s.name}`,
        checked: found.attempt,
        onchange: (e) => { choices.get(s.id).attempt = e.target.checked; invalidate(); },
      });
      controls.push(select, box);

      const noteCell = el('td', {}, currentNote(found));
      noteCells.set(s.id, noteCell);

      // Accommodations can be set before a student accepts the invitation, so
      // these rows are usable; the tag just explains an unfamiliar name.
      const nameCell = el('th', { scope: 'row' },
        s.name,
        s.invited ? [el('br'), el('span', { class: 'tag invited' }, 'Invitation not yet accepted')] : null);

      const row = el('tr', {}, nameCell, el('td', {}, select), el('td', {}, box), noteCell);
      row.dataset.name = s.name.toLowerCase();
      return row;
    });

    const filter = el('input', {
      type: 'search',
      placeholder: 'Filter students',
      'aria-label': 'Filter students by name',
      oninput: (e) => {
        const q = e.target.value.trim().toLowerCase();
        for (const row of rows) row.hidden = Boolean(q) && !row.dataset.name.includes(q);
      },
    });

    const roster = el('div', { class: 'scroll' }, el('table', {},
      el('caption', {},
        "Set each accommodated student's criteria. Students who already have matching " +
        'extensions are pre-selected. Students who have been added to the course but ' +
        'have not accepted the invitation are listed too, and accommodations can be set ' +
        'for them now.'),
      el('thead', {}, el('tr', {},
        el('th', { scope: 'col' }, 'Student'),
        el('th', { scope: 'col' }, 'Extra time'),
        el('th', { scope: 'col' }, 'One extra attempt'),
        el('th', { scope: 'col' }, 'Current extensions'))),
      el('tbody', {}, rows)));

    const preview = el('div');

    const previewBtn = el('button', {
      type: 'button',
      onclick: () => {
        plan = renderPreview(quizzes, students, choices, preview, refreshApply);
        refreshApply();
      },
    }, 'Preview changes');

    const applyBtn = el('button', { type: 'button', disabled: true, onclick: onApply }, 'Apply');

    async function onApply() {
      if (!plan || running) return;
      const c = planCounts(plan);
      const studentCount = new Set(plan.flatMap((p) => p.entries
        .filter((e) => e.hasWork()).map((e) => e.student.id))).size;
      const parts = [];
      if (c.ext) parts.push(plural(c.ext, 'extension change', 'extension changes'));
      if (c.dates) parts.push(plural(c.dates, 'date adjustment', 'date adjustments'));

      let detail = "\n\nExtension changes only add extra time or an extra attempt; they never reduce or " +
        'remove an existing extension.';
      if (c.dates) {
        detail += '\n\nDate adjustments create or update an individual date override for that student ' +
          "only. The quiz's dates for the rest of the class don't change.";
      }
      if (c.ext && !settingsOnlyConfirmed) {
        detail += "\n\nThis course hasn't yet shown an extension for a student who hasn't started a quiz. " +
          "The tool checks for that after its first write and stops if Canvas doesn't return it.";
      }
      if (!confirm(`Write ${parts.join(' and ')} for ${plural(studentCount, 'student', 'students')}?${detail}`)) {
        return;
      }

      running = true;
      refreshApply();
      previewBtn.disabled = true;
      for (const ctl of controls) ctl.disabled = true;
      for (const ctl of preview.querySelectorAll('select')) ctl.disabled = true;
      previewNote.textContent = '';

      const runPlan = plan;
      plan = null;  // a plan is used once; Canvas state has changed after it runs
      try {
        const r = await applyPlan(runPlan, (m) => { status.textContent = m; });
        status.className = r.stop || r.failed ? 'warn' : 'muted';
        status.textContent =
          `Result: ${plural(r.written, 'extension change', 'extension changes')} and ` +
          `${plural(r.dates, 'date adjustment', 'date adjustments')} written and verified, ` +
          `${r.skipped} skipped, ${r.failed} failed.` + (r.stop ? ` ${r.stop}` : '');
      } catch (err) {
        // An error mid-run (a dropped connection, say) can land between a write
        // and its verification, so unmarked cells are "unknown", not "unchanged".
        for (const { entries } of runPlan) {
          for (const e of entries) {
            if (e.hasWork() && !e.marked) {
              e.mark('fail', 'Not confirmed: the run stopped with an error. Check this quiz in Canvas.');
            }
          }
        }
        status.className = 'warn';
        status.textContent = `Stopped: ${err.message}. Cells marked "Not confirmed" need checking.`;
      } finally {
        running = false;
        refreshApply();
        previewBtn.disabled = false;
        for (const ctl of controls) ctl.disabled = false;
        // Refresh the "Current extensions" column from the re-read data.
        for (const s of students) {
          noteCells.get(s.id).replaceChildren(...[currentNote(infer(s, quizzes))].flat().filter(Boolean));
        }
      }
    }

    panelBody.append(
      el('h3', {}, 'Students'),
      filter,
      roster,
      el('p', {}, previewBtn, ' ', applyBtn, previewNote),
      preview);
  }

  // Draws the preview grid and returns the plan for Apply. Each entry is
  // { student, before, fields, writes, hadSub, dateFix, marked, mark(), hasWork() }.
  function renderPreview(quizzes, students, choices, target, onPlanChange) {
    const now = new Date();
    const selected = students.filter((s) => {
      const c = choices.get(s.id);
      return c.time !== 'none' || c.attempt;
    });

    target.replaceChildren();
    if (!selected.length) {
      target.append(el('p', { role: 'status' }, 'No students have an accommodation selected.'));
      return null;
    }

    const tally = { write: 0, ok: 0, kept: 0, warnings: 0, dateFixable: 0 };
    const plan = [];
    const dateSelects = [];
    const headRow = el('tr', {},
      el('th', { scope: 'col' }, 'Quiz'),
      selected.map((s) => el('th', { scope: 'col' },
        s.name, el('br'), el('span', { class: 'muted' }, describeChoice(choices.get(s.id))))));

    // Rows are built before the summary below, so the tally is complete when it's read.
    const bodyRows = quizzes.map((q) => {
      const entries = [];
      const cells = selected.map((s) => {
        const cell = planCell(q, s, choices.get(s.id), now);
        const { td, dateSelect } = renderCell(cell, tally, s.name, q.title);
        if (cell.writes || dateSelect) {
          const entry = {
            student: s, before: cell.before, fields: cell.fields, writes: cell.writes,
            hadSub: cell.hadSub, marked: false,
            dateFix: dateSelect
              ? { mode: 'none', ctx: cell.ctx, shortfall: cell.dateIssue.shortfall }
              : null,
            hasWork() { return entry.writes || Boolean(entry.dateFix && entry.dateFix.mode !== 'none'); },
            mark(kind, text) {
              entry.marked = true;
              td.append(el('div', { class: `result ${kind}` }, text));
            },
          };
          if (dateSelect) {
            dateSelect.addEventListener('change', () => {
              entry.dateFix.mode = dateSelect.value;
              onPlanChange();
            });
            dateSelects.push(dateSelect);
          }
          entries.push(entry);
        }
        return td;
      });
      if (entries.length) plan.push({ quiz: q, entries });
      return el('tr', {},
        el('th', { scope: 'row' },
          el('a', { href: q.url, target: '_blank', rel: 'noopener' }, q.title),
          el('br'),
          quizTags(q)),
        cells);
    });

    const extCount = planCounts(plan).ext;
    const previewHeading = el('h3', { tabindex: '-1' }, 'Preview');
    target.append(
      previewHeading,
      el('p', { role: 'status' },
        `${plural(extCount, 'extension change', 'extension changes')} would be written ` +
        `(one per student per quiz, ${tally.write} settings in all), ${tally.ok} already in place, ` +
        `${tally.kept} larger existing grants kept, ${tally.warnings} warnings. ` +
        'Nothing has been written yet.'));

    // One control to set every offered date adjustment at once; each cell's
    // own menu can still override it afterward.
    if (dateSelects.length) {
      const bulk = el('select', {
        'aria-label': 'Date adjustment for every quiz whose window is too short',
        onchange: (e) => {
          for (const sel of dateSelects) {
            sel.value = e.target.value;
            sel.dispatchEvent(new Event('change'));
          }
        },
      }, Object.entries(DATE_FIX_LABELS).map(([mode, label]) => el('option', { value: mode }, label)));
      target.append(el('div', { class: 'bulk' },
        el('p', { style: 'margin:0 0 6px' },
          `${plural(dateSelects.length, 'quiz window is', 'quiz windows are')} too short for a ` +
          "student's accommodated time. Choose an adjustment here for all of them, or per quiz in the grid. " +
          "Opening earlier lets the student see the quiz before classmates; extending lets classmates " +
          'finish first. Either applies to that student only.'),
        bulk));
    }

    target.append(el('div', { class: 'scroll' }, el('table', {},
      el('thead', {}, headRow),
      el('tbody', {}, bodyRows))));
    previewHeading.focus();
    return plan;
  }

  /* ---------------- Start ---------------- */

  document.body.append(panel);
  document.addEventListener('keydown', onKey);
  heading.focus();

  loadCourse((message) => { status.textContent = message; })
    .then(render)
    .catch((err) => {
      status.className = 'warn';
      if (err.rateLimited) {
        status.textContent = RATE_MESSAGE;
      } else if (err.status === 401 || err.status === 403) {
        status.textContent = 'Canvas denied access. You need permission to moderate quizzes in this course.';
      } else {
        status.textContent = `Could not load course data: ${err.message}`;
      }
    });
})();
