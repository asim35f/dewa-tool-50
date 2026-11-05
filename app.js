/* DEWA Field App — supervisor + admin PWA
   Talks to DEWA_App_Backend.gs (Apps Script web app). Works offline: jobs are cached on
   the phone and completions / problem reports are queued until there is signal. */
(function () {
  'use strict';

  var VERSION = '1.1.0';
  var REASONS = ['Vehicle parked', 'No access / fence', 'Site closed', 'Security hold', 'Gate pass needed',
                 'Other contractor working', 'No interlock at location', 'Other'];
  var STATUSES = ['Pending', 'In Progress', 'Partially Completed', 'Completed'];

  // ─── storage ──────────────────────────────────────────────────────────────
  var LS = {
    get: function (k, d) { try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) {} }
  };

  var S = {
    me: LS.get('dewa_me', null),
    jobs: LS.get('dewa_jobs', []),
    team: LS.get('dewa_team', []),
    today: LS.get('dewa_today', ''),
    tab: 'jobs', filter: 'pending', sort: LS.get('dewa_sort', 'smart'), q: '',
    pos: null, shown: 60, waiting: {}, queue: 0, allHistory: false, issues: null, busy: false
  };

  // ─── helpers ──────────────────────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function uid() { return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function todayStr() { var d = new Date(); return d.getDate() + ' ' + MON[d.getMonth()] + ' ' + d.getFullYear(); }
  function dmyKey(s) { var m = String(s || '').match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/); return m ? +m[3] * 10000 + +m[2] * 100 + +m[1] : 0; }
  function cdateKey(s) {
    var m = String(s || '').match(/^(\d{1,2}) ([A-Za-z]{3}) (\d{4})$/);
    return m ? +m[3] * 10000 + (MON.indexOf(m[2]) + 1) * 100 + +m[1] : 0;
  }
  function monthOf(s) { var m = String(s || '').match(/^\d{1,2} ([A-Za-z]{3}) (\d{4})$/); return m ? m[1] + ' ' + m[2] : ''; }
  function km(a, b, c, d) {
    var R = 6371, toR = Math.PI / 180, dLa = (c - a) * toR, dLo = (d - b) * toR;
    var x = Math.sin(dLa / 2) * Math.sin(dLa / 2) + Math.cos(a * toR) * Math.cos(c * toR) * Math.sin(dLo / 2) * Math.sin(dLo / 2);
    return 2 * R * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  }
  function dist(j) { return S.pos && j.lat ? km(S.pos.lat, S.pos.lon, j.lat, j.lon) : null; }
  function fmtKm(d) { return d == null ? '' : d < 1 ? Math.round(d * 1000) + ' m' : d.toFixed(1) + ' km'; }
  function clean(v) { v = String(v == null ? '' : v).trim(); return /:$/.test(v) ? '' : v; } // old rows hold PDF labels like "DM No.:"
  function isDone(j) { return /complete/i.test(j.status) && !/partial/i.test(j.status); }
  function isUrgent(j) { return /urgent/i.test(j.notes || '') || /urgent/i.test(j.dim || ''); }
  function kind(j) {
    if (S.waiting[j.n]) return 'wait';
    if (isDone(j)) return 'done';
    if (j.issue) return 'issue';
    if (isUrgent(j)) return 'urgent';
    return 'pend';
  }
  function teamColor(name) {
    var t = S.team.filter(function (x) { return x.name === name; })[0];
    return t ? t.color : '#64748b';
  }
  function toast(msg, bad) {
    var t = document.createElement('div');
    t.className = 'toast' + (bad ? ' bad' : '');
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, bad ? 4500 : 2600);
  }

  // ─── API ──────────────────────────────────────────────────────────────────
  function NetError(msg) { this.message = msg; this.net = true; }

  function api(action, data, auth) {
    var who = auth || (S.me ? { user: S.me.user, pin: S.me.pin } : {});
    var body = Object.assign({ action: action }, who, data || {});
    if (window.DEWA_MOCK) return window.DEWA_MOCK(body);
    var url = window.DEWA_API;
    if (!url || /PASTE/.test(url)) return Promise.reject(new Error('App not set up: put the backend URL in config.js'));
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), redirect: 'follow' })
      .then(function (r) {
        if (!r.ok) throw new NetError('Server HTTP ' + r.status);
        return r.text();
      }, function () { throw new NetError('No connection'); })
      .then(function (t) {
        try { return JSON.parse(t); } catch (e) { throw new Error('Server error — please try again'); }
      });
  }

  // ─── offline queue (IndexedDB, localStorage fallback) ────────────────────
  var DB = {
    db: null,
    open: function () {
      var self = this;
      if (self.db) return Promise.resolve(self.db);
      if (!window.indexedDB) return Promise.resolve(null);
      return new Promise(function (res) {
        var rq = indexedDB.open('dewa-field-app', 1);
        rq.onupgradeneeded = function () { rq.result.createObjectStore('queue', { keyPath: 'id' }); };
        rq.onsuccess = function () { self.db = rq.result; res(self.db); };
        rq.onerror = function () { res(null); };
      });
    },
    tx: function (mode, fn) {
      return this.open().then(function (db) {
        if (!db) {
          var arr = LS.get('dewa_queue', []);
          var out = fn(null, arr);
          LS.set('dewa_queue', arr);
          return out;
        }
        return new Promise(function (res, rej) {
          var t = db.transaction('queue', mode), st = t.objectStore('queue'), result;
          var r = fn(st);
          if (r && 'onsuccess' in r) r.onsuccess = function () { result = r.result; };
          t.oncomplete = function () { res(result); };
          t.onerror = function () { rej(t.error); };
        });
      });
    },
    all: function () { return this.tx('readonly', function (st, arr) { return st ? st.getAll() : arr.slice(); }).then(function (r) { return r || []; }); },
    put: function (it) { return this.tx('readwrite', function (st, arr) { if (st) return st.put(it); arr.push(it); }); },
    del: function (id) {
      return this.tx('readwrite', function (st, arr) {
        if (st) return st.delete(id);
        for (var i = arr.length - 1; i >= 0; i--) if (arr[i].id === id) arr.splice(i, 1);
      });
    }
  };

  function refreshQueueState() {
    return DB.all().then(function (items) {
      S.queue = items.length;
      S.waiting = {};
      items.forEach(function (it) { if (it.action === 'complete') S.waiting[it.payload.n] = it.payload; });
      renderNet();
    });
  }

  /** Sends now; if there is no signal, keeps it on the phone and sends later. */
  function submit(action, payload) {
    payload.clientId = payload.clientId || uid();
    payload.at = payload.at || new Date().toISOString();
    var auth = { user: S.me.user, pin: S.me.pin };
    return api(action, payload, auth).then(function (r) {
      if (!r.ok && /busy/i.test(r.msg || '')) throw new NetError(r.msg);
      return { sent: true, r: r };
    }).catch(function (e) {
      if (!e || !e.net) throw e;
      return DB.put({ id: payload.clientId, action: action, payload: payload, auth: auth, created: Date.now() })
        .then(refreshQueueState).then(function () { return { queued: true }; });
    });
  }

  var flushing = false;
  function flush() {
    if (flushing || !S.me) return Promise.resolve();
    flushing = true;
    var sentAny = false;
    return DB.all().then(function (items) {
      items.sort(function (a, b) { return a.created - b.created; });
      var chain = Promise.resolve(), stop = false;
      items.forEach(function (it) {
        chain = chain.then(function () {
          if (stop) return;
          return api(it.action, it.payload, it.auth).then(function (r) {
            if (!r.ok && /busy/i.test(r.msg || '')) { stop = true; return; }
            if (!r.ok) toast('Could not send ' + (it.payload.n || '') + ': ' + r.msg, true);
            sentAny = true;
            return DB.del(it.id);
          }, function (e) { if (e && e.net) stop = true; else return DB.del(it.id); });
        });
      });
      return chain;
    }).then(refreshQueueState).then(function () {
      flushing = false;
      if (sentAny) { toast('Saved work sent ✓'); loadJobs(true); }
    }, function () { flushing = false; });
  }

  // ─── login ────────────────────────────────────────────────────────────────
  var selName = '';
  function showLogin() {
    $('app').classList.add('hidden');
    $('login').classList.remove('hidden');
    $('pin').value = '';
    $('loginErr').textContent = '';
    renderNames();
    api('teamNames', {}, {}).then(function (r) {
      if (r && r.ok) { S.team = r.team; LS.set('dewa_team', r.team); renderNames(); }
    }).catch(function () {
      if (!S.team.length) $('loginErr').textContent = 'No connection. Connect once to load the team list.';
    });
  }
  function renderNames() {
    var g = $('nameGrid');
    g.innerHTML = S.team.map(function (t) {
      return '<button class="namebtn' + (selName === t.name ? ' sel' : '') + '" data-name="' + esc(t.name) + '" style="border-left:6px solid ' + esc(t.color) + '">' + esc(t.name) + '</button>';
    }).join('') + '<button class="namebtn admin' + (selName === 'Admin' ? ' sel' : '') + '" data-name="Admin">Admin / Office</button>';
  }
  function doLogin() {
    var pin = $('pin').value.trim();
    if (!selName) { $('loginErr').textContent = 'Tap your name first'; return; }
    if (!pin) { $('loginErr').textContent = 'Enter your PIN'; return; }
    $('loginBtn').disabled = true;
    $('loginErr').innerHTML = '<span class="spin"></span>';
    api('login', {}, { user: selName, pin: pin }).then(function (r) {
      $('loginBtn').disabled = false;
      if (!r.ok) { $('loginErr').textContent = r.msg || 'Login failed'; return; }
      S.me = { user: r.name, pin: pin, role: r.role };
      if (r.team) { S.team = r.team; LS.set('dewa_team', r.team); }
      LS.set('dewa_me', S.me);
      S.jobs = []; LS.del('dewa_jobs');
      start();
    }, function (e) {
      $('loginBtn').disabled = false;
      $('loginErr').textContent = e.net ? 'No connection — login needs signal the first time' : e.message;
    });
  }
  function logout() {
    var go = function () {
      S.me = null; LS.del('dewa_me'); LS.del('dewa_jobs');
      S.jobs = []; S.issues = null; S.allHistory = false; selName = '';
      closeSheet();
      showLogin();
    };
    if (S.queue) {
      if (!confirm(S.queue + ' item(s) are not sent yet. They will be sent the next time someone logs in on this phone. Log out anyway?')) return;
    }
    go();
  }

  // ─── app shell ────────────────────────────────────────────────────────────
  function start() {
    $('login').classList.add('hidden');
    $('app').classList.remove('hidden');
    var admin = S.me.role === 'admin';
    $('who').innerHTML = esc(S.me.user) + '<small>' + (admin ? 'Office / admin' : 'Supervisor') + ' · v' + VERSION + '</small>';
    var tabs = [['jobs', '☰', 'Jobs'], ['map', '⌖', 'Map'], ['sum', '∑', 'Summary']];
    if (admin) tabs.push(['issues', '⚠', 'Problems'], ['team', '👥', 'Team']);
    $('nav').innerHTML = tabs.map(function (t) {
      return '<button data-tab="' + t[0] + '"><b>' + t[1] + '</b>' + t[2] + (t[0] === 'issues' ? '<span class="badge hidden" id="issBadge"></span>' : '') + '</button>';
    }).join('');
    $('sort').value = S.sort;
    setTab('jobs');
    refreshQueueState().then(function () { render(); flush(); });
    loadJobs();
    watchGps();
  }

  function setTab(t) {
    S.tab = t;
    ['jobs', 'map', 'sum', 'issues', 'team'].forEach(function (x) { $('tab-' + x).classList.toggle('hidden', x !== t); });
    Array.prototype.forEach.call($('nav').children, function (b) { b.classList.toggle('on', b.getAttribute('data-tab') === t); });
    $('main').scrollTop = 0;
    if (t === 'map') showMap();
    if (t === 'sum') renderSummary();
    if (t === 'issues') loadIssues();
    if (t === 'team') loadTeam();
  }

  function renderNet() {
    var p = $('netPill');
    var on = navigator.onLine;
    p.className = 'pill' + (on ? '' : ' off') + (S.queue ? ' q' : '');
    p.textContent = (on ? '● Online' : '● Offline') + (S.queue ? ' · ' + S.queue + ' waiting' : '');
  }

  function loadJobs(silent) {
    if (!S.me) return Promise.resolve();
    $('refreshBtn').innerHTML = '<span class="spin"></span>';
    return api('jobs', { scope: S.allHistory ? 'all' : 'active' }).then(function (r) {
      if (!r.ok) {
        if (/login|PIN/i.test(r.msg || '')) { toast('Please log in again', true); logout(); return; }
        throw new Error(r.msg);
      }
      S.jobs = r.jobs;
      if (r.today) { S.today = r.today; LS.set('dewa_today', r.today); }
      if (r.team) { S.team = r.team; LS.set('dewa_team', r.team); }
      if (!S.allHistory) LS.set('dewa_jobs', S.jobs);
      LS.set('dewa_jobs_at', Date.now());
      render();
    }).catch(function (e) {
      if (!silent) toast(e.net ? 'Offline — showing jobs saved on this phone' : e.message, !e.net);
    }).then(function () { $('refreshBtn').textContent = '⟳'; });
  }

  // ─── jobs list ────────────────────────────────────────────────────────────
  var FILTERS = [
    ['pending', 'Pending'], ['urgent', 'Urgent'], ['issue', 'Problems'], ['today', 'Done today'], ['done', 'Done'], ['all', 'All']
  ];
  function matchFilter(j, f) {
    var k = kind(j);
    var today = S.today || todayStr();
    if (f === 'pending') return k !== 'done' && k !== 'wait';
    if (f === 'urgent') return k !== 'done' && k !== 'wait' && isUrgent(j);
    if (f === 'issue') return !!j.issue && k !== 'done';
    if (f === 'today') return k === 'wait' || (k === 'done' && j.cdate === today);
    if (f === 'done') return k === 'done' || k === 'wait';
    return true;
  }
  function filtered() {
    var q = S.q.toLowerCase();
    var list = S.jobs.filter(function (j) {
      if (!matchFilter(j, S.filter)) return false;
      if (!q) return true;
      return (j.n + ' ' + j.street + ' ' + j.area + ' ' + j.sr + ' ' + j.eng + ' ' + j.team).toLowerCase().indexOf(q) !== -1;
    });
    var s = S.sort;
    list.sort(function (a, b) {
      if (s === 'sr') return (+a.sr || 0) - (+b.sr || 0);
      if (s === 'new') return dmyKey(b.date) - dmyKey(a.date) || (+b.sr || 0) - (+a.sr || 0);
      if (s === 'smart') {
        var ua = isUrgent(a) && !isDone(a) ? 0 : 1, ub = isUrgent(b) && !isDone(b) ? 0 : 1;
        if (ua !== ub) return ua - ub;
      }
      var da = dist(a), db = dist(b);
      if (da != null && db != null) return da - db;
      if (da != null) return -1;
      if (db != null) return 1;
      return dmyKey(a.date) - dmyKey(b.date) || (+a.sr || 0) - (+b.sr || 0);
    });
    return list;
  }

  function render() {
    renderNet();
    var counts = {};
    FILTERS.forEach(function (f) { counts[f[0]] = 0; });
    S.jobs.forEach(function (j) { FILTERS.forEach(function (f) { if (matchFilter(j, f[0])) counts[f[0]]++; }); });
    $('chips').innerHTML = FILTERS.map(function (f) {
      return '<button class="chip' + (S.filter === f[0] ? ' on' : '') + '" data-f="' + f[0] + '">' + f[1] + ' <span class="n">' + counts[f[0]] + '</span></button>';
    }).join('');
    var list = filtered();
    $('count').textContent = list.length + ' job' + (list.length === 1 ? '' : 's') + (S.allHistory ? ' (full history)' : '');
    var html = list.slice(0, S.shown).map(cardHtml).join('');
    if (!list.length) html = '<div class="empty">' + (S.jobs.length ? 'No jobs match.' : 'No jobs loaded yet. Tap ⟳ when you have signal.') + '</div>';
    if (list.length > S.shown) html += '<button class="btn ghost more" id="moreBtn">Show more (' + (list.length - S.shown) + ')</button>';
    $('list').innerHTML = html;
    var b = $('issBadge');
    if (b) {
      var open = S.jobs.filter(function (j) { return j.issue && !isDone(j); }).length;
      b.textContent = open; b.classList.toggle('hidden', !open);
    }
    if (S.tab === 'map') drawMarkers();
    if (S.tab === 'sum') renderSummary();
  }

  function cardHtml(j) {
    var k = kind(j), d = dist(j);
    var tags = '';
    if (k === 'wait') tags += '<span class="tag w">WAITING TO SEND</span>';
    else if (isDone(j)) tags += '<span class="tag d">DONE</span>';
    else if (/progress|partial/i.test(j.status)) tags += '<span class="tag p">' + esc(j.status.toUpperCase()) + '</span>';
    if (isUrgent(j) && !isDone(j)) tags += '<span class="tag u">URGENT</span>';
    if (j.issue && !isDone(j)) tags += '<span class="tag i">PROBLEM</span>';
    var l3 = [];
    if (clean(j.dim)) l3.push('📏 ' + esc(clean(j.dim)));
    if (j.est) l3.push(esc(j.est) + ' m²');
    l3.push('📅 ' + esc(j.date));
    l3.push('#' + esc(j.sr));
    if (isDone(j) && j.team) l3.push('<span style="color:' + esc(teamColor(j.team)) + '">✔ ' + esc(j.team) + ' · ' + esc(j.cdate) + '</span>');
    return '<div class="card ' + k + '" data-row="' + j.row + '">' +
      '<div class="top"><span class="nn mono">' + esc(j.n) + '</span>' + tags + '<span class="dist">' + fmtKm(d) + '</span></div>' +
      '<div class="l2">' + esc(clean(j.street) || '—') + ' · ' + esc(j.area || 'No area') + '</div>' +
      '<div class="l3">' + l3.join('<span>·</span>') + '</div>' +
      (j.issue && !isDone(j) ? '<div class="l3" style="color:#fdba74">⚠ ' + esc(j.issue.reason) + (j.issue.note ? ' — ' + esc(j.issue.note) : '') + '</div>' : '') +
      '</div>';
  }

  function jobByRow(row) { return S.jobs.filter(function (j) { return String(j.row) === String(row); })[0]; }

  // ─── GPS ──────────────────────────────────────────────────────────────────
  var gpsWatch = null, lastGpsRender = 0;
  function watchGps() {
    if (gpsWatch != null || !navigator.geolocation) return;
    gpsWatch = navigator.geolocation.watchPosition(function (p) {
      S.pos = { lat: p.coords.latitude, lon: p.coords.longitude };
      if (Date.now() - lastGpsRender > 15000) { lastGpsRender = Date.now(); render(); }
      if (meMarker) meMarker.setLatLng([S.pos.lat, S.pos.lon]);
    }, function () {}, { enableHighAccuracy: true, maximumAge: 30000, timeout: 20000 });
  }

  // ─── map ──────────────────────────────────────────────────────────────────
  var map = null, layer = null, meMarker = null, fitted = false;
  var KCOL = { urgent: '#ef4444', pend: '#eab308', issue: '#f97316', done: '#22c55e', wait: '#3b82f6' };
  function showMap() {
    if (!window.L) { $('map').innerHTML = '<div class="empty">Map needs internet the first time.</div>'; return; }
    if (!map) {
      map = L.map('map', { zoomControl: true });
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
      layer = L.layerGroup().addTo(map);
      map.setView([25.2, 55.3], 11);
    }
    setTimeout(function () { map.invalidateSize(); drawMarkers(); }, 50);
  }
  function drawMarkers() {
    if (!map) return;
    layer.clearLayers();
    var pts = [];
    filtered().forEach(function (j) {
      if (!j.lat) return;
      var k = kind(j);
      var m = L.circleMarker([j.lat, j.lon], { radius: k === 'urgent' ? 9 : 7, color: '#fff', weight: 2, fillColor: KCOL[k], fillOpacity: 0.95 });
      m.on('click', function () { openJob(j.row); });
      m.bindTooltip(j.n + (j.street ? ' · ' + j.street : ''));
      m.addTo(layer);
      pts.push([j.lat, j.lon]);
    });
    if (S.pos) {
      if (!meMarker) meMarker = L.circleMarker([S.pos.lat, S.pos.lon], { radius: 8, color: '#0ea5e9', weight: 3, fillColor: '#fff', fillOpacity: 1 });
      meMarker.addTo(map);
    }
    if (!fitted && pts.length) { map.fitBounds(pts, { padding: [30, 30], maxZoom: 15 }); fitted = true; }
  }
  function flyTo(j) {
    setTab('map');
    setTimeout(function () { if (map && j.lat) map.setView([j.lat, j.lon], 17); }, 120);
  }

  // ─── job sheet ────────────────────────────────────────────────────────────
  var sheetEl = null;
  function closeSheet() { if (sheetEl) { sheetEl.remove(); sheetEl = null; } }
  function openSheet(title, html, onReady) {
    closeSheet();
    sheetEl = document.createElement('div');
    sheetEl.className = 'sheet';
    sheetEl.innerHTML = '<div class="box"><div class="head"><h3>' + title + '</h3><button class="iconbtn" data-close="1">✕</button></div>' + html + '</div>';
    sheetEl.addEventListener('click', function (e) { if (e.target === sheetEl || e.target.getAttribute('data-close')) closeSheet(); });
    document.body.appendChild(sheetEl);
    if (onReady) onReady(sheetEl);
  }
  function kv(label, val, wide) {
    return '<div class="kv' + (wide ? ' w' : '') + '"><label>' + label + '</label><div>' + (val === '' || val == null ? '—' : esc(val)) + '</div></div>';
  }

  function openJob(row) {
    var j = jobByRow(row);
    if (!j) return;
    var k = kind(j), admin = S.me.role === 'admin', done = isDone(j);
    var h = '';
    if (k === 'wait') h += '<div class="sec"><div class="note info">⏳ Completed on this phone — waiting for signal to send.</div></div>';
    if (done) h += '<div class="sec"><div class="note ok">✔ Completed by <b>' + esc(j.team || '?') + '</b> on ' + esc(j.cdate) +
      (j.act ? ' · actual ' + esc(j.act) + ' m²' : '') + (j.photo ? ' · <a href="' + esc(j.photo) + '" target="_blank" rel="noopener" style="color:#86efac">photo</a>' : '') + '</div></div>';
    if (j.issue && !done) h += '<div class="sec"><div class="note iss">⚠ <b>' + esc(j.issue.reason) + '</b>' + (j.issue.note ? ' — ' + esc(j.issue.note) : '') +
      '<br><small>Reported by ' + esc(j.issue.by) + ' · ' + esc(j.issue.at) + ' · waiting for office</small></div></div>';
    h += '<div class="sec"><div class="acts">' +
      '<button class="btn ghost" data-act="pdf">📄 PDF</button>' +
      '<button class="btn ghost" data-act="nav"' + (j.lat ? '' : ' disabled') + '>🧭 Navigate</button>' +
      '<button class="btn ghost" data-act="map"' + (j.lat ? '' : ' disabled') + '>⌖ Map</button></div></div>';
    h += '<div class="sec"><div class="grid">' +
      kv('Street', clean(j.street)) + kv('Area / Zone', j.area) +
      kv('Size (L×W)', clean(j.dim)) + kv('Est. area', j.est ? j.est + ' m²' : '') +
      kv('Type', j.type) + kv('Date', j.date) +
      kv('Sr.#', j.sr) + kv('Distance', fmtKm(dist(j))) +
      kv('DEWA engineer', j.eng, true) +
      kv('Remarks', j.notes, true) + kv('Coordinates', j.gis, true) + '</div></div>';

    if (!done && k !== 'wait') {
      h += '<div class="sec"><h4>Mark complete</h4>' +
        '<div class="field"><label>Actual area done (m²)</label><input id="jAct" type="number" inputmode="decimal" step="0.01" min="0" value="' + esc(j.est) + '"></div>' +
        (admin ? '<div class="field"><label>Done by team</label><select id="jTeam">' + S.team.map(function (t) { return '<option>' + esc(t.name) + '</option>'; }).join('') + '</select></div>' : '') +
        '<label class="photo" id="jPhotoLbl" for="jPhoto">📷 Take completion photo (required)</label>' +
        '<input id="jPhoto" type="file" accept="image/*" class="hidden">' +
        '<img id="jPrev" class="prev hidden" alt="">' +
        '<button class="btn full" id="jDone" style="margin-top:10px">✅ Save &amp; mark complete</button></div>';
      h += '<div class="sec"><div class="acts" style="grid-template-columns:1fr 1fr">' +
        '<button class="btn warn" data-act="issue">⚠ Report problem</button>' +
        '<button class="btn ghost" data-act="prog">📷 Progress photo</button></div>' +
        '<input id="jProg" type="file" accept="image/*" class="hidden"></div>';
    }
    if (admin) {
      h += '<div class="sec"><h4>Office edit</h4>' +
        '<div class="grid">' +
        '<div class="field"><label>Status</label><select id="aStatus">' + STATUSES.map(function (s) { return '<option' + (s.toLowerCase() === String(j.status).toLowerCase() ? ' selected' : '') + '>' + s + '</option>'; }).join('') + '</select></div>' +
        '<div class="field"><label>Actual area</label><input id="aAct" type="number" step="0.01" value="' + esc(j.act) + '"></div>' +
        '<div class="field"><label>Team</label><select id="aTeam"><option value=""></option>' + S.team.map(function (t) { return '<option' + (t.name === j.team ? ' selected' : '') + '>' + esc(t.name) + '</option>'; }).join('') +
          (j.team && !S.team.some(function (t) { return t.name === j.team; }) ? '<option selected>' + esc(j.team) + '</option>' : '') + '</select></div>' +
        '<div class="field"><label>Completed date</label><input id="aCdate" placeholder="5 Nov 2026" value="' + esc(j.cdate) + '"></div>' +
        '</div><div class="field"><label>Remarks (column P)</label><textarea id="aNotes">' + esc(j.notes) + '</textarea></div>' +
        '<button class="btn ghost full" id="aSave">💾 Save office changes</button></div>';
    }
    openSheet('<span class="mono">' + esc(j.n) + '</span>', h, function (el) { wireJob(el, j); });
  }

  var photoData = null;
  function wireJob(el, j) {
    photoData = null;
    el.addEventListener('click', function (e) {
      var a = e.target.closest('[data-act]');
      if (!a) return;
      var act = a.getAttribute('data-act');
      if (act === 'pdf') openPdf(j);
      if (act === 'nav') window.open('https://www.google.com/maps/dir/?api=1&destination=' + j.lat + ',' + j.lon, '_blank');
      if (act === 'map') { closeSheet(); flyTo(j); }
      if (act === 'issue') openIssueForm(j);
      if (act === 'prog') $('jProg').click();
    });
    var inp = $('jPhoto');
    if (inp) {
      inp.addEventListener('change', function () {
        var f = inp.files[0];
        if (!f) return;
        $('jPhotoLbl').innerHTML = '<span class="spin"></span> Preparing photo…';
        compress(f).then(function (d) {
          photoData = d;
          $('jPrev').src = d; $('jPrev').classList.remove('hidden');
          $('jPhotoLbl').className = 'photo ok';
          $('jPhotoLbl').textContent = '✔ Photo ready (' + Math.round(d.length * 0.75 / 1024) + ' KB) — tap to change';
        }, function () { $('jPhotoLbl').textContent = '📷 Could not read photo — try again'; });
      });
      $('jDone').addEventListener('click', function () { doComplete(j); });
    }
    var pg = $('jProg');
    if (pg) pg.addEventListener('change', function () {
      var f = pg.files[0];
      if (!f) return;
      compress(f).then(function (d) {
        return submit('progressPhoto', { n: j.n, photo: d, mime: 'image/jpeg' });
      }).then(function (res) {
        if (res.queued) toast('Progress photo saved on phone — will send later');
        else if (res.r.ok) toast('Progress photo uploaded ✓');
        else toast(res.r.msg, true);
      }, function (e) { toast(e.message, true); });
    });
    var as = $('aSave');
    if (as) as.addEventListener('click', function () {
      as.disabled = true;
      var upd = { n: j.n, sr: j.sr, row: j.row, status: $('aStatus').value, act: $('aAct').value, team: $('aTeam').value,
                  cdate: $('aCdate').value.trim(), notes: $('aNotes').value.trim() };
      api('adminUpdate', upd).then(function (r) {
        as.disabled = false;
        if (!r.ok) return toast(r.msg, true);
        j.status = upd.status; j.act = upd.act; j.team = upd.team; j.cdate = upd.cdate; j.notes = upd.notes;
        toast('Saved to sheet ✓'); closeSheet(); render();
      }, function (e) { as.disabled = false; toast(e.net ? 'Needs signal to save office changes' : e.message, true); });
    });
  }

  function doComplete(j) {
    if (!photoData) { toast('Take the completion photo first', true); return; }
    var act = $('jAct').value.trim();
    if (act === '' || isNaN(+act)) { toast('Enter the actual area', true); return; }
    var btn = $('jDone');
    btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Sending…';
    var payload = { n: j.n, sr: j.sr, row: j.row, actual: act, photo: photoData, mime: 'image/jpeg' };
    if ($('jTeam')) payload.team = $('jTeam').value;
    submit('complete', payload).then(function (res) {
      if (res.queued) {
        toast('No signal — saved on phone, will send automatically');
      } else if (res.r.ok) {
        j.status = 'Completed'; j.team = res.r.team; j.cdate = res.r.cdate || S.today; j.photo = res.r.photo; j.act = act; j.issue = null;
        toast(res.r.already ? 'Already completed earlier ✓' : 'Job completed ✓');
      } else {
        btn.disabled = false; btn.textContent = '✅ Save & mark complete';
        toast(res.r.msg || 'Failed', true);
        return;
      }
      photoData = null;
      closeSheet(); render();
    }, function (e) {
      btn.disabled = false; btn.textContent = '✅ Save & mark complete';
      toast(e.message, true);
    });
  }

  function openIssueForm(j) {
    var h = '<div class="sec"><h4>What is the problem?</h4><div class="reasons">' +
      REASONS.map(function (r) { return '<button data-r="' + esc(r) + '">' + esc(r) + '</button>'; }).join('') + '</div>' +
      '<div class="field"><label>Details (optional)</label><textarea id="iNote" placeholder="e.g. White Nissan parked on the location"></textarea></div>' +
      '<label class="photo" id="iPhotoLbl" for="iPhoto">📷 Add photo (optional)</label><input id="iPhoto" type="file" accept="image/*" class="hidden">' +
      '<button class="btn warn full" id="iSend" style="margin-top:10px">Send to office</button></div>';
    openSheet('Problem · <span class="mono">' + esc(j.n) + '</span>', h, function (el) {
      var reason = '', photo = null;
      el.querySelector('.reasons').addEventListener('click', function (e) {
        var b = e.target.closest('[data-r]');
        if (!b) return;
        reason = b.getAttribute('data-r');
        Array.prototype.forEach.call(el.querySelectorAll('.reasons button'), function (x) { x.classList.toggle('on', x === b); });
      });
      $('iPhoto').addEventListener('change', function () {
        var f = $('iPhoto').files[0];
        if (f) compress(f).then(function (d) { photo = d; $('iPhotoLbl').className = 'photo ok'; $('iPhotoLbl').textContent = '✔ Photo added'; });
      });
      $('iSend').addEventListener('click', function () {
        if (!reason) { toast('Choose a reason', true); return; }
        var note = $('iNote').value.trim();
        if (reason === 'Other' && !note) { toast('Write the details for "Other"', true); return; }
        $('iSend').disabled = true;
        submit('reportIssue', { n: j.n, sr: j.sr, reason: reason, note: note, photo: photo, mime: 'image/jpeg' }).then(function (res) {
          if (res.sent && !res.r.ok) { $('iSend').disabled = false; toast(res.r.msg, true); return; }
          j.issue = { reason: reason, note: note, by: S.me.user, at: S.today || todayStr() };
          toast(res.queued ? 'Saved on phone — will send when online' : 'Sent to office ✓');
          closeSheet(); render();
        }, function (e) { $('iSend').disabled = false; toast(e.message, true); });
      });
    });
  }

  function openPdf(j) {
    if (j.pdf) { window.open('https://drive.google.com/file/d/' + j.pdf + '/view', '_blank'); return; }
    var w = window.open('', '_blank');
    api('pdf', { n: j.n }).then(function (r) {
      if (r.ok) {
        j.pdf = r.pdf;
        if (w) w.location.href = 'https://drive.google.com/file/d/' + r.pdf + '/view';
        else window.open('https://drive.google.com/file/d/' + r.pdf + '/view', '_blank');
      } else { if (w) w.close(); toast(r.msg || 'No PDF found', true); }
    }, function (e) { if (w) w.close(); toast(e.net ? 'PDF needs signal' : e.message, true); });
  }

  function compress(file) {
    return new Promise(function (res, rej) {
      var rd = new FileReader();
      rd.onload = function () {
        var img = new Image();
        img.onload = function () {
          var MAX = 1280, w = img.width, h = img.height, sc = Math.min(1, MAX / Math.max(w, h));
          var c = document.createElement('canvas');
          c.width = Math.round(w * sc); c.height = Math.round(h * sc);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          res(c.toDataURL('image/jpeg', 0.72));
        };
        img.onerror = rej;
        img.src = rd.result;
      };
      rd.onerror = rej;
      rd.readAsDataURL(file);
    });
  }

  // ─── summary ──────────────────────────────────────────────────────────────
  var sumDay = '', sumMonth = '';
  function renderSummary() {
    var today = S.today || todayStr();
    sumDay = sumDay || today;
    var months = {};
    S.jobs.forEach(function (j) { if (isDone(j)) { var m = monthOf(j.cdate); if (m) months[m] = (months[m] || 0) + 1; } });
    var mList = Object.keys(months).sort(function (a, b) { return cdateKey('1 ' + b) - cdateKey('1 ' + a); });
    sumMonth = sumMonth && months[sumMonth] ? sumMonth : (mList[0] || '');
    var days = {};
    S.jobs.forEach(function (j) { if (isDone(j) && j.cdate) days[j.cdate] = 1; });
    var dList = Object.keys(days).sort(function (a, b) { return cdateKey(b) - cdateKey(a); });
    if (dList.indexOf(today) === -1) dList.unshift(today);

    var pend = S.jobs.filter(function (j) { return !isDone(j); });
    var h = '<div class="stats">' +
      '<div class="stat"><b style="color:var(--pend)">' + pend.length + '</b><span>Pending</span></div>' +
      '<div class="stat"><b style="color:var(--urg)">' + pend.filter(isUrgent).length + '</b><span>Urgent</span></div>' +
      '<div class="stat"><b style="color:var(--iss)">' + pend.filter(function (j) { return j.issue; }).length + '</b><span>Problems</span></div></div>';

    h += '<div class="field"><label>Day</label><select id="sDay">' + dList.map(function (d) { return '<option' + (d === sumDay ? ' selected' : '') + '>' + esc(d) + '</option>'; }).join('') + '</select></div>';
    var dayJobs = S.jobs.filter(function (j) { return isDone(j) && j.cdate === sumDay; });
    h += teamTable(dayJobs, 'Completed on ' + sumDay);
    h += '<div class="row2"><button class="btn ghost" id="sCopy">Copy</button><button class="btn" id="sWa">Share on WhatsApp</button></div>';

    if (mList.length) {
      h += '<div class="field" style="margin-top:18px"><label>Month (by completed date)</label><select id="sMonth">' + mList.map(function (m) { return '<option' + (m === sumMonth ? ' selected' : '') + '>' + esc(m) + '</option>'; }).join('') + '</select></div>';
      h += teamTable(S.jobs.filter(function (j) { return isDone(j) && monthOf(j.cdate) === sumMonth; }), 'Completed in ' + sumMonth);
    }
    var engR = null;
    if (S.me.role === 'admin') {
      engR = engRange();
      h += engCard(engR);
      h += '<button class="btn ghost full" id="sHist" style="margin-top:14px">' + (S.allHistory ? 'Back to recent jobs only' : 'Load full history (all months)') + '</button>';
    } else {
      h += '<p style="color:var(--mut);font-size:12px;margin-top:12px">Phones keep the last ' + 2 + ' months of completed jobs.</p>';
    }
    $('sumPage').innerHTML = h;
    $('sDay').onchange = function () { sumDay = this.value; renderSummary(); };
    if ($('sMonth')) $('sMonth').onchange = function () { sumMonth = this.value; renderSummary(); };
    var text = summaryText(dayJobs, sumDay);
    $('sCopy').onclick = function () {
      (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { toast('Copied ✓'); }, function () { prompt('Copy this:', text); });
    };
    $('sWa').onclick = function () { window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank'); };
    if ($('sHist')) $('sHist').onclick = function () { S.allHistory = !S.allHistory; loadJobs().then(renderSummary); };
    if (engR) wireEng(engR);
  }

  // ─── admin: engineer summary (by assigned DATE, column C) ─────────────────
  var eng = { mode: 'month', y: 0, m: 0, from: '', to: '' };
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function isoKey(s) { var m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? +m[1] * 10000 + +m[2] * 100 + +m[3] : 0; }
  function keyDmy(k) { return pad2(k % 100) + '.' + pad2(Math.floor(k / 100) % 100) + '.' + Math.floor(k / 10000); }
  function engRange() {
    if (!eng.y) {
      var t = cdateKey(S.today || todayStr()) || (new Date().getFullYear() * 10000 + (new Date().getMonth() + 1) * 100);
      eng.y = Math.floor(t / 10000); eng.m = Math.floor(t / 100) % 100 - 1;
    }
    if (eng.mode === 'custom') {
      var a = isoKey(eng.from), b = isoKey(eng.to);
      if (a && b && a > b) { var x = a; a = b; b = x; }
      return { a: a || 0, b: b || 99999999, label: (a ? keyDmy(a) : 'Start') + ' to ' + (b ? keyDmy(b) : 'Today') };
    }
    var base = eng.y * 10000 + (eng.m + 1) * 100;
    return { a: base + 1, b: base + 31, label: MON[eng.m] + ' ' + eng.y };
  }
  function engGroups(r) {
    var g = {}, order = [];
    S.jobs.forEach(function (j) {
      var k = dmyKey(j.date);
      if (!k || k < r.a || k > r.b) return;
      var name = String(j.eng || '').replace(/\s+/g, ' ').trim();
      var pr = (name.match(/^(\d{3,7})\b/) || [])[1];
      var key = pr || name.toLowerCase() || '-';
      if (!g[key]) { g[key] = { names: {}, n: 0, done: 0, est: 0, act: 0 }; order.push(key); }
      var e = g[key];
      e.names[name || '(no engineer)'] = (e.names[name || '(no engineer)'] || 0) + 1;
      e.n++; e.est += +j.est || 0;
      if (isDone(j)) { e.done++; e.act += +j.act || 0; }
    });
    var rows = order.map(function (k) {
      var e = g[k], best = Object.keys(e.names).sort(function (a, b) { return e.names[b] - e.names[a]; })[0];
      return { name: best, n: e.n, done: e.done, pend: e.n - e.done, est: e.est, act: e.act };
    }).sort(function (a, b) { return b.n - a.n; });
    var tot = rows.reduce(function (t, x) { t.n += x.n; t.done += x.done; t.pend += x.pend; t.est += x.est; t.act += x.act; return t; },
      { name: 'TOTAL', n: 0, done: 0, pend: 0, est: 0, act: 0 });
    return { rows: rows, tot: tot };
  }
  function engNeedsHistory(r) {
    if (S.allHistory) return false;
    var d = new Date(); d.setDate(d.getDate() - 55);
    return r.a < d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  }
  function f1(x) { return (Math.round(x * 10) / 10).toFixed(1); }
  function engCard(r) {
    var h = '<div class="eng"><h3>👷 Engineer Summary</h3><div class="sub">Jobs by DEWA engineer (assigned date)</div>' +
      '<div class="seg"><button data-em="month" class="' + (eng.mode === 'month' ? 'on' : '') + '">Month</button>' +
      '<button data-em="custom" class="' + (eng.mode === 'custom' ? 'on' : '') + '">Custom dates</button></div>';
    if (eng.mode === 'month') {
      h += '<div class="mnav"><button id="eP" aria-label="Previous month">◀</button><b>' + esc(r.label) + '</b><button id="eN" aria-label="Next month">▶</button></div>';
    } else {
      h += '<div class="row2"><div class="field"><label>From</label><input type="date" id="eF" value="' + esc(eng.from) + '"></div>' +
        '<div class="field"><label>To</label><input type="date" id="eT" value="' + esc(eng.to) + '"></div></div>';
    }
    if (engNeedsHistory(r)) return h + '<div class="empty"><span class="spin"></span> Loading older jobs…</div></div>';
    var d = engGroups(r);
    h += '<table class="t"><tr><th>DEWA Engineer</th><th class="r">Total</th><th class="r">Done</th><th class="r">Pend.</th><th class="r">Est. m²</th><th class="r">Act. m²</th></tr>';
    h += d.rows.length ? d.rows.map(function (x) {
      return '<tr><td>' + esc(x.name) + '</td><td class="r"><b>' + x.n + '</b></td><td class="r c-done">' + x.done + '</td><td class="r c-pend">' + x.pend +
        '</td><td class="r c-est">' + f1(x.est) + '</td><td class="r c-act">' + f1(x.act) + '</td></tr>';
    }).join('') : '<tr><td colspan="6" style="color:var(--mut)">No jobs with a date in ' + esc(r.label) + '</td></tr>';
    var t = d.tot;
    h += '<tr class="tot"><td>TOTAL</td><td class="r">' + t.n + '</td><td class="r c-done">' + t.done + '</td><td class="r c-pend">' + t.pend +
      '</td><td class="r c-est">' + f1(t.est) + '</td><td class="r c-act">' + f1(t.act) + '</td></tr></table>';
    h += '<button class="btn full share" id="eShare">📷 Share as Image</button></div>';
    return h;
  }
  function wireEng(r) {
    Array.prototype.forEach.call(document.querySelectorAll('[data-em]'), function (b) {
      b.onclick = function () {
        eng.mode = b.getAttribute('data-em');
        if (eng.mode === 'custom' && !eng.from) {
          var base = eng.y + '-' + pad2(eng.m + 1) + '-';
          eng.from = base + '01'; eng.to = base + pad2(new Date(eng.y, eng.m + 1, 0).getDate());
        }
        renderSummary();
      };
    });
    if ($('eP')) $('eP').onclick = function () { if (--eng.m < 0) { eng.m = 11; eng.y--; } renderSummary(); };
    if ($('eN')) $('eN').onclick = function () { if (++eng.m > 11) { eng.m = 0; eng.y++; } renderSummary(); };
    if ($('eF')) $('eF').onchange = function () { eng.from = this.value; renderSummary(); };
    if ($('eT')) $('eT').onchange = function () { eng.to = this.value; renderSummary(); };
    if ($('eShare')) $('eShare').onclick = function () { shareEngImage(r); };
    if (engNeedsHistory(r)) {
      S.allHistory = true;
      loadJobs().then(function () { if (S.tab === 'sum') renderSummary(); });
    }
  }
  function shareEngImage(r) {
    var d = engGroups(r), rows = d.rows.concat([d.tot]);
    var W = 960, RH = 58, TOP = 150, H = TOP + RH * rows.length + 70;
    var c = document.createElement('canvas'); c.width = W; c.height = H;
    var x = c.getContext('2d'), F = 'system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
    x.fillStyle = '#0b1220'; x.fillRect(0, 0, W, H);
    x.fillStyle = '#e6ecf5'; x.font = 'bold 32px ' + F; x.fillText('DEWA Engineer Summary', 36, 60);
    x.fillStyle = '#8b9ab4'; x.font = '20px ' + F; x.fillText('Jobs by DEWA engineer (assigned date)  ·  ' + r.label, 36, 96);
    var cols = [[36, 'DEWA ENGINEER', 'left', '#93a4ff'], [520, 'TOTAL', 'right', '#ffffff'], [620, 'DONE', 'right', '#22c55e'],
      [730, 'PENDING', 'right', '#ef4444'], [835, 'EST. M²', 'right', '#f59e0b'], [930, 'ACTUAL M²', 'right', '#00c9a7']];
    x.font = 'bold 15px ' + F; x.fillStyle = '#8b9ab4';
    cols.forEach(function (cl) { x.textAlign = cl[2]; x.fillText(cl[1], cl[0], TOP - 14); });
    x.fillStyle = '#24314d'; x.fillRect(24, TOP, W - 48, 1);
    rows.forEach(function (row, i) {
      var y = TOP + RH * (i + 1), tot = i === rows.length - 1;
      if (tot) { x.fillStyle = '#0f2a24'; x.fillRect(24, y - RH, W - 48, RH); x.fillStyle = '#00c9a7'; x.fillRect(24, y - RH, W - 48, 3); }
      else { x.fillStyle = '#24314d'; x.fillRect(24, y, W - 48, 1); }
      var name = row.name; x.font = (tot ? 'bold ' : '600 ') + '20px ' + F;
      while (x.measureText(name).width > 420 && name.length > 4) name = name.slice(0, -2);
      if (name !== row.name) name += '…';
      var vals = [name, String(row.n), String(row.done), String(row.pend), f1(row.est), f1(row.act)];
      vals.forEach(function (v, k) {
        x.textAlign = cols[k][2]; x.fillStyle = tot && k === 0 ? '#ffffff' : cols[k][3];
        x.font = (tot || k === 1 ? 'bold ' : k === 0 ? '600 ' : '') + (k === 0 ? 20 : 22) + 'px ' + F;
        x.fillText(v, cols[k][0], y - RH / 2 + 8);
      });
    });
    x.textAlign = 'left'; x.fillStyle = '#5b6b88'; x.font = '15px ' + F;
    x.fillText('DEWA Field App  ·  ' + (S.today || todayStr()), 36, H - 24);
    c.toBlob(function (blob) {
      var fname = 'DEWA engineer summary ' + r.label.replace(/[^\w.-]+/g, ' ').trim() + '.png';
      var file = typeof File === 'function' ? new File([blob], fname, { type: 'image/png' }) : null;
      if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
        navigator.share({ files: [file], title: 'DEWA Engineer Summary' }).catch(function () {});
      } else {
        var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = fname;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
        toast('Image saved');
      }
    }, 'image/png');
  }
  function groupByTeam(list) {
    var g = {};
    list.forEach(function (j) { var t = j.team || 'Other'; (g[t] = g[t] || { n: 0, est: 0, act: 0 }); g[t].n++; g[t].est += +j.est || 0; g[t].act += +j.act || 0; });
    return g;
  }
  function teamTable(list, title) {
    var g = groupByTeam(list);
    var names = S.team.map(function (t) { return t.name; });
    Object.keys(g).forEach(function (t) { if (names.indexOf(t) === -1) names.push(t); });
    var rows = names.filter(function (t) { return g[t]; }).map(function (t) {
      return '<tr><td><span class="dot" style="background:' + esc(teamColor(t)) + '"></span>' + esc(t) + '</td><td class="r"><b>' + g[t].n + '</b></td><td class="r">' + g[t].act.toFixed(2) + '</td></tr>';
    }).join('');
    var tot = list.reduce(function (s, j) { return s + (+j.act || 0); }, 0);
    return '<table class="t"><tr><th>' + esc(title) + '</th><th class="r">Jobs</th><th class="r">m² done</th></tr>' +
      (rows || '<tr><td colspan="3" style="color:var(--mut)">None</td></tr>') +
      '<tr><td><b>Total</b></td><td class="r"><b>' + list.length + '</b></td><td class="r"><b>' + tot.toFixed(2) + '</b></td></tr></table>';
  }
  function summaryText(list, day) {
    var g = groupByTeam(list);
    var lines = ['DEWA Daily Summary', 'Date: ' + day, 'Total Completed: ' + list.length, ''];
    Object.keys(g).forEach(function (t) { lines.push(t + ': ' + g[t].n + ' jobs'); });
    return lines.join('\n');
  }

  // ─── admin: problems ──────────────────────────────────────────────────────
  function loadIssues() {
    $('issuesPage').innerHTML = '<div class="empty"><span class="spin"></span></div>';
    api('issues').then(function (r) {
      if (!r.ok) throw new Error(r.msg);
      S.issues = r.issues;
      renderIssues();
    }).catch(function (e) { $('issuesPage').innerHTML = '<div class="empty">' + esc(e.net ? 'Needs signal' : e.message) + '</div>'; });
  }
  function renderIssues() {
    var list = S.issues || [];
    if (!list.length) { $('issuesPage').innerHTML = '<div class="empty">No open problems 👍</div>'; return; }
    $('issuesPage').innerHTML = '<p style="color:var(--mut);font-size:13px;margin:0 0 10px">Edit the text if needed, then save it into the Remarks column (P).</p>' +
      list.map(function (it) {
        var txt = it.reason + (it.note ? ' - ' + it.note : '');
        return '<div class="issue" data-id="' + esc(it.id) + '"><div><b class="mono">' + esc(it.n) + '</b> · ' + esc(it.reason) + '</div>' +
          '<div class="meta">by ' + esc(it.by) + ' · ' + esc(it.at) + (it.photo ? ' · <a href="' + esc(it.photo) + '" target="_blank" rel="noopener" style="color:#7dd3fc">photo</a>' : '') + '</div>' +
          (it.note ? '<div style="font-size:13px;margin-bottom:8px">' + esc(it.note) + '</div>' : '') +
          '<div class="field"><textarea>' + esc(txt) + '</textarea></div>' +
          '<div class="row2" style="margin:0"><button class="btn ghost" data-x="open">Open job</button><button class="btn ghost" data-x="dismiss">Dismiss</button><button class="btn" data-x="remark">Save to remarks</button></div></div>';
      }).join('');
  }
  function issueAction(card, x) {
    var id = card.getAttribute('data-id');
    var it = (S.issues || []).filter(function (i) { return i.id === id; })[0];
    if (!it) return;
    if (x === 'open') {
      var j = S.jobs.filter(function (j) { return j.n === it.n; }).pop();
      if (j) openJob(j.row); else toast('Job not in the loaded list', true);
      return;
    }
    var text = card.querySelector('textarea').value.trim();
    Array.prototype.forEach.call(card.querySelectorAll('button'), function (b) { b.disabled = true; });
    api('resolveIssue', { id: id, mode: x, text: text }).then(function (r) {
      if (!r.ok) throw new Error(r.msg);
      S.issues = S.issues.filter(function (i) { return i.id !== id; });
      S.jobs.forEach(function (j) {
        if (j.n === it.n) {
          j.issue = null;
          if (x === 'remark') j.notes = (j.notes ? j.notes.split(' / ').filter(function (p) { return p !== text; }).concat([text]) : [text]).join(' / ');
        }
      });
      toast(x === 'remark' ? 'Saved to remarks ✓' : 'Dismissed');
      renderIssues(); render();
    }).catch(function (e) {
      Array.prototype.forEach.call(card.querySelectorAll('button'), function (b) { b.disabled = false; });
      toast(e.net ? 'Needs signal' : e.message, true);
    });
  }

  // ─── admin: team & PINs ───────────────────────────────────────────────────
  var teamEdit = [];
  function loadTeam() {
    $('teamPage').innerHTML = '<div class="empty"><span class="spin"></span></div>';
    api('getTeam').then(function (r) {
      if (!r.ok) throw new Error(r.msg);
      teamEdit = r.team;
      renderTeam();
    }).catch(function (e) { $('teamPage').innerHTML = '<div class="empty">' + esc(e.net ? 'Needs signal' : e.message) + '</div>'; });
  }
  function renderTeam() {
    $('teamPage').innerHTML = '<p style="color:var(--mut);font-size:13px;margin:0 0 10px">Name · PIN · colour · active. Give each person their PIN privately.</p>' +
      teamEdit.map(function (t, i) {
        return '<div class="teamrow" data-i="' + i + '"><input data-k="name" value="' + esc(t.name) + '" placeholder="Name">' +
          '<input data-k="pin" value="' + esc(t.pin) + '" inputmode="numeric" maxlength="8" placeholder="PIN">' +
          '<input data-k="color" type="color" value="' + esc(t.color || '#64748b') + '">' +
          '<input data-k="active" type="checkbox"' + (t.active !== false ? ' checked' : '') + ' title="Active"></div>';
      }).join('') +
      '<button class="btn ghost full" id="tAdd" style="margin:6px 0 16px">+ Add person</button>' +
      '<div class="field"><label>New admin PIN (leave empty to keep the current one)</label><input id="tAdmin" inputmode="numeric" maxlength="8"></div>' +
      '<button class="btn full" id="tSave">Save team</button>';
    $('tAdd').onclick = function () {
      teamEdit.push({ name: '', pin: String(Math.floor(1000 + Math.random() * 9000)), color: '#64748b', active: true });
      renderTeam();
    };
    $('tSave').onclick = function () {
      var btn = this;
      btn.disabled = true;
      api('saveTeam', { team: teamEdit, adminPin: $('tAdmin').value.trim() }).then(function (r) {
        btn.disabled = false;
        if (!r.ok) return toast(r.msg, true);
        teamEdit = r.team;
        S.team = r.team.filter(function (t) { return t.active; }).map(function (t) { return { name: t.name, color: t.color }; });
        LS.set('dewa_team', S.team);
        if ($('tAdmin').value.trim()) { S.me.pin = $('tAdmin').value.trim(); LS.set('dewa_me', S.me); }
        toast('Team saved ✓'); renderTeam();
      }, function (e) { btn.disabled = false; toast(e.net ? 'Needs signal' : e.message, true); });
    };
  }

  // ─── menu ─────────────────────────────────────────────────────────────────
  function openMenu() {
    var at = LS.get('dewa_jobs_at', 0);
    var h = '<div class="sec"><div class="grid">' + kv('Logged in as', S.me.user) + kv('Role', S.me.role === 'admin' ? 'Office / admin' : 'Supervisor') +
      kv('Jobs on phone', S.jobs.length) + kv('Last update', at ? new Date(at).toLocaleString() : 'never') +
      kv('Waiting to send', S.queue) + kv('App version', VERSION) + '</div></div>' +
      '<div class="sec"><button class="btn ghost full" id="mSync">Send waiting items now</button></div>' +
      '<div class="sec"><button class="btn ghost full" id="mOut" style="color:#fca5a5">Log out</button></div>' +
      '<div class="sec" style="color:var(--mut);font-size:12px">Install: in Chrome tap ⋮ → "Add to Home screen". On iPhone (Safari) tap Share → "Add to Home Screen".</div>';
    openSheet('Menu', h, function () {
      $('mSync').onclick = function () { flush(); toast('Sending…'); };
      $('mOut').onclick = logout;
    });
  }

  // ─── events ───────────────────────────────────────────────────────────────
  function wire() {
    $('nameGrid').addEventListener('click', function (e) {
      var b = e.target.closest('[data-name]');
      if (!b) return;
      selName = b.getAttribute('data-name');
      renderNames();
      $('pin').focus();
    });
    $('loginBtn').addEventListener('click', doLogin);
    $('pin').addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });
    $('nav').addEventListener('click', function (e) { var b = e.target.closest('[data-tab]'); if (b) setTab(b.getAttribute('data-tab')); });
    $('chips').addEventListener('click', function (e) { var b = e.target.closest('[data-f]'); if (b) { S.filter = b.getAttribute('data-f'); S.shown = 60; render(); } });
    $('list').addEventListener('click', function (e) {
      if (e.target.id === 'moreBtn') { S.shown += 60; render(); return; }
      var c = e.target.closest('.card');
      if (c) openJob(c.getAttribute('data-row'));
    });
    var st;
    $('search').addEventListener('input', function () { clearTimeout(st); var v = this.value; st = setTimeout(function () { S.q = v.trim(); S.shown = 60; render(); }, 150); });
    $('sort').addEventListener('change', function () { S.sort = this.value; LS.set('dewa_sort', S.sort); render(); });
    $('refreshBtn').addEventListener('click', function () { flush(); loadJobs(); });
    $('menuBtn').addEventListener('click', openMenu);
    $('netPill').addEventListener('click', function () { flush(); });
    $('locBtn').addEventListener('click', function () {
      if (S.pos && map) map.setView([S.pos.lat, S.pos.lon], 15);
      else toast('Waiting for GPS…');
    });
    $('issuesPage').addEventListener('click', function (e) {
      var b = e.target.closest('[data-x]');
      if (b) issueAction(b.closest('.issue'), b.getAttribute('data-x'));
    });
    $('teamPage').addEventListener('input', function (e) {
      var row = e.target.closest('.teamrow');
      if (!row) return;
      var t = teamEdit[+row.getAttribute('data-i')], k = e.target.getAttribute('data-k');
      t[k] = k === 'active' ? e.target.checked : e.target.value;
    });
    $('teamPage').addEventListener('change', function (e) {
      var row = e.target.closest('.teamrow');
      if (row && e.target.getAttribute('data-k') === 'active') teamEdit[+row.getAttribute('data-i')].active = e.target.checked;
    });
    window.addEventListener('online', function () { renderNet(); flush(); loadJobs(true); });
    window.addEventListener('offline', renderNet);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && S.me && Date.now() - LS.get('dewa_jobs_at', 0) > 120000) { flush(); loadJobs(true); }
    });
    setInterval(function () { if (S.me && S.queue) flush(); }, 60000);
    setInterval(function () { if (S.me && document.visibilityState === 'visible') loadJobs(true); }, 300000);
  }

  // ─── boot ─────────────────────────────────────────────────────────────────
  wire();
  if ('serviceWorker' in navigator && !window.DEWA_MOCK && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }
  if (S.me) start(); else showLogin();
})();
