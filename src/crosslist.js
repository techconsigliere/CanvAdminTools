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
  var VERSION = '2.1.7';
  var HOME = 'https://techconsigliere.github.io/CanvAdminTools/';
  var already = document.getElementById(PANEL_ID);
  if (already) {                                // second click closes it
    if (typeof already.__tcClose === 'function') { already.__tcClose(); } else { already.remove(); }
    return;
  }

  var MAX_SECONDARY = 9;
  var HOST = location.origin;
  var accountId = null;
  var primary = null;      // course the sections move INTO
  var blocks = [];         // one entry per secondary course
  var lastMoved = [];      // [{id, name}] for the undo button
  var running = false;     // a move run is in progress
  var cancelled = false;   // admin asked to stop after the current section

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
      var FB = 'https://techconsigliere.github.io/CanvAdminTools/fonts/';
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

  var SIGNED_OUT = 'Canvas answered with a sign-in page instead of data, which usually means ' +
    'your session expired. Reload this tab, sign in again, and run the tool again. Anything ' +
    'already finished is listed in the panel.';
  var THROTTLED = 'Canvas is throttling requests from this tab and kept saying "slow down" ' +
    'after several retries. Wait a minute and try again. Anything already finished is listed in the panel.';

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function init(method, body, type) {
    var h = { 'Accept': 'application/json', 'X-CSRF-Token': csrf() };
    if (type) { h['Content-Type'] = type; }
    return { method: method || 'GET', credentials: 'same-origin', headers: h, body: body };
  }

  function failure(res, data, url) {
    if (res.status === 401) { return new Error(SIGNED_OUT); }
    var msg = (data && (data.message || (data.errors && JSON.stringify(data.errors)))) ||
              (res.status + ' ' + res.statusText);
    return new Error(msg);
  }

  // Every call goes through here. Canvas throttles with 429 (or a 403 saying
  // "Rate Limit Exceeded"); a throttled request did nothing, so it is safe to
  // wait and resend, doubling the wait each time, up to five tries. When the
  // remaining quota runs low the tool also pauses a beat on its own.
  function request(url, opts, tries) {
    tries = tries || 0;
    return fetch(url, opts).then(function (res) {
      return res.text().then(function (text) {
        var throttled = res.status === 429 || (res.status === 403 && /rate limit exceeded/i.test(text));
        if (throttled) {
          if (tries >= 5) { throw new Error(THROTTLED); }
          return sleep(1000 * Math.pow(2, tries) + Math.floor(Math.random() * 300))
            .then(function () { return request(url, opts, tries + 1); });
        }
        var type = res.headers.get('Content-Type') || '';
        if (/\/login(\/|\?|$)/.test(res.url || '') || (res.ok && /text\/html/i.test(type))) {
          throw new Error(SIGNED_OUT);
        }
        var data = null;
        // Canvas can prefix JSON with while(1); as an anti-hijacking measure.
        try { data = JSON.parse(text.replace(/^while\(1\);/, '')); } catch (e) {}
        if (!res.ok) { throw failure(res, data, url); }
        if (data === null && text.trim()) {
          throw new Error('Canvas sent back something this tool could not read (' + (type || 'no type') + ').');
        }
        var out = { data: data, link: res.headers.get('Link') || '' };
        var left = parseFloat(res.headers.get('X-Rate-Limit-Remaining'));
        return left < 100 ? sleep(1000).then(function () { return out; }) : out;
      });
    });
  }

  function api(path, method) {
    return request(HOST + path, init(method)).then(function (r) { return r.data; });
  }

  function apiAll(path, cap) {
    var out = [];
    cap = cap || 2000;
    function step(url) {
      return request(url, init()).then(function (r) {
        out = out.concat(r.data || []);
        var m = r.link.match(/<([^>]+)>;\s*rel="next"/);
        if (m && out.length < cap && m[1].indexOf(HOST + '/') === 0) { return step(m[1]); }
        return out;
      });
    }
    return step(HOST + path);
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
      list.truncated = list.length >= 25;
      if (!list.length && /^[\w.\-]{4,}$/.test(term)) {
        // Nothing matched the fuzzy search. Try an exact SIS ID lookup,
        // which reaches courses whose SIS ID does not appear in the
        // searchable name/code columns.
        return api('/api/v1/courses/sis_course_id:' + encodeURIComponent(term).replace(/\./g, '%2E') +
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

  var uid = 0;
  function nextId(p) { return PANEL_ID + '-' + p + '-' + (++uid); }
  function srOnly() {
    return { position: 'absolute', width: '1px', height: '1px', padding: '0', margin: '-1px',
             overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap', border: '0' };
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
      var kb = true;
      try { kb = b.matches(':focus-visible'); } catch (e) {}
      if (!kb) { return; }
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
      boxShadow: '0 4px 14px rgba(0,0,0,.16)', maxHeight: '260px',
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

    function choose(c) {
      closeMenu();
      input.value = (c.course_code || c.name || '') + ' (id ' + c.id + ')';
      picked.textContent = courseLine(c);
      onPick(c);
      announce('Selected ' + input.value + '.');
    }

    function render(list) {
      menu.textContent = '';
      rows = list;
      if (!list.length) {
        menu.appendChild(el('div', { padding: '10px', color: MUTED, fontSize: '13px' },
          'No courses matched. Try the SIS ID or the course code.'));
        menu.style.display = 'block';
        announce(menu.textContent);
        return;
      }
      list.forEach(function (c, i) {
        var row = el('div', {
          padding: '8px 10px', cursor: 'pointer', borderBottom: '1px solid ' + HAIR,
          fontSize: '13px', lineHeight: '1.4'
        }, courseLine(c));
        row.id = menuId + '-o' + i;
        row.setAttribute('role', 'option');
        row.addEventListener('mouseenter', function () { highlight(i); });
        row.addEventListener('mousedown', function (ev) { ev.preventDefault(); choose(c); });
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
      if (term.length < 3) { closeMenu(); return; }   // Canvas rejects shorter terms
      timer = setTimeout(function () {
        searchCourses(term).then(render).catch(function (err) {
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

    wrap.appendChild(lab);
    var hint = el('div', { fontSize: '12px', color: MUTED, margin: '0 0 5px' },
      'Type 3 or more characters of the SIS ID, course code, or name.');
    hint.id = hintId;
    wrap.appendChild(hint);
    wrap.appendChild(input);
    wrap.appendChild(menu);
    wrap.appendChild(picked);
    return { wrap: wrap, focus: function () { input.focus(); } };
  }

  /* ---------- panel shell -------------------------------------------- */

  var panel = el('div', {
    position: 'fixed', top: '16px', right: '16px', width: 'min(540px, calc(100vw - 32px))', maxHeight: '90vh',
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
    background: SHELL, borderRadius: '8px 8px 0 0', cursor: 'move',
    flex: '0 0 auto'
  });
  var headText = el('div');
  var titleEl = el('h2', { fontWeight: '700', fontSize: '16px', margin: '0', color: INK, lineHeight: '1.3' }, 'Cross-list sections');
  titleEl.id = PANEL_ID + '-title';
  titleEl.setAttribute('tabindex', '-1');
  headText.appendChild(titleEl);
  var headSub = el('div', { fontSize: '13px', color: MUTED, marginTop: '2px' }, '');
  headText.appendChild(headSub);
  head.appendChild(headText);
  var closeBtn = button('Close');
  function guardUnload(e) { e.preventDefault(); e.returnValue = ''; return ''; }
  function closePanel() {
    if (running) {
      if (window.confirm('Sections are still being moved. Stop after the current section? ' +
                         'The panel stays open so you can see what moved and use Undo.')) {
        cancelled = true;
        say('Stopping after the current section\u2026', AMBER);
      }
      return;
    }
    window.removeEventListener('beforeunload', guardUnload);
    panel.remove();
    if (prevFocus && prevFocus.focus) { try { prevFocus.focus(); } catch (e) {} }
  }
  closeBtn.addEventListener('click', closePanel);
  panel.__tcClose = closePanel;
  function lockForm() {
    Array.prototype.forEach.call(panel.querySelectorAll('input, select, button'), function (b) {
      if (b !== closeBtn && b !== dockBtn) { b.disabled = true; b.style.opacity = '.55'; b.style.cursor = 'default'; }
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
    // Page-level listeners take themselves off once the panel is gone,
    // whichever way it was closed.
    function onMove(ev) {
      if (!panel.isConnected) { detach(); return; }
      if (!dragging) { return; }
      panel.style.left = Math.max(0, ev.clientX - offX) + 'px';
      panel.style.top = Math.max(0, ev.clientY - offY) + 'px';
    }
    function onUp() { dragging = false; if (!panel.isConnected) { detach(); } }
    function detach() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
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
    block.titleEl = el('h3', { fontWeight: '700', fontSize: '13px', color: MUTED, margin: '0' }, '');
    cardHead.appendChild(block.titleEl);
    var rm = button('Remove', 'quiet');
    rm.addEventListener('click', function () {
      blocks.splice(blocks.indexOf(block), 1);
      card.remove();
      renumber();
      refreshPlan();
      announce('Secondary course removed.');
      if (blocks.length) { blocks[blocks.length - 1].focus(); } else { addBtn.focus(); }
    });
    block.rmBtn = rm;
    cardHead.appendChild(rm);
    card.appendChild(cardHead);

    var cb = combo('Sections move out of this course', function (c) {
      block.course = c;
      card.style.borderLeftColor = c ? BLUE : HAIR;
      loadSections(block);
    });
    card.appendChild(cb.wrap);
    block.focus = cb.focus;

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
      b.rmBtn.setAttribute('aria-label', 'Remove secondary course ' + (i + 1));
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
    var cid = block.course.id;
    var current = function () { return block.course && String(block.course.id) === String(cid); };
    apiAll('/api/v1/courses/' + cid +
        '/sections?per_page=100&include[]=total_students')
      .then(function (list) {
        if (!current()) { return; }   // a newer pick replaced this course; drop the late reply
        block.sections = list || [];
        renderSections(block);
        refreshPlan();
      })
      .catch(function (err) {
        if (!current()) { return; }
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
    var capId = nextId('cap');
    var cap = el('div', { fontWeight: '700', fontSize: '13px', color: INK },
      'Sections to move (' + block.sections.length + ')');
    cap.id = capId;
    listHead.appendChild(cap);
    boxEl.setAttribute('role', 'group');
    boxEl.setAttribute('aria-labelledby', capId);

    var toggle = button('Select all', 'quiet');
    var courseName = (block.course && (block.course.course_code || block.course.name)) || 'this course';
    function syncToggle() {
      var all = boxEl.querySelectorAll('input[type=checkbox]'), on = 0;
      for (var k = 0; k < all.length; k++) { if (all[k].checked) { on++; } }
      toggle.textContent = (all.length && on === all.length) ? 'Select none' : 'Select all';
      toggle.setAttribute('aria-label', toggle.textContent + ' sections in ' + courseName);
    }
    syncToggle();
    toggle.addEventListener('click', function () {
      var boxes = boxEl.querySelectorAll('input[type=checkbox]');
      var turnOn = toggle.textContent === 'Select all';
      for (var i = 0; i < boxes.length; i++) { boxes[i].checked = turnOn; }
      syncToggle();
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
      box.addEventListener('change', function () { syncToggle(); refreshPlan(); });
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
    if (running) { return; }
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
        'Teacher, TA, and any other enrollments in those sections move with them. ' +
        'The source courses keep their own content, settings, and any sections you left unchecked. ' +
        'Nothing is deleted, and Canvas records each section\u2019s home course so the move can be reversed.');

    if (students > 0) {
      planText.appendChild(el('div', {
        color: AMBER, marginTop: '8px', fontWeight: '700'
      }, 'Check for submitted work before moving a section in a course that has already started. ' +
         'Submissions and grades stay behind in the source course, and the students lose access to them. ' +
         'Cross-listing is safest before the term opens.'));
    }

    var termOf = function (c) { return c && c.term && c.term.id != null ? String(c.term.id) : null; };
    var pTerm = termOf(primary);
    var otherTerm = chosen.filter(function (b) { var t = termOf(b.course); return pTerm && t && t !== pTerm; });
    if (otherTerm.length) {
      planText.appendChild(el('div', { color: AMBER, marginTop: '8px', fontWeight: '700' },
        'Course' + (otherTerm.length === 1 ? ' ' : 's ') +
        otherTerm.map(function (b) { return b.course.id + ' (' + ((b.course.term && b.course.term.name) || 'another term') + ')'; }).join(', ') +
        (otherTerm.length === 1 ? ' is' : ' are') + ' not in the primary course\u2019s term (' +
        ((primary.term && primary.term.name) || 'unknown') + '). Moving sections across terms changes ' +
        'those students\u2019 enrollment dates and when they can get in.'));
    }
    var concluded = [primary].concat(chosen.map(function (b) { return b.course; }))
      .filter(function (c) { return c && c.workflow_state === 'completed'; });
    if (concluded.length) {
      planText.appendChild(el('div', { color: AMBER, marginTop: '8px', fontWeight: '700' },
        'Course' + (concluded.length === 1 ? ' ' : 's ') +
        concluded.map(function (c) { return c.id; }).join(', ') +
        (concluded.length === 1 ? ' is' : ' are') + ' concluded. Students in a concluded course ' +
        'can only view it, and moving sections in or out of one rarely does what people expect.'));
    }

    var go = button('Move ' + moves.length + ' section' + (moves.length === 1 ? '' : 's') +
                    ' into course ' + primary.id, 'primary');
    go.addEventListener('click', function () { execute(moves); });
    actions.appendChild(go);
  }

  function auditRecord(startedAt, moved, target) {
    var head = startedAt.toISOString() + ' | crosslist | into course ' + target.id +
               ' ' + (target.sis_course_id || '') + ' "' + (target.course_code || target.name) + '"';
    var rows = moved.map(function (m) {
      return '  section ' + m.id + ' ' + (m.sis || 'no-sis') +
             ' "' + (m.name || '') + '"' +
             ' <- came from course ' + m.cameFrom + ' ' + (m.cameFromSis || '') +
             (m.wasXlisted ? ' (Canvas home course ' + m.home + ')' : '');
    });
    return [head].concat(rows).join('\n');
  }

  function execute(moves) {
    // Lock the target now. Everything below uses this copy, never the live
    // picker, so editing the form mid-run cannot redirect the remaining moves.
    var target = primary;
    running = true;
    cancelled = false;
    lockForm();
    planText.focus();
    window.addEventListener('beforeunload', guardUnload);
    actions.textContent = '';
    log.textContent = '';
    lastMoved = [];
    var startedAt = new Date();
    say('Working…', MUTED);
    announce('Moving ' + moves.length + ' section' + (moves.length === 1 ? '' : 's') +
             ' into course ' + target.id + '.');

    var chain = Promise.resolve();
    moves.forEach(function (m) {
      chain = chain.then(function () {
        if (cancelled) { return; }
        // Defense in depth: the section must still belong to the course it is listed under.
        if (m.section.course_id != null && String(m.section.course_id) !== String(m.from.id)) {
          log.appendChild(el('div', { color: DANGER, padding: '2px 0' },
            'Section ' + m.section.id + ' was not moved: it no longer matches course ' +
            m.from.id + '. Reload the panel and try again.'));
          return;
        }
        return api('/api/v1/sections/' + m.section.id + '/crosslist/' + target.id, 'POST')
          .then(function (data) {
            if (data && data.course_id != null && String(data.course_id) !== String(target.id)) {
              throw new Error('Canvas reports it in course ' + data.course_id + ', not ' + target.id);
            }
            lastMoved.push({
              id: m.section.id,
              name: m.section.name,
              sis: m.section.sis_section_id,
              cameFrom: m.from.id,
              cameFromSis: m.from.sis_course_id,
              home: m.section.nonxlist_course_id || m.from.id,
              wasXlisted: !!m.section.nonxlist_course_id
            });
            log.appendChild(el('div', { color: GREEN, padding: '2px 0' },
              'Moved section ' + m.section.id + ' "' + (m.section.name || '') +
              '" from course ' + m.from.id + ' into course ' + target.id + '.'));
          })
          .catch(function (err) {
            log.appendChild(el('div', { color: DANGER, padding: '2px 0' },
              'Section ' + m.section.id + ' "' + (m.section.name || '') +
              '" was not moved: ' + err.message));
          });
      });
    });

    chain.catch(function (err) {
      log.appendChild(el('div', { color: DANGER, padding: '2px 0' },
        'The run stopped unexpectedly: ' + ((err && err.message) || err)));
    }).then(function () {
      running = false;
      window.removeEventListener('beforeunload', guardUnload);
      var stopped = cancelled && lastMoved.length < moves.length;
      say(lastMoved.length + ' of ' + moves.length + ' sections moved' +
          (stopped ? ' (you stopped the run)' : '') +
          '. Details are in the panel above. To set up another move, close and reopen the panel.',
          lastMoved.length === moves.length ? GREEN : DANGER);
      if (lastMoved.length === moves.length) { announce(planText.textContent); }

      var openLink = button('Open course ' + target.id);
      openLink.setAttribute('aria-label', 'Open course ' + target.id + ' section settings (opens in a new tab)');
      openLink.addEventListener('click', function () {
        window.open(HOST + '/courses/' + target.id + '/settings#tab-sections', '_blank', 'noopener');
      });
      actions.appendChild(openLink);

      if (lastMoved.length) {
        var moved = lastMoved.slice();   // this run only; undo never reads a later run
        var record = auditRecord(startedAt, moved, target);

        log.appendChild(el('div', {
          marginTop: '10px', paddingTop: '8px', borderTop: '1px solid ' + HAIR,
          color: MUTED, whiteSpace: 'pre-wrap', lineHeight: '1.5'
        }, record));

        var copy = button('Copy the audit record');
        wireCopy(copy, record);
        actions.appendChild(copy);

        log.appendChild(el('div', { color: AMBER, marginTop: '8px', lineHeight: '1.5' },
          'The undo button below only exists in this browser tab. Close or reload the tab and it ' +
          'is gone. The audit record above lists the course each section came from, which is what ' +
          'you need to return them by hand from Settings > Sections in the primary course.'));

        var undo = button('Undo: return these ' + moved.length + ' sections to where they came from');
        undo.addEventListener('click', function () {
          planText.focus();
          undo.disabled = true;
          announce('Returning ' + moved.length + ' sections.');
          undo.style.opacity = '.5';
          var ok = 0;
          var back = Promise.resolve();
          moved.forEach(function (m) {
            back = back.then(function () {
              // A section that was already cross-listed goes back to the course it came
              // from (re-cross-list), not to its Canvas home course (DELETE would do that).
              var req = m.wasXlisted
                ? api('/api/v1/sections/' + m.id + '/crosslist/' + m.cameFrom, 'POST')
                : api('/api/v1/sections/' + m.id + '/crosslist', 'DELETE');
              return req.then(function () {
                ok++;
                log.appendChild(el('div', { color: BLUE, padding: '2px 0' },
                  'Section ' + m.id + ' returned to course ' + m.cameFrom + '.'));
              }).catch(function (err) {
                log.appendChild(el('div', { color: DANGER, padding: '2px 0' },
                  'Section ' + m.id + ' could not be returned: ' + err.message));
              });
            });
          });
          back.then(function () {
            say('Undo finished: ' + ok + ' of ' + moved.length + ' sections returned. Reload the courses to confirm.',
                ok === moved.length ? GREEN : DANGER);
            if (ok === moved.length) { announce(planText.textContent); }
          });
        });
        actions.appendChild(undo);
      }
    });
  }

  // Clipboard API first; the old execCommand route for pages where it is blocked.
  function copyText(text) {
    function legacy() {
      var ta = el('textarea', { position: 'fixed', top: '0', left: '0', opacity: '0' });
      ta.value = text;
      panel.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) {}
      ta.remove();
      return ok ? Promise.resolve() : Promise.reject(new Error('blocked'));
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(legacy);
    }
    return legacy();
  }
  function wireCopy(btn, text) {
    btn.addEventListener('click', function () {
      copyText(text).then(function () {
        btn.textContent = 'Copied';
        announce('Audit record copied to the clipboard.');
      }, function () {
        btn.textContent = 'Copy blocked: select the record and press Ctrl+C or \u2318C';
        announce('This page blocked copying. Select the audit record and copy it by hand.', true);
      });
      btn.focus();
    });
  }

  // Search needs the account; keep the fields shut until it is known.
  function setReady(on) {
    var ins = panel.querySelectorAll('input[type=text]');
    for (var i = 0; i < ins.length; i++) { ins[i].disabled = !on; }
    addBtn.disabled = !on;
  }

  /* ---------- start -------------------------------------------------- */

  // Credit line: tool, version, maker, and a way back to the install page.
  // A plain link, so nothing is fetched or run. The version lets someone
  // compare their installed bookmark against the page.
  var credit = el('div', { fontSize: '12px', color: '#55656F', marginTop: '12px' },
    'Cross-list sections ' + VERSION + ' \u00b7 Technology Consigliere \u00b7 ');
  var creditLink = el('a', { color: BLUE, textDecoration: 'underline' }, 'Help and updates');
  creditLink.setAttribute('aria-label', 'Help and updates (opens in a new tab)');
  creditLink.href = HOME;
  creditLink.target = '_blank';
  creditLink.rel = 'noopener noreferrer';
  credit.appendChild(creditLink);
  foot.appendChild(credit);

  document.body.appendChild(panel);
  addSecondary();
  setReady(false);
  if (!csrf()) {
    say('Canvas\'s security token is missing from this tab, so every change would be refused. ' +
        'Open a regular Canvas page (not a file preview or an embedded tool), reload it, and ' +
        'click the bookmarklet again.', DANGER);
  } else {
    say('Finding an account to search\u2026', MUTED);
    resolveAccount()
      .then(function (id) {
        headSub.textContent = 'Searching courses in account ' + id;
        setReady(true);
        primaryCombo.focus();
        refreshPlan();
      })
      .catch(function (err) { say(err.message, DANGER); });
  }
})();
