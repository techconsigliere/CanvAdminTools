(function () {
  'use strict';

  /* ------------------------------------------------------------------
     Canvas cross-list helper (bookmarklet) - v2.1.0

     Moves one or more sections out of secondary courses and into a
     primary course, with a plain-language preview of what will happen
     and an undo button for the sections it just moved.

     Sections start unchecked. Every move is opt-in, and every completed
     run produces a copyable audit record naming each section's home
     course, so the move can be reversed by hand after the tab is gone.

     Runs inside an already-authenticated Canvas tab. It uses the browser
     session cookie plus the _csrf_token cookie, so there is no API token
     anywhere in this file and nothing to rotate or leak. Every request
     goes to the Canvas origin you are already signed in to.

     Everything is built with DOM calls (no eval, no injected <script>,
     no inline <style> element), so it survives Canvas's Content Security
     Policy if your account has CSP turned on.

     MIT licensed. See LICENSE in the repository.
     ------------------------------------------------------------------ */

  var PANEL_ID = 'cbm-xlist-panel';
  var VERSION = '2.1.2';
  var HOME = 'https://techconsigliere.github.io/canvas-admin-bookmarklets/';
  var already = document.getElementById(PANEL_ID);
  if (already) { already.remove(); return; }   // second click closes it

  var MAX_SECONDARY = 9;
  var HOST = location.origin;
  var accountId = null;
  var primary = null;      // course the sections move INTO
  var blocks = [];         // one entry per secondary course
  var lastMoved = [];      // [{id, name}] for the undo button

  /* ---------- design tokens ------------------------------------------ */

  var INK    = '#1C2023',
      MUTED  = '#55656F',
      LINE   = '#D8E0E6',
      HAIR   = '#EDF1F4',
      BLUE   = '#003F87',
      BLUEBG = '#E8F2FA',
      GREEN  = '#006B3F',
      AMBER  = '#a86200',
      DANGER = '#CC2D30',
      SHELL  = '#F4F9FD';

  var FONT = '14px/1.5 "Fira Sans", "Helvetica Neue", "Segoe UI", Arial, sans-serif';
  // Fira Sans via the FontFace API: governed by font-src only, no <style>
  // element, so it stays CSP-safe. Falls back to the system font if blocked.
  try {
    if (window.FontFace && document.fonts && !window.__tcFira) {
      window.__tcFira = true;
      var FB = 'https://techconsigliere.github.io/canvas-admin-bookmarklets/fonts/';
      [['400', 'Regular'], ['500', 'Medium'], ['600', 'SemiBold'], ['700', 'Bold']].forEach(function (w) {
        new FontFace('Fira Sans', 'url(' + FB + 'FiraSans-' + w[1] + '.woff) format("woff")', { weight: w[0] })
          .load().then(function (f) { document.fonts.add(f); }).catch(function () {});
      });
    }
  } catch (e) {}


  /* ---------- Canvas plumbing --------------------------------------- */

  function csrf() {
    var m = document.cookie.match(/(?:^|;\s*)_csrf_token=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  }

  function api(path, method) {
    return fetch(HOST + path, {
      method: method || 'GET',
      credentials: 'same-origin',
      headers: { 'Accept': 'application/json', 'X-CSRF-Token': csrf() }
    }).then(function (res) {
      return res.text().then(function (body) {
        var data = null;
        // Canvas prefixes some JSON responses with while(1); as an anti-
        // hijacking measure. /api/v1 normally does not, but stripping it
        // costs nothing and avoids a confusing parse failure.
        try { data = JSON.parse(body.replace(/^while\(1\);/, '')); } catch (e) {}
        if (!res.ok) {
          var msg = (data && (data.message ||
                     (data.errors && JSON.stringify(data.errors)))) ||
                    (res.status + ' ' + res.statusText);
          throw new Error(msg);
        }
        return data;
      });
    });
  }

  function resolveAccount() {
    var m = location.pathname.match(/\/accounts\/(\d+)/);
    if (m) { accountId = m[1]; return Promise.resolve(accountId); }
    return api('/api/v1/accounts?per_page=100').then(function (list) {
      list = list || [];
      var root = list.filter(function (a) { return !a.parent_account_id; })[0] || list[0];
      if (!root) { throw new Error('No account available to search from this page.'); }
      accountId = root.id;
      return accountId;
    });
  }

  function searchCourses(term) {
    var path = '/api/v1/accounts/' + accountId + '/courses' +
               '?per_page=25&include[]=term&search_term=' + encodeURIComponent(term);
    return api(path).then(function (list) {
      list = list || [];
      if (!list.length && /^[\w.\-]{4,}$/.test(term)) {
        // Nothing matched the fuzzy search. Try an exact SIS ID lookup,
        // which reaches courses whose SIS ID does not appear in the
        // searchable name/code columns.
        return api('/api/v1/courses/sis_course_id:' + encodeURIComponent(term) +
                   '?include[]=term')
          .then(function (c) { return c ? [c] : []; })
          .catch(function () { return []; });
      }
      return list;
    }).then(function (list) {
      // The account courses endpoint cannot sort by creation date
      // (allowed sort values are course_name, sis_course_id, teacher,
      // account_name), so newest-first is done here over the returned
      // page. Falls back to course id, which increases monotonically.
      var haveDates = list.length > 0 && list.every(function (c) { return c.created_at; });
      list.sort(function (a, b) {
        return haveDates
          ? Date.parse(b.created_at) - Date.parse(a.created_at)
          : b.id - a.id;
      });
      return list;
    });
  }

  /* ---------- tiny DOM helpers -------------------------------------- */

  function el(tag, styles, text) {
    var e = document.createElement(tag);
    if (styles) { for (var k in styles) { e.style[k] = styles[k]; } }
    if (text != null) { e.textContent = text; }
    return e;
  }

  function button(text, kind) {
    var solid = kind === 'primary';
    var quiet = kind === 'quiet';
    var b = el('button', {
      font: 'inherit',
      fontSize: quiet ? '13px' : '14px',
      fontWeight: solid ? '700' : '400',
      padding: quiet ? '3px 8px' : '9px 16px',
      borderRadius: '4px',
      cursor: 'pointer',
      border: '1px solid ' + (solid ? BLUE : LINE),
      background: solid ? BLUE : '#fff',
      color: solid ? '#fff' : (quiet ? MUTED : INK),
      lineHeight: '1.3'
    }, text);
    b.type = 'button';
    b.addEventListener('focus', function () {
      b.style.outline = '2px solid ' + BLUE;
      b.style.outlineOffset = '2px';
    });
    b.addEventListener('blur', function () { b.style.outline = 'none'; });
    return b;
  }

  function courseLine(c) {
    return (c.name || '(unnamed)') +
           '  \u00b7  ' + (c.course_code || '') +
           '  \u00b7  SIS ' + (c.sis_course_id || 'none') +
           '  \u00b7  ' + ((c.term && c.term.name) || 'no term') +
           '  \u00b7  id ' + c.id +
           (c.workflow_state === 'unpublished' ? '  \u00b7  unpublished' : '');
  }

  /* ---------- the type-ahead box ------------------------------------ */

  function combo(labelText, onPick) {
    var wrap = el('div', { position: 'relative' });
    var lab = el('label', {
      display: 'block', fontWeight: '700', marginBottom: '5px', fontSize: '14px'
    }, labelText);
    var input = el('input', {
      width: '100%', boxSizing: 'border-box', padding: '9px 10px',
      border: '1px solid ' + LINE, borderRadius: '4px',
      font: 'inherit', fontSize: '14px', color: INK, background: '#fff'
    });
    input.type = 'text';
    input.autocomplete = 'off';
    input.placeholder = 'Type 3 or more characters of the SIS ID, course code, or name';
    input.addEventListener('focus', function () {
      input.style.borderColor = BLUE;
      input.style.boxShadow = 'inset 0 0 0 1px ' + BLUE;
    });
    input.addEventListener('blur', function () {
      input.style.borderColor = LINE;
      input.style.boxShadow = 'none';
    });

    var menu = el('div', {
      position: 'absolute', left: '0', right: '0', top: '100%', marginTop: '2px',
      background: '#fff', border: '1px solid ' + LINE, borderRadius: '4px',
      boxShadow: '0 4px 14px rgba(0,0,0,.16)', maxHeight: '260px',
      overflowY: 'auto', display: 'none', zIndex: '10'
    });
    var picked = el('div', {
      marginTop: '7px', fontSize: '13px', color: BLUE, lineHeight: '1.4'
    });

    var timer = null, rows = [], cursor = -1;

    function closeMenu() { menu.style.display = 'none'; rows = []; cursor = -1; }

    function highlight(i) {
      var kids = menu.children;
      for (var n = 0; n < kids.length; n++) {
        kids[n].style.background = (n === i) ? BLUEBG : '#fff';
      }
      cursor = i;
      if (kids[i]) { kids[i].scrollIntoView({ block: 'nearest' }); }
    }

    function choose(c) {
      closeMenu();
      input.value = (c.course_code || c.name || '') + ' (id ' + c.id + ')';
      picked.textContent = courseLine(c);
      onPick(c);
    }

    function render(list) {
      menu.textContent = '';
      rows = list;
      if (!list.length) {
        menu.appendChild(el('div', { padding: '10px', color: MUTED, fontSize: '13px' },
          'No courses matched. Try the SIS ID or the course code.'));
        menu.style.display = 'block';
        return;
      }
      list.forEach(function (c, i) {
        var row = el('div', {
          padding: '8px 10px', cursor: 'pointer', borderBottom: '1px solid ' + HAIR,
          fontSize: '13px', lineHeight: '1.4'
        }, courseLine(c));
        row.addEventListener('mouseenter', function () { highlight(i); });
        row.addEventListener('mousedown', function (ev) { ev.preventDefault(); choose(c); });
        menu.appendChild(row);
      });
      menu.style.display = 'block';
      highlight(0);
    }

    input.addEventListener('input', function () {
      picked.textContent = '';
      onPick(null);
      clearTimeout(timer);
      var term = input.value.trim();
      if (term.length < 3) { closeMenu(); return; }   // Canvas rejects shorter terms
      timer = setTimeout(function () {
        searchCourses(term).then(render).catch(function (err) {
          menu.textContent = '';
          menu.appendChild(el('div', { padding: '10px', color: DANGER, fontSize: '13px' },
            'Search failed: ' + err.message));
          menu.style.display = 'block';
        });
      }, 300);
    });

    input.addEventListener('keydown', function (ev) {
      if (menu.style.display === 'none') { return; }
      if (ev.key === 'ArrowDown') { ev.preventDefault(); highlight(Math.min(cursor + 1, rows.length - 1)); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); highlight(Math.max(cursor - 1, 0)); }
      else if (ev.key === 'Enter') { ev.preventDefault(); if (rows[cursor]) { choose(rows[cursor]); } }
      else if (ev.key === 'Escape') { closeMenu(); }
    });

    input.addEventListener('blur', function () { setTimeout(closeMenu, 150); });

    wrap.appendChild(lab);
    wrap.appendChild(input);
    wrap.appendChild(menu);
    wrap.appendChild(picked);
    return { wrap: wrap, focus: function () { input.focus(); } };
  }

  /* ---------- panel shell -------------------------------------------- */

  var panel = el('div', {
    position: 'fixed', top: '16px', right: '16px', width: '540px', maxHeight: '90vh',
    zIndex: '99999', background: '#fff', color: INK,
    border: '1px solid ' + LINE, borderRadius: '8px',
    boxShadow: '0 10px 40px rgba(0,0,0,.22)',
    font: FONT, display: 'flex', flexDirection: 'column'
  });
  panel.id = PANEL_ID;

  var head = el('div', {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '13px 18px', borderBottom: '1px solid ' + LINE,
    background: SHELL, borderRadius: '8px 8px 0 0', cursor: 'move',
    flex: '0 0 auto'
  });
  var headText = el('div');
  headText.appendChild(el('div', { fontWeight: '700', fontSize: '16px' }, 'Cross-list sections'));
  var headSub = el('div', { fontSize: '13px', color: MUTED, marginTop: '2px' }, '');
  headText.appendChild(headSub);
  head.appendChild(headText);
  var closeBtn = button('Close');
  closeBtn.addEventListener('click', function () { panel.remove(); });
  head.appendChild(closeBtn);
  panel.appendChild(head);

  // Drag the panel by its header so it never sits on top of something
  // you need to read underneath.
  (function makeDraggable() {
    var dragging = false, offX = 0, offY = 0;
    head.addEventListener('mousedown', function (ev) {
      if (ev.target.tagName === 'BUTTON') { return; }
      var box = panel.getBoundingClientRect();
      dragging = true;
      offX = ev.clientX - box.left;
      offY = ev.clientY - box.top;
      panel.style.right = 'auto';
      panel.style.left = box.left + 'px';
      panel.style.top = box.top + 'px';
      ev.preventDefault();
    });
    document.addEventListener('mousemove', function (ev) {
      if (!dragging) { return; }
      panel.style.left = Math.max(0, ev.clientX - offX) + 'px';
      panel.style.top = Math.max(0, ev.clientY - offY) + 'px';
    });
    document.addEventListener('mouseup', function () { dragging = false; });
  })();

  var body = el('div', { padding: '18px', overflowY: 'auto', flex: '1 1 auto' });
  panel.appendChild(body);

  var foot = el('div', {
    padding: '14px 18px', borderTop: '1px solid ' + LINE, background: SHELL,
    borderRadius: '0 0 8px 8px', flex: '0 0 auto'
  });
  panel.appendChild(foot);

  var planText = el('div', { fontSize: '13px', lineHeight: '1.5', marginBottom: '10px' });
  var actions = el('div', { display: 'flex', gap: '8px', flexWrap: 'wrap' });
  foot.appendChild(planText);
  foot.appendChild(actions);

  function say(text, color) {
    planText.textContent = text;
    planText.style.color = color || INK;
  }

  /* ---------- primary course ----------------------------------------- */

  var primaryCard = el('div', {
    padding: '14px 16px', border: '1px solid ' + LINE, borderRadius: '6px',
    borderLeft: '4px solid ' + BLUE, marginBottom: '18px', background: '#fff'
  });
  var primaryCombo = combo('Primary course \u2014 every selected section moves into this course',
    function (c) { primary = c; refreshPlan(); });
  primaryCard.appendChild(primaryCombo.wrap);
  body.appendChild(primaryCard);

  var secondaryWrap = el('div');
  body.appendChild(secondaryWrap);

  var addRow = el('div', { marginTop: '4px' });
  var addBtn = button('Add another secondary course');
  addBtn.addEventListener('click', function () { addSecondary(); });
  addRow.appendChild(addBtn);
  var addNote = el('span', { marginLeft: '10px', fontSize: '13px', color: MUTED }, '');
  addRow.appendChild(addNote);
  body.appendChild(addRow);

  var log = el('div', { marginTop: '16px', fontSize: '13px' });
  body.appendChild(log);

  /* ---------- secondary blocks --------------------------------------- */

  function addSecondary() {
    if (blocks.length >= MAX_SECONDARY) { return; }

    var block = { course: null, sections: [] };

    var card = el('div', {
      padding: '14px 16px', border: '1px solid ' + LINE, borderRadius: '6px',
      borderLeft: '4px solid ' + HAIR, marginBottom: '14px', background: SHELL
    });
    block.card = card;

    var cardHead = el('div', {
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      marginBottom: '10px'
    });
    block.titleEl = el('div', { fontWeight: '700', fontSize: '13px', color: MUTED }, '');
    cardHead.appendChild(block.titleEl);
    var rm = button('Remove', 'quiet');
    rm.addEventListener('click', function () {
      blocks.splice(blocks.indexOf(block), 1);
      card.remove();
      renumber();
      refreshPlan();
    });
    cardHead.appendChild(rm);
    card.appendChild(cardHead);

    var cb = combo('Sections move out of this course', function (c) {
      block.course = c;
      card.style.borderLeftColor = c ? BLUE : HAIR;
      loadSections(block);
    });
    card.appendChild(cb.wrap);

    block.sectionBox = el('div', { marginTop: '12px' });
    card.appendChild(block.sectionBox);

    blocks.push(block);
    secondaryWrap.appendChild(card);
    renumber();
    cb.focus();
    refreshPlan();
  }

  function renumber() {
    blocks.forEach(function (b, i) {
      b.titleEl.textContent = 'Secondary course ' + (i + 1) + ' of ' + blocks.length;
    });
    addBtn.disabled = blocks.length >= MAX_SECONDARY;
    addBtn.style.opacity = addBtn.disabled ? '.5' : '1';
    addBtn.style.cursor = addBtn.disabled ? 'default' : 'pointer';
    addNote.textContent = addBtn.disabled
      ? 'Nine secondary courses is the limit.'
      : blocks.length + ' of ' + MAX_SECONDARY + ' in use';
  }

  function loadSections(block) {
    block.sectionBox.textContent = '';
    block.sections = [];
    refreshPlan();
    if (!block.course) { return; }
    block.sectionBox.appendChild(el('div', { color: MUTED, fontSize: '13px' }, 'Loading sections\u2026'));
    api('/api/v1/courses/' + block.course.id +
        '/sections?per_page=100&include[]=total_students')
      .then(function (list) {
        block.sections = list || [];
        renderSections(block);
        refreshPlan();
      })
      .catch(function (err) {
        block.sectionBox.textContent = '';
        block.sectionBox.appendChild(el('div', { color: DANGER, fontSize: '13px' },
          'Could not load sections: ' + err.message));
      });
  }

  function renderSections(block) {
    var boxEl = block.sectionBox;
    boxEl.textContent = '';
    if (!block.sections.length) {
      boxEl.appendChild(el('div', { color: DANGER, fontSize: '13px' },
        'This course has no sections to move.'));
      return;
    }
    var listHead = el('div', {
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      margin: '0 0 6px'
    });
    listHead.appendChild(el('div', {
      fontWeight: '700', fontSize: '13px', color: INK
    }, 'Sections to move (' + block.sections.length + ')'));

    var toggle = button('Select all', 'quiet');
    toggle.addEventListener('click', function () {
      var boxes = boxEl.querySelectorAll('input[type=checkbox]');
      var turnOn = toggle.textContent === 'Select all';
      for (var i = 0; i < boxes.length; i++) { boxes[i].checked = turnOn; }
      toggle.textContent = turnOn ? 'Select none' : 'Select all';
      refreshPlan();
    });
    listHead.appendChild(toggle);
    boxEl.appendChild(listHead);

    block.sections.forEach(function (s) {
      var row = el('label', {
        display: 'flex', gap: '8px', alignItems: 'flex-start',
        padding: '6px 0', fontSize: '13px', lineHeight: '1.45', cursor: 'pointer',
        borderTop: '1px solid ' + HAIR
      });
      var box = el('input', { marginTop: '3px', flex: '0 0 auto' });
      box.type = 'checkbox';
      box.checked = false;   // opt in per section; bulk moves are deliberate
      box.dataset.sectionId = s.id;
      box.addEventListener('change', refreshPlan);
      row.appendChild(box);

      var text = el('span');
      text.appendChild(el('span', { fontWeight: '700' }, s.name || '(unnamed section)'));
      text.appendChild(el('span', { color: MUTED },
        '  \u00b7  id ' + s.id +
        '  \u00b7  SIS ' + (s.sis_section_id || 'none') +
        '  \u00b7  ' + (s.total_students != null ? s.total_students + ' students' : 'student count unknown')));
      if (s.nonxlist_course_id) {
        text.appendChild(el('div', { color: DANGER },
          'Already cross-listed. Its home course is id ' + s.nonxlist_course_id + '.'));
      }
      row.appendChild(text);
      boxEl.appendChild(row);
    });
  }

  function checkedIn(block) {
    var out = [];
    var boxes = block.sectionBox.querySelectorAll('input[type=checkbox]');
    for (var i = 0; i < boxes.length; i++) {
      if (!boxes[i].checked) { continue; }
      var id = boxes[i].dataset.sectionId;
      var match = block.sections.filter(function (s) { return String(s.id) === String(id); })[0];
      if (match) { out.push({ section: match, from: block.course }); }
    }
    return out;
  }

  /* ---------- plan + execute ----------------------------------------- */

  function refreshPlan() {
    actions.textContent = '';

    if (!primary) { say('Choose the primary course first.', MUTED); return; }

    var chosen = blocks.filter(function (b) { return b.course; });
    if (!chosen.length) { say('Choose at least one secondary course.', MUTED); return; }

    var collide = chosen.filter(function (b) { return String(b.course.id) === String(primary.id); });
    if (collide.length) {
      say('One of the secondary courses is the same as the primary course (id ' +
          primary.id + '). Change it before continuing.', DANGER);
      return;
    }

    var seen = {}, dupes = [];
    chosen.forEach(function (b) {
      if (seen[b.course.id]) { dupes.push(b.course.id); }
      seen[b.course.id] = true;
    });
    if (dupes.length) {
      say('Course id ' + dupes[0] + ' is listed twice as a secondary course. ' +
          'Remove the duplicate before continuing.', DANGER);
      return;
    }

    var moves = [];
    chosen.forEach(function (b) { moves = moves.concat(checkedIn(b)); });
    if (!moves.length) { say('Check the sections you want to move.', MUTED); return; }

    var students = moves.reduce(function (n, m) {
      return n + (m.section.total_students || 0);
    }, 0);
    var sourceIds = Object.keys(seen).join(', ');

    say('This will move ' + moves.length + ' section' + (moves.length === 1 ? '' : 's') +
        ' carrying ' + students + ' student enrollment' + (students === 1 ? '' : 's') +
        ' out of course' + (chosen.length === 1 ? ' ' : 's ') + sourceIds +
        ' and into course ' + primary.id + ' "' + (primary.course_code || primary.name) + '". ' +
        'Those students do their coursework in ' + primary.id + ' from that point on. ' +
        'The source courses keep their own content, settings, and any sections you left unchecked. ' +
        'Nothing is deleted, and Canvas records each section\u2019s home course so the move can be reversed.');

    if (students > 0) {
      planText.appendChild(el('div', {
        color: AMBER, marginTop: '8px', fontWeight: '700'
      }, 'Check for submitted work before moving a section in a course that has already started. ' +
         'Submissions and grades stay behind in the source course, and the students lose access to them. ' +
         'Cross-listing is safest before the term opens.'));
    }

    var go = button('Move ' + moves.length + ' section' + (moves.length === 1 ? '' : 's') +
                    ' into course ' + primary.id, 'primary');
    go.addEventListener('click', function () { execute(moves); });
    actions.appendChild(go);
  }

  function auditRecord(startedAt, moved) {
    var head = startedAt.toISOString() + ' | crosslist | into course ' + primary.id +
               ' ' + (primary.sis_course_id || '') + ' "' + (primary.course_code || primary.name) + '"';
    var rows = moved.map(function (m) {
      return '  section ' + m.id + ' ' + (m.sis || 'no-sis') +
             ' "' + (m.name || '') + '"' +
             ' <- home course ' + m.from + ' ' + (m.fromSis || '');
    });
    return [head].concat(rows).join('\n');
  }

  function execute(moves) {
    actions.textContent = '';
    log.textContent = '';
    lastMoved = [];
    var startedAt = new Date();
    say('Working\u2026', MUTED);

    var chain = Promise.resolve();
    moves.forEach(function (m) {
      chain = chain.then(function () {
        return api('/api/v1/sections/' + m.section.id + '/crosslist/' + primary.id, 'POST')
          .then(function () {
            lastMoved.push({
              id: m.section.id,
              name: m.section.name,
              sis: m.section.sis_section_id,
              from: m.from.id,
              fromSis: m.from.sis_course_id
            });
            log.appendChild(el('div', { color: GREEN, padding: '2px 0' },
              'Moved section ' + m.section.id + ' "' + (m.section.name || '') +
              '" from course ' + m.from.id + ' into course ' + primary.id + '.'));
          })
          .catch(function (err) {
            log.appendChild(el('div', { color: DANGER, padding: '2px 0' },
              'Section ' + m.section.id + ' "' + (m.section.name || '') +
              '" was not moved: ' + err.message));
          });
      });
    });

    chain.then(function () {
      say(lastMoved.length + ' of ' + moves.length + ' sections moved. Details are in the panel above.',
          lastMoved.length === moves.length ? GREEN : DANGER);

      var openLink = button('Open course ' + primary.id);
      openLink.addEventListener('click', function () {
        window.open(HOST + '/courses/' + primary.id + '/settings#tab-sections', '_blank');
      });
      actions.appendChild(openLink);

      if (lastMoved.length) {
        var record = auditRecord(startedAt, lastMoved);

        log.appendChild(el('div', {
          marginTop: '10px', paddingTop: '8px', borderTop: '1px solid ' + HAIR,
          color: MUTED, whiteSpace: 'pre-wrap', lineHeight: '1.5'
        }, record));

        var copy = button('Copy the audit record');
        copy.addEventListener('click', function () {
          if (!navigator.clipboard) { return; }
          navigator.clipboard.writeText(record).then(function () {
            copy.textContent = 'Copied';
          });
        });
        actions.appendChild(copy);

        log.appendChild(el('div', { color: AMBER, marginTop: '8px', lineHeight: '1.5' },
          'The undo button below only exists in this browser tab. Close or reload the tab and it ' +
          'is gone. The audit record above lists each section\u2019s home course, which is what you ' +
          'need to return them by hand from Settings > Sections in the primary course.'));

        var undo = button('Undo \u2014 return these ' + lastMoved.length +
                          ' sections to their home courses');
        undo.addEventListener('click', function () {
          undo.disabled = true;
          undo.style.opacity = '.5';
          var back = Promise.resolve();
          lastMoved.forEach(function (m) {
            back = back.then(function () {
              return api('/api/v1/sections/' + m.id + '/crosslist', 'DELETE')
                .then(function () {
                  log.appendChild(el('div', { color: BLUE, padding: '2px 0' },
                    'Section ' + m.id + ' returned to its home course.'));
                })
                .catch(function (err) {
                  log.appendChild(el('div', { color: DANGER, padding: '2px 0' },
                    'Section ' + m.id + ' could not be returned: ' + err.message));
                });
            });
          });
          back.then(function () { say('Undo finished. Reload the courses to confirm.', INK); });
        });
        actions.appendChild(undo);
      }
    });
  }

  /* ---------- start -------------------------------------------------- */

  // Credit line: tool, version, maker, and a way back to the install page.
  // A plain link, so nothing is fetched or run. The version lets someone
  // compare their installed bookmark against the page.
  var credit = el('div', { fontSize: '12px', color: '#55656F', marginTop: '12px' },
    'Cross-list sections ' + VERSION + ' \u00b7 Technology Consigliere \u00b7 ');
  var creditLink = el('a', { color: BLUE }, 'Help and updates');
  creditLink.href = HOME;
  creditLink.target = '_blank';
  creditLink.rel = 'noopener noreferrer';
  credit.appendChild(creditLink);
  foot.appendChild(credit);

  document.body.appendChild(panel);
  addSecondary();
  say('Finding an account to search\u2026', MUTED);
  resolveAccount()
    .then(function (id) {
      headSub.textContent = 'Searching courses in account ' + id;
      refreshPlan();
    })
    .catch(function (err) { say(err.message, DANGER); });
})();
