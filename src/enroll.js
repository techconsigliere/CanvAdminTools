(function () {
  'use strict';

  /* ------------------------------------------------------------------
     Canvas enrollment helper (bookmarklet) - v1.1.0

     Adds or removes one user on one section using a two-line SIS import
     rather than the enrollments API. The SIS importer does not enforce
     the "Can't add an enrollment to a concluded course" guard that lives
     in EnrollmentsApiController#create, so this reaches concluded and
     past-term courses without unconcluding anything.

     Read the README before you use this. It needs the Import SIS Data
     permission, it makes the enrollment SIS-managed, and it is the
     sharpest tool in this repository.

     It never sends batch_mode and never sends
     diffing_data_set_identifier. Both are deliberate omissions, and
     both are the reason this cannot sweep a term.

     Runs inside an already-authenticated Canvas tab. It uses the
     browser session cookie plus the _csrf_token cookie, so there is no
     API token in this file and nothing to rotate or leak.

     Everything is built with DOM calls (no eval, no injected script
     tag, no inline style element), so it survives Canvas's Content
     Security Policy.

     MIT licensed. See LICENSE in the repository.
     ------------------------------------------------------------------ */

  var PANEL_ID = 'cbm-enroll-panel';
  var VERSION = '1.1.5';
  var HOME = 'https://techconsigliere.github.io/canvas-admin-bookmarklets/';
  var already = document.getElementById(PANEL_ID);
  if (already) {
    if (typeof already.__tcClose === 'function') { already.__tcClose(); } else { already.remove(); }
    return;
  }

  var HOST = location.origin;
  var accountId = null;       // where searches run (may be a subaccount)
  var rootAccountId = null;   // where SIS imports must go (always the root)
  var planToken = 0;          // discards pre-flight checks for a plan that changed
  var pickedUser = null;
  var pickedCourse = null;
  var sections = [];
  var pickedSection = null;
  var pollTimer = null;
  var running = false;     // an import is being sent or watched
  var cancelled = false;   // panel closed; stop watching

  /* ---------- design tokens ------------------------------------------ */

  var INK    = '#1C2023',
      MUTED  = '#55656F',
      LINE   = '#D8E0E6',
      HAIR   = '#EDF1F4',
      BLUE   = '#003F87',
      BLUEBG = '#E8F2FA',
      GREEN  = '#006B3F',
      AMBER  = '#9A5800',
      DANGER = '#CC2D30',
      SHELL  = '#F4F9FD',
      FIELD  = '#7A8791';   // input/select borders: 3:1 against white

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

  var MONO = '12px/1.6 "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace';

  /* ---------- Canvas plumbing ---------------------------------------- */

  function csrf() {
    var m = document.cookie.match(/(?:^|;\s*)_csrf_token=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  }

  function api(path, method) {
    return fetch(HOST + path, {
      method: method || 'GET',
      credentials: 'same-origin',
      headers: { 'Accept': 'application/json', 'X-CSRF-Token': csrf() }
    }).then(readJson);
  }

  function postCsv(path, csvText) {
    return fetch(HOST + path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'text/csv',
        'X-CSRF-Token': csrf()
      },
      body: csvText
    }).then(readJson);
  }

  function apiAll(path, cap) {
    var out = [];
    cap = cap || 2000;
    function step(url) {
      return fetch(url, {
        credentials: 'same-origin',
        headers: { 'Accept': 'application/json', 'X-CSRF-Token': csrf() }
      }).then(function (res) {
        var link = res.headers.get('Link') || '';
        return readJson(res).then(function (data) {
          out = out.concat(data || []);
          var m = link.match(/<([^>]+)>;\s*rel="next"/);
          if (m && out.length < cap && m[1].indexOf(HOST + '/') === 0) { return step(m[1]); }
          return out;
        });
      });
    }
    return step(HOST + path);
  }

  function readJson(res) {
    return res.text().then(function (body) {
      var data = null;
      try { data = JSON.parse(body.replace(/^while\(1\);/, '')); } catch (e) {}
      if (!res.ok) {
        var msg = (data && (data.message ||
                   (data.errors && JSON.stringify(data.errors)))) ||
                  (res.status + ' ' + res.statusText);
        if (res.status === 401 || res.status === 403) {
          msg = 'Canvas refused the request (' + res.status + '). ' +
                'Importing SIS data needs the Import SIS Data permission on ' +
                'your admin role. ' + msg;
        }
        throw new Error(msg);
      }
      return data;
    });
  }

  var accountGuessed = false;

  function resolveAccount() {
    var m = location.pathname.match(/\/accounts\/(\d+)/);
    if (m) { accountId = m[1]; return Promise.resolve(accountId); }
    return api('/api/v1/accounts?per_page=100').then(function (list) {
      list = list || [];
      var root = list.filter(function (a) { return !a.parent_account_id; })[0] || list[0];
      if (!root) { throw new Error('No account available to search from this page.'); }
      accountId = root.id;
      accountGuessed = list.length > 1;
      return accountId;
    });
  }

  /* ---------- searches ------------------------------------------------ */

  function searchUsers(term) {
    return api('/api/v1/accounts/' + accountId + '/users' +
               '?per_page=25&include[]=email&search_term=' + encodeURIComponent(term))
      .then(function (list) { list = list || []; list.truncated = list.length >= 25; return list; });
  }

  function tokensOf(term) {
    return term.split(/\s+/).filter(function (t) { return t.length > 0; });
  }

  function matchesAllTokens(c, toks) {
    var hay = ((c.name || '') + ' ' + (c.course_code || '') + ' ' +
               (c.sis_course_id || '')).toLowerCase();
    return toks.every(function (t) { return hay.indexOf(t.toLowerCase()) !== -1; });
  }

  function courseQuery(term) {
    return api('/api/v1/accounts/' + accountId + '/courses' +
               '?per_page=50&include[]=term&include[]=teachers&search_term=' +
               encodeURIComponent(term))
      .then(function (list) { list = list || []; list.truncated = list.length >= 50; return list; });
  }

  function searchCourses(term) {
    /* Canvas matches search_term as one wildcard string, not as tokens.
       Try the phrase as typed first, since course names often carry it in
       that order. If nothing comes back, send the longest token instead
       and narrow the result set here so word order stops mattering. */
    return courseQuery(term).then(function (list) {
      if (list.length) { return list; }
      var toks = tokensOf(term);
      if (toks.length < 2) { return []; }
      var longest = toks.slice().sort(function (a, b) { return b.length - a.length; })[0];
      if (longest.length < 3) { return []; }
      return courseQuery(longest).then(function (wide) {
        return wide.filter(function (c) { return matchesAllTokens(c, toks); });
      });
    }).then(function (list) {
      return list.sort(function (a, b) { return termKey(b) - termKey(a); });
    });
  }

  function termKey(c) {
    /* Canvas already knows when each term starts, and every institution
       names its own terms. Sorting on term.start_at works on quarters,
       semesters, trimesters and anything else. Courses parked in the
       Default Term have no start date, so fall back to creation date. */
    if (c.term && c.term.start_at) { return Date.parse(c.term.start_at); }
    if (c.created_at) { return Date.parse(c.created_at); }
    return 0;
  }

  function termLabel(c) {
    return (c.term && c.term.name) || 'no term';
  }

  /* ---------- tiny DOM helpers ---------------------------------------- */

  function el(tag, styles, text) {
    var e = document.createElement(tag);
    if (styles) { for (var k in styles) { e.style[k] = styles[k]; } }
    if (text != null) { e.textContent = text; }
    return e;
  }

  var uid = 0;
  function nextId(p) { return PANEL_ID + '-' + p + '-' + (++uid); }
  function srOnly() {
    return { position: 'absolute', width: '1px', height: '1px', padding: '0', margin: '-1px',
             overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap', border: '0' };
  }

  function button(text, kind) {
    var solid = kind === 'primary';
    var warn = kind === 'danger';
    var b = el('button', {
      font: 'inherit',
      fontSize: '14px',
      fontWeight: (solid || warn) ? '700' : '400',
      padding: '9px 16px',
      borderRadius: '4px',
      cursor: 'pointer',
      border: '1px solid ' + (solid ? BLUE : (warn ? DANGER : LINE)),
      background: solid ? BLUE : (warn ? DANGER : '#fff'),
      color: (solid || warn) ? '#fff' : INK,
      lineHeight: '1.3'
    }, text);
    b.type = 'button';
    b.addEventListener('focus', function () {
      var kb = true;
      try { kb = b.matches(':focus-visible'); } catch (e) {}
      if (!kb) { return; }
      b.style.outline = '2px solid ' + BLUE;
      b.style.outlineOffset = '2px';
    });
    b.addEventListener('blur', function () { b.style.outline = 'none'; });
    return b;
  }

  function fieldLabel(text) {
    return el('label', {
      display: 'block', fontWeight: '700', marginBottom: '5px', fontSize: '14px'
    }, text);
  }

  function userMain(u) {
    return u.sortable_name || u.name || '(unnamed)';
  }

  function userSub(u) {
    return 'login ' + (u.login_id || 'none') +
           '  \u00b7  SIS ' + (u.sis_user_id || 'none') +
           '  \u00b7  ' + (u.email || 'no email') +
           '  \u00b7  id ' + u.id;
  }

  function courseMain(c) {
    return c.name || '(unnamed)';
  }

  function courseSub(c) {
    var teach = (c.teachers || []).map(function (t) { return t.display_name; })
                  .slice(0, 2).join(', ');
    return 'SIS ' + (c.sis_course_id || 'none') +
           '  \u00b7  ' + (c.course_code || 'no code') +
           '  \u00b7  ' + termLabel(c) +
           '  \u00b7  id ' + c.id +
           (teach ? '  \u00b7  ' + teach : '') +
           (c.workflow_state === 'completed' ? '  \u00b7  concluded' : '') +
           (c.workflow_state === 'unpublished' ? '  \u00b7  unpublished' : '');
  }

  /* ---------- the type-ahead box -------------------------------------- */

  function combo(labelText, placeholder, runSearch, mainOf, subOf, onPick) {
    var wrap = el('div', { position: 'relative' });
    var lab = fieldLabel(labelText);
    wrap.appendChild(lab);

    var input = el('input', {
      width: '100%', boxSizing: 'border-box', padding: '9px 10px',
      border: '1px solid ' + FIELD, borderRadius: '4px',
      font: 'inherit', fontSize: '14px', color: INK, background: '#fff'
    });
    input.type = 'text';
    input.autocomplete = 'off';
    var inputId = nextId('in'), menuId = nextId('menu'), hintId = nextId('hint');
    input.id = inputId;
    lab.htmlFor = inputId;
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-controls', menuId);
    input.setAttribute('aria-describedby', hintId);
    input.placeholder = placeholder;
    input.addEventListener('focus', function () {
      input.style.borderColor = BLUE;
      input.style.boxShadow = 'inset 0 0 0 1px ' + BLUE;
    });
    input.addEventListener('blur', function () {
      input.style.borderColor = FIELD;
      input.style.boxShadow = 'none';
    });

    var menu = el('div', {
      position: 'absolute', left: '0', right: '0', top: '100%', marginTop: '2px',
      background: '#fff', border: '1px solid ' + LINE, borderRadius: '4px',
      boxShadow: '0 4px 14px rgba(0,0,0,.16)', maxHeight: '300px',
      overflowY: 'auto', display: 'none', zIndex: '10'
    });
    menu.id = menuId;
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-label', labelText + ' results');
    var picked = el('div', {
      marginTop: '7px', fontSize: '13px', color: BLUE, lineHeight: '1.4'
    });

    var timer = null, rows = [], cursor = -1;

    function closeMenu() {
      menu.style.display = 'none'; rows = []; cursor = -1;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
    }

    function highlight(i) {
      var kids = menu.children;
      for (var n = 0; n < kids.length; n++) {
        var on = (n === i) && n < rows.length;
        kids[n].style.background = on ? BLUEBG : '#fff';
        kids[n].style.boxShadow = on ? 'inset 3px 0 0 ' + BLUE : 'none';   // not color alone
        if (n < rows.length) { kids[n].setAttribute('aria-selected', on ? 'true' : 'false'); }
      }
      cursor = i;
      if (kids[i] && i < rows.length) {
        input.setAttribute('aria-activedescendant', kids[i].id);
        kids[i].scrollIntoView({ block: 'nearest' });
      }
    }

    function choose(item) {
      closeMenu();
      input.value = mainOf(item);
      picked.textContent = subOf(item);
      onPick(item);
      announce('Selected ' + input.value + '.');
    }

    function render(list) {
      menu.textContent = '';
      rows = list;
      if (!list.length) {
        menu.appendChild(el('div', { padding: '10px', color: MUTED, fontSize: '13px' },
          'Nothing matched. Try fewer words, or the SIS ID.'));
        menu.style.display = 'block';
        announce(menu.textContent);
        return;
      }
      list.forEach(function (item, i) {
        var row = el('div', {
          padding: '8px 10px', cursor: 'pointer',
          borderBottom: '1px solid ' + HAIR
        });
        row.appendChild(el('div', { fontSize: '13px', lineHeight: '1.35' }, mainOf(item)));
        row.appendChild(el('div', {
          fontSize: '12px', color: MUTED, lineHeight: '1.35', marginTop: '1px'
        }, subOf(item)));
        row.id = menuId + '-o' + i;
        row.setAttribute('role', 'option');
        row.addEventListener('mouseenter', function () { highlight(i); });
        row.addEventListener('mousedown', function (ev) { ev.preventDefault(); choose(item); });
        menu.appendChild(row);
      });
      if (list.truncated) {
        menu.appendChild(el('div', { padding: '8px 10px', color: MUTED, fontSize: '12px', fontStyle: 'italic' },
          'Showing the first ' + list.length + ' matches. Type more to narrow the list.'));
      }
      menu.style.display = 'block';
      input.setAttribute('aria-expanded', 'true');
      highlight(0);
      announce(list.length + (list.length === 1 ? ' match' : ' matches') +
               (list.truncated ? ', first page only' : '') +
               '. Use the up and down arrows, then Enter to choose.');
    }

    input.addEventListener('input', function () {
      picked.textContent = '';
      onPick(null);
      clearTimeout(timer);
      var term = input.value.trim();
      if (term.length < 3) { closeMenu(); return; }
      timer = setTimeout(function () {
        runSearch(term).then(render).catch(function (err) {
          menu.textContent = '';
          menu.appendChild(el('div', { padding: '10px', color: DANGER, fontSize: '13px' },
            'Search failed: ' + err.message));
          menu.style.display = 'block';
          announce('Search failed: ' + err.message, true);
        });
      }, 300);
    });

    input.addEventListener('keydown', function (ev) {
      if (menu.style.display === 'none') { return; }
      if (ev.key === 'ArrowDown') { ev.preventDefault(); highlight(Math.min(cursor + 1, rows.length - 1)); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); highlight(Math.max(cursor - 1, 0)); }
      else if (ev.key === 'Enter') { ev.preventDefault(); if (rows[cursor]) { choose(rows[cursor]); } }
      else if (ev.key === 'Escape') { ev.stopPropagation(); closeMenu(); }
    });

    input.addEventListener('blur', function () { setTimeout(closeMenu, 150); });

    var hint = el('div', { fontSize: '12px', color: MUTED, margin: '0 0 5px' }, placeholder);
    hint.id = hintId;
    wrap.appendChild(hint);
    wrap.appendChild(input);
    wrap.appendChild(menu);
    wrap.appendChild(picked);
    return { wrap: wrap, focus: function () { input.focus(); } };
  }

  /* ---------- panel shell --------------------------------------------- */

  var panel = el('div', {
    position: 'fixed', top: '16px', right: '16px', width: 'min(580px, calc(100vw - 32px))', maxHeight: '92vh',
    zIndex: '99999', background: '#fff', color: INK,
    border: '1px solid ' + LINE, borderRadius: '8px',
    boxShadow: '0 10px 40px rgba(0,0,0,.22)',
    font: FONT, display: 'flex', flexDirection: 'column'
  });
  panel.id = PANEL_ID;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'false');
  panel.setAttribute('aria-labelledby', PANEL_ID + '-title');
  var prevFocus = document.activeElement;
  panel.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') { ev.preventDefault(); closePanel(); }
  });

  var head = el('div', {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '13px 18px', borderBottom: '1px solid ' + LINE,
    background: SHELL, borderRadius: '8px 8px 0 0', cursor: 'move', flex: '0 0 auto'
  });
  var headText = el('div');
  var titleEl = el('h2', { fontWeight: '700', fontSize: '16px', margin: '0', color: INK, lineHeight: '1.3' }, 'Add a person to a section');
  titleEl.id = PANEL_ID + '-title';
  titleEl.setAttribute('tabindex', '-1');
  headText.appendChild(titleEl);
  var headSub = el('div', { fontSize: '13px', color: MUTED, marginTop: '2px' }, '');
  headText.appendChild(headSub);
  head.appendChild(headText);
  var closeBtn = button('Close');
  function closePanel() {
    if (running && !window.confirm('The import has already been sent to Canvas and will finish on its own. ' +
                                   'Close the panel and stop watching it?')) {
      return;
    }
    cancelled = true;
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    panel.remove();
    if (prevFocus && prevFocus.focus) { try { prevFocus.focus(); } catch (e) {} }
  }
  closeBtn.addEventListener('click', closePanel);
  panel.__tcClose = closePanel;
  function lockForm(on) {
    Array.prototype.forEach.call(panel.querySelectorAll('input, select, button'), function (b) {
      if (b === closeBtn || b === dockBtn) { return; }
      if (on) {
        b.setAttribute('data-tc-lock', b.disabled ? 'was' : 'yes');
        b.disabled = true;
        b.style.opacity = '.55';
      } else if (b.hasAttribute('data-tc-lock')) {
        b.disabled = b.getAttribute('data-tc-lock') === 'was';
        b.style.opacity = b.disabled ? '.5' : '1';
        b.removeAttribute('data-tc-lock');
      }
    });
  }
  var dockBtn = button('Move to left side');
  dockBtn.addEventListener('click', function () {
    var onRight = panel.style.left === '' || panel.style.left === 'auto';
    if (onRight) { panel.style.left = '16px'; panel.style.right = 'auto'; }
    else { panel.style.left = 'auto'; panel.style.right = '16px'; }
    panel.style.top = '16px';
    dockBtn.textContent = onRight ? 'Move to right side' : 'Move to left side';
  });
  var headBtns = el('div', { display: 'flex', gap: '8px', alignItems: 'center', flex: '0 0 auto' });
  headBtns.appendChild(dockBtn);
  headBtns.appendChild(closeBtn);
  head.appendChild(headBtns);
  panel.appendChild(head);

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

  var csvBox = el('pre', {
    font: MONO, background: '#fff', border: '1px solid ' + LINE, borderRadius: '4px',
    padding: '9px 11px', margin: '0 0 10px', whiteSpace: 'pre', overflowX: 'auto',
    color: INK, display: 'none'
  });
  csvBox.setAttribute('tabindex', '0');
  csvBox.setAttribute('aria-label', 'CSV preview of the SIS import');
  var planText = el('div', { fontSize: '13px', lineHeight: '1.5', marginBottom: '10px' });
  var actions = el('div', { display: 'flex', gap: '8px', flexWrap: 'wrap' });
  foot.appendChild(csvBox);
  foot.appendChild(planText);
  foot.appendChild(actions);

  planText.setAttribute('tabindex', '-1');
  var liveStatus = el('div', srOnly());
  liveStatus.setAttribute('role', 'status');
  var liveAlert = el('div', srOnly());
  liveAlert.setAttribute('role', 'alert');
  panel.appendChild(liveStatus);
  panel.appendChild(liveAlert);
  function announce(text, urgent) {
    var r = urgent ? liveAlert : liveStatus;
    r.textContent = '';
    setTimeout(function () { r.textContent = text; }, 40);
  }

  var lastSayColor = INK;
  function say(text, color) {
    planText.textContent = text;
    planText.style.color = color || INK;
    lastSayColor = color || INK;
    if (color === DANGER) { announce(text, true); }   // the plan text itself is not live (it would chatter)
  }

  /* ---------- fields --------------------------------------------------- */

  function card(borderColor) {
    return el('div', {
      padding: '14px 16px', border: '1px solid ' + LINE, borderRadius: '6px',
      borderLeft: '4px solid ' + (borderColor || HAIR), marginBottom: '14px',
      background: '#fff'
    });
  }

  var userCard = card(BLUE);
  var userCombo = combo(
    'Person', 'Type 3 or more letters of a name, login, or SIS ID',
    searchUsers, userMain, userSub,
    function (u) { pickedUser = u; refreshPlan(); }
  );
  userCard.appendChild(userCombo.wrap);
  body.appendChild(userCard);

  var courseCard = card(BLUE);
  var courseCombo = combo(
    'Course', 'Type part of the course name, code, or SIS ID',
    searchCourses, courseMain, courseSub,
    function (c) {
      pickedCourse = c;
      pickedSection = null;
      loadSections();
    }
  );
  courseCard.appendChild(courseCombo.wrap);
  var sectionBox = el('div', { marginTop: '14px' });
  courseCard.appendChild(sectionBox);
  body.appendChild(courseCard);

  var optCard = card(HAIR);
  var optRow = el('div', { display: 'flex', gap: '18px', flexWrap: 'wrap' });

  function selectField(labelText, options, value) {
    var w = el('div', { flex: '1 1 200px' });
    var lab = fieldLabel(labelText);
    w.appendChild(lab);
    var s = el('select', {
      width: '100%', boxSizing: 'border-box', padding: '8px 9px',
      border: '1px solid ' + FIELD, borderRadius: '4px',
      font: 'inherit', fontSize: '14px', color: INK, background: '#fff'
    });
    options.forEach(function (o) {
      var opt = el('option', null, o[1]);
      opt.value = o[0];
      s.appendChild(opt);
    });
    s.value = value;
    s.addEventListener('change', refreshPlan);
    s.id = nextId('sel');
    lab.htmlFor = s.id;
    w.appendChild(s);
    return { wrap: w, select: s };
  }

  var roleField = selectField('Role', [
    ['', 'Choose a role\u2026'],
    ['teacher', 'Teacher'],
    ['ta', 'TA'],
    ['designer', 'Designer'],
    ['observer', 'Observer'],
    ['student', 'Student']
  ], '');

  var statusField = selectField('Status', [
    ['active', 'active (add the enrollment)'],
    ['deleted', 'deleted (remove the enrollment)']
  ], 'active');

  optRow.appendChild(roleField.wrap);
  optRow.appendChild(statusField.wrap);
  optCard.appendChild(optRow);
  body.appendChild(optCard);

  var log = el('div', { marginTop: '4px', fontSize: '13px' });
  body.appendChild(log);

  function note(text, color) {
    log.appendChild(el('div', { color: color || INK, padding: '3px 0', lineHeight: '1.45' }, text));
    log.scrollIntoView({ block: 'nearest' });
  }

  /* ---------- sections -------------------------------------------------- */

  function loadSections() {
    sectionBox.textContent = '';
    sections = [];
    refreshPlan();
    if (!pickedCourse) { return; }
    sectionBox.appendChild(el('div', { color: MUTED, fontSize: '13px' }, 'Loading sections\u2026'));
    var cid = pickedCourse.id;
    var current = function () { return pickedCourse && String(pickedCourse.id) === String(cid); };
    apiAll('/api/v1/courses/' + cid +
        '/sections?per_page=100&include[]=total_students')
      .then(function (list) {
        if (!current()) { return; }   // a newer course pick replaced this one; drop the late reply
        sections = list || [];
        renderSections();
        refreshPlan();
      })
      .catch(function (err) {
        if (!current()) { return; }
        sectionBox.textContent = '';
        sectionBox.appendChild(el('div', { color: DANGER, fontSize: '13px' },
          'Could not load sections: ' + err.message));
      });
  }

  function renderSections() {
    sectionBox.textContent = '';
    if (!sections.length) {
      sectionBox.appendChild(el('div', { color: DANGER, fontSize: '13px' },
        'This course has no sections, so there is nowhere to put the enrollment.'));
      return;
    }
    sectionBox.appendChild(el('div', {
      fontWeight: '700', fontSize: '13px', margin: '0 0 6px'
    }, 'Section (' + sections.length + ')'));
    sectionBox.lastChild.id = PANEL_ID + '-seccap';
    sectionBox.setAttribute('role', 'radiogroup');
    sectionBox.setAttribute('aria-labelledby', PANEL_ID + '-seccap');

    sections.forEach(function (s, i) {
      var row = el('label', {
        display: 'flex', gap: '8px', alignItems: 'flex-start',
        padding: '7px 0', fontSize: '13px', lineHeight: '1.45', cursor: 'pointer',
        borderTop: '1px solid ' + HAIR
      });
      var radio = el('input', { marginTop: '3px', flex: '0 0 auto' });
      radio.type = 'radio';
      radio.name = 'cbm-enroll-section';
      radio.checked = (sections.length === 1 && i === 0);
      if (radio.checked) { pickedSection = s; }
      radio.addEventListener('change', function () {
        pickedSection = s;
        refreshPlan();
      });
      row.appendChild(radio);

      var text = el('span');
      text.appendChild(el('span', { fontWeight: '700' }, s.name || '(unnamed section)'));
      text.appendChild(el('span', { color: MUTED },
        '  \u00b7  SIS ' + (s.sis_section_id || 'none') +
        '  \u00b7  id ' + s.id +
        '  \u00b7  ' + (s.total_students != null ? s.total_students + ' students' : 'student count unknown')));
      if (s.nonxlist_course_id) {
        text.appendChild(el('div', { color: AMBER },
          'Cross-listed in from course ' + s.nonxlist_course_id + '.'));
      }
      row.appendChild(text);
      sectionBox.appendChild(row);
    });

    if (sections.length === 1) { pickedSection = sections[0]; }
  }

  /* ---------- CSV ------------------------------------------------------- */

  function csvCell(v) {
    v = String(v);
    return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }

  function buildCsv() {
    var cols = [], vals = [];

    cols.push('section_id'); vals.push(pickedSection.sis_section_id);
    cols.push('user_id'); vals.push(pickedUser.sis_user_id);

    cols.push('role'); vals.push(roleField.select.value);
    cols.push('status'); vals.push(statusField.select.value);

    return cols.join(',') + '\n' + vals.map(csvCell).join(',') + '\n';
  }

  /* ---------- plan ------------------------------------------------------ */

  function sectionMatchesCourse() {
    return !pickedSection || !pickedCourse || pickedSection.course_id == null ||
           String(pickedSection.course_id) === String(pickedCourse.id);
  }

  function refreshPlan() {
    if (running) { return; }
    actions.textContent = '';
    csvBox.style.display = 'none';

    if (!pickedUser) { say('Choose a person.', MUTED); return; }
    if (!pickedCourse) { say('Choose a course.', MUTED); return; }
    if (!sections.length) { say('Waiting on the section list.', MUTED); return; }
    if (!pickedSection) { say('Choose which section the enrollment goes into.', MUTED); return; }
    if (!sectionMatchesCourse()) {
      say('The section list belongs to a different course than the one chosen. Pick the course again.', DANGER);
      return;
    }
    if (!roleField.select.value) { say('Choose a role.', MUTED); return; }
    if (!pickedUser.sis_user_id || !pickedSection.sis_section_id) {
      say((!pickedUser.sis_user_id
            ? (pickedUser.name || pickedUser.sortable_name) + ' has no SIS user ID'
            : 'Section "' + (pickedSection.name || pickedSection.id) + '" has no SIS section ID') +
          '. A SIS import can only refer to people and sections by SIS ID, so this panel cannot ' +
          'make this change. Use the People page in the course instead.', DANGER);
      var people = button('Open the course People page');
      people.addEventListener('click', function () {
        window.open(HOST + '/courses/' + pickedCourse.id + '/users', '_blank');
      });
      actions.appendChild(people);
      return;
    }

    var csv = buildCsv();
    csvBox.textContent = csv.replace(/\n$/, '');
    csvBox.style.display = 'block';

    var roleName = roleField.select.options[roleField.select.selectedIndex].textContent;
    var removing = statusField.select.value === 'deleted';

    if (removing) {
      say('This removes ' + (pickedUser.name || pickedUser.sortable_name) +
          ' as ' + roleName + ' from section "' + (pickedSection.name || pickedSection.id) +
          '" in course ' + pickedCourse.id + '. Canvas deletes the enrollment and any ' +
          'grades attached to it stop appearing in the gradebook. Deleted SIS enrollments ' +
          'are not restorable from this panel.', DANGER);
    } else {
      say('This adds ' + (pickedUser.name || pickedUser.sortable_name) +
          ' as ' + roleName + ' to section "' + (pickedSection.name || pickedSection.id) +
          '" in course ' + pickedCourse.id + ' "' +
          (pickedCourse.course_code || pickedCourse.name) + '", ' + termLabel(pickedCourse) + '. ' +
          'It goes in as a SIS import, so it works on concluded and past-term courses. ' +
          'The enrollment becomes SIS-managed, which means the instructor cannot remove it ' +
          'and a future batch-mode SIS job over this term could sweep it. ' +
          'Nobody gets a notification.');
    }

    var go = button(removing ? 'Remove the enrollment' : 'Add ' + roleName.toLowerCase() + ' to section',
                    removing ? 'danger' : 'primary');
    go.addEventListener('click', function () { submit(csv, go); });
    actions.appendChild(go);

    var openCourse = button('Open the section list');
    openCourse.addEventListener('click', function () {
      window.open(HOST + '/courses/' + pickedCourse.id + '/users', '_blank');
    });
    actions.appendChild(openCourse);
    preflight(++planToken, pickedUser, pickedSection, pickedCourse, roleField.select.value, removing, roleName);
  }

  /* Pre-flight facts the admin should see before clicking: does the person already
     hold this role here, is this the course's last teacher, is it the admin themself. */
  function preflight(token, user, section, course, role, removing, roleName) {
    var type = ENROLLMENT_TYPE[role];
    var warn = function (text, color) {
      if (token !== planToken || running) { return; }   // plan changed; stale facts
      planText.appendChild(el('div', { color: color || AMBER, marginTop: '8px', fontWeight: '700' }, text));
    };
    var me = window.ENV && window.ENV.current_user_id;
    if (removing && me && String(me) === String(user.id)) {
      warn('You are removing yourself. Make sure someone else can still reach this course.', DANGER);
    }
    apiAll('/api/v1/sections/' + section.id + '/enrollments?per_page=100' +
           '&state[]=active&state[]=invited&state[]=completed&state[]=inactive' +
           '&user_id=' + encodeURIComponent(user.id))
      .then(function (list) {
        var mine = (list || []).filter(function (e) {
          return String(e.user_id) === String(user.id) && e.type === type;
        })[0];
        if (!removing && mine) {
          warn((user.name || user.sortable_name) + ' already holds the ' + roleName + ' role on this section ' +
               '(state "' + mine.enrollment_state + '"). Adding it again reactivates it if needed and makes ' +
               'it SIS-managed, so a later batch-mode SIS job over this term could remove it.');
        }
        if (removing && !mine) {
          warn((user.name || user.sortable_name) + ' does not hold the ' + roleName + ' role on this section, ' +
               'so there may be nothing to remove. Check the role before you continue.');
        }
      })
      .catch(function () {});
    if (removing && role === 'teacher') {
      apiAll('/api/v1/courses/' + course.id + '/enrollments?per_page=100&type[]=TeacherEnrollment&state[]=active')
        .then(function (list) {
          var others = (list || []).filter(function (e) { return String(e.user_id) !== String(user.id); });
          if (!others.length) {
            warn('This person is the only active teacher in course ' + course.id +
                 '. Removing them leaves the course with no teacher.', DANGER);
          }
        })
        .catch(function () {});
    }
  }

  /* ---------- submit + poll --------------------------------------------- */

  var lastPollState = null;
  var TERMINAL = {
    imported: 1, imported_with_messages: 1, failed: 1,
    failed_with_messages: 1, aborted: 1
  };

  function submit(csv, go) {
    if (!sectionMatchesCourse()) {
      say('The section list belongs to a different course than the one chosen. Pick the course again.', DANGER);
      return;
    }
    running = true;
    cancelled = false;
    lockForm(true);
    planText.focus();
    say('Sending the import…', MUTED);
    announce('Sending the import to Canvas.');
    lastPollState = null;

    var startedAt = new Date();
    var targetUser = pickedUser;
    var targetSection = pickedSection;
    var targetCourse = pickedCourse;
    var targetRole = roleField.select.value;
    var targetStatus = statusField.select.value;

    postCsv('/api/v1/accounts/' + rootAccountId +
            '/sis_imports?import_type=instructure_csv&extension=csv', csv)
      .then(function (imp) {
        note('Import ' + imp.id + ' queued at ' + startedAt.toLocaleTimeString() + '.', BLUE);
        return poll(imp.id, 0);
      })
      .then(function (imp) {
        if (cancelled) { return; }
        return Promise.resolve(finish(imp, startedAt, targetUser, targetSection, targetCourse, targetRole, targetStatus))
          .catch(function (err) {
            say('The import finished, but checking the result failed: ' + err.message +
                '. Open the section list to confirm.', AMBER);
          })
          .then(function () {
            running = false;
            lockForm(false);
            // This exact change is done; the old button must not send it twice.
            go.disabled = true;
            go.style.opacity = '.5';
            go.style.cursor = 'default';
          });
      }, function (err) {
        if (cancelled) { return; }
        running = false;
        if (err && err.stillRunning) {
          say(err.message + ' This panel will not send it again, so you do not get a duplicate. ' +
              'Close and reopen the panel when you are ready for the next change.', AMBER);
          note('Still running: ' + err.message, AMBER);
          announce(planText.textContent);
          return;   // stay locked on purpose
        }
        say('The import did not run: ' + err.message, DANGER);
        note('Failed: ' + err.message, DANGER);
        lockForm(false);
        go.style.cursor = 'pointer';
      });
  }

  function poll(importId, tries) {
    if (cancelled) { return new Promise(function () {}); }   // panel closed: stop watching quietly
    if (tries > 72) {
      var late = new Error('Import ' + importId + ' is still running after three minutes. ' +
        'Check Admin > SIS Import for import ' + importId + '.');
      late.stillRunning = true;
      return Promise.reject(late);
    }
    return api('/api/v1/accounts/' + rootAccountId + '/sis_imports/' + importId)
      .then(function (imp) {
        var state = imp.workflow_state || 'unknown';
        if (state !== lastPollState) {   // announce changes, not every 2.5-second poll
          lastPollState = state;
          if (!TERMINAL[state]) { announce('Import ' + importId + ' is ' + state.replace(/_/g, ' ') + '.'); }
        }
        say('Import ' + importId + ': ' + state.replace(/_/g, ' ') +
            (imp.progress != null ? ', ' + imp.progress + '% done' : '') + '\u2026', MUTED);
        if (TERMINAL[state]) { return imp; }
        if (cancelled) { return new Promise(function () {}); }
        return new Promise(function (resolve) {
          pollTimer = setTimeout(function () { resolve(poll(importId, tries + 1)); }, 2500);
        });
      });
  }

  function finish(imp, startedAt, user, section, course, role, status) {
    var state = imp.workflow_state || 'unknown';
    var ok = state === 'imported' || state === 'imported_with_messages';

    (imp.processing_warnings || []).forEach(function (w) {
      note('Warning: ' + (Array.isArray(w) ? w.join(' \u2014 ') : String(w)), AMBER);
    });
    (imp.processing_errors || []).forEach(function (e) {
      note('Error: ' + (Array.isArray(e) ? e.join(' \u2014 ') : String(e)), DANGER);
    });

    var counts = imp.data && imp.data.counts;
    if (counts && counts.enrollments != null) {
      note('Canvas reports ' + counts.enrollments + ' enrollment row(s) processed.', MUTED);
    }

    if (!ok) {
      say('Import ' + imp.id + ' finished as "' + state.replace(/_/g, ' ') +
          '". Nothing was changed, or only part of it was. Read the messages above.', DANGER);
      return;
    }

    say('Import ' + imp.id + ' finished. Checking the roster\u2026', MUTED);
    var who = user.name || user.sortable_name;
    var where = 'section "' + (section.name || section.id) + '"';
    return verify(user, section, role).then(function (result) {
      if (result.error) {
        say('Import ' + imp.id + ' finished, but the roster check could not run. Open the section ' +
            'list and confirm before you tell anyone it is done.', AMBER);
      } else if (status === 'deleted') {
        if (result.found) {
          say(who + ' still holds the ' + role + ' enrollment on ' + where + ' (state "' + result.state +
              '"). The removal did not take effect. Read the messages above.', DANGER);
        } else {
          say('Done. ' + who + ' no longer holds the ' + role + ' enrollment on ' + where + '.', GREEN);
        }
      } else if (result.found) {
        say('Done. ' + who + ' is on ' + where + ' as ' + role + ' with state "' + result.state + '".', GREEN);
      } else {
        say('Import ' + imp.id + ' reported success, but the enrollment did not turn up on ' +
            'the section roster. Open the section list and confirm before you tell anyone ' +
            'it is done.', AMBER);
      }
      if (lastSayColor !== DANGER) { announce(planText.textContent); }
      note(auditLine(startedAt, user, section, course, role, status, imp.id), MUTED);
      addCopyButton(auditLine(startedAt, user, section, course, role, status, imp.id));
    });
  }

  var ENROLLMENT_TYPE = {
    teacher: 'TeacherEnrollment', ta: 'TaEnrollment', designer: 'DesignerEnrollment',
    observer: 'ObserverEnrollment', student: 'StudentEnrollment'
  };

  function verify(user, section, role) {
    return apiAll('/api/v1/sections/' + section.id + '/enrollments' +
               '?per_page=100&state[]=active&state[]=invited&state[]=completed' +
               '&user_id=' + encodeURIComponent(user.id))
      .then(function (list) {
        var type = ENROLLMENT_TYPE[role];
        var hit = (list || []).filter(function (e) {
          return String(e.user_id) === String(user.id) && (!type || e.type === type);
        })[0];
        return hit
          ? { found: true, state: hit.enrollment_state || 'unknown' }
          : { found: false, state: null };
      })
      .catch(function () { return { error: true }; });   // unverified is not success
  }

  function auditLine(startedAt, user, section, course, role, status, importId) {
    return [
      startedAt.toISOString(),
      'sis_import=' + importId,
      'status=' + status,
      'role=' + role,
      'user=' + (user.sis_user_id || ('canvas:' + user.id)) + ' (' + (user.name || '') + ')',
      'section=' + (section.sis_section_id || ('canvas:' + section.id)),
      'course=' + course.id + ' ' + (course.sis_course_id || '')
    ].join(' | ');
  }

  function addCopyButton(line) {
    var copy = button('Copy the audit line');
    copy.addEventListener('click', function () {
      if (navigator.clipboard) {
        navigator.clipboard.writeText(line).then(function () {
          copy.textContent = 'Copied';
            announce('Audit record copied to the clipboard.');
        });
      }
    });
    actions.appendChild(copy);
  }

  /* ---------- start ------------------------------------------------------ */

  // Credit line: tool, version, maker, and a way back to the install page.
  // A plain link, so nothing is fetched or run. The version lets someone
  // compare their installed bookmark against the page.
  var credit = el('div', { fontSize: '12px', color: '#55656F', marginTop: '12px' },
    'Add or remove enrollment ' + VERSION + ' \u00b7 Technology Consigliere \u00b7 ');
  var creditLink = el('a', { color: BLUE, textDecoration: 'underline' }, 'Help and updates');
  creditLink.setAttribute('aria-label', 'Help and updates (opens in a new tab)');
  creditLink.href = HOME;
  creditLink.target = '_blank';
  creditLink.rel = 'noopener noreferrer';
  credit.appendChild(creditLink);
  foot.appendChild(credit);

  document.body.appendChild(panel);
  say('Finding an account to search\u2026', MUTED);
  function resolveRoot() {
    // SIS imports only run on a root account. Searching can stay in the subaccount.
    return api('/api/v1/accounts/' + accountId)
      .then(function (a) { rootAccountId = (a && a.root_account_id) || accountId; })
      .catch(function () { rootAccountId = accountId; });
  }

  resolveAccount()
    .then(function (id) { return resolveRoot().then(function () { return id; }); })
    .then(function (id) {
      headSub.textContent = String(rootAccountId) === String(id)
        ? 'Searching account ' + id + '. Writes go in as a SIS import.'
        : 'Searching subaccount ' + id + '. Writes go in as a SIS import on root account ' + rootAccountId + '.';
      if (accountGuessed) {
        note('You have admin rights on more than one account, and this page did not name ' +
             'one, so the search and the SIS import both run against account ' + id + '. ' +
             'If that is the wrong account, open the account you want in Canvas and click ' +
             'the bookmarklet again from there.', AMBER);
      }
      userCombo.focus();
      refreshPlan();
    })
    .catch(function (err) { say(err.message, DANGER); });
})();
