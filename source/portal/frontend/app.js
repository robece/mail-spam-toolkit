'use strict';

// ─── Config ──────────────────────────────────────────────────────────────────

const API = '';  // same origin

// ─── State ───────────────────────────────────────────────────────────────────

const S = {
  token: localStorage.getItem('mst_token'),
  userId: null,
  userEmail: null,
  screen: 'auth',
  authMode: 'login',   // 'login' | 'register'
  db: null,
  senders: [],
  filteredSenders: [],
  filterSenders: '',
  selectedSender: null,
  emails: [],
  filteredEmails: [],
  filterEmails: '',
  selectedEmailIds: new Set(),
  protonSession: null,   // { uid, access_token, session_id } — never stored in IDB/localStorage
  sessionValid: null,    // true | false | null
  deleteLog: [],
  deleteDone: false,
  deleteInProgress: false,
  previewEmail: null,    // { subject, preview }
  fileHandles: new Map(),  // messageId → FileSystemFileHandle (ephemeral)
  importState: { total: 0, done: 0, running: false, cancelled: false },
};

// ─── JWT utils ────────────────────────────────────────────────────────────────

function parseJwt(token) {
  try {
    return JSON.parse(atob(token.split('.')[1]));
  } catch { return null; }
}

function initFromToken(token) {
  const payload = parseJwt(token);
  if (!payload || !payload.sub) return false;
  S.token = token;
  S.userId = payload.sub;
  return true;
}

// ─── API client ───────────────────────────────────────────────────────────────

async function apiFetch(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (S.token) headers['Authorization'] = `Bearer ${S.token}`;
  const r = await fetch(API + path, { ...opts, headers });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(body.detail || `HTTP ${r.status}`), { status: r.status });
  return body;
}

async function apiRegister(email, password) {
  return apiFetch('/auth/register', { method: 'POST', body: JSON.stringify({ email, password }) });
}

async function apiLogin(email, password) {
  return apiFetch('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
}

async function apiVerifyProtonSession(session) {
  return apiFetch('/proton/verify-session', { method: 'POST', body: JSON.stringify(session) });
}

async function apiDeleteMessages(session, ids) {
  return apiFetch('/proton/delete', {
    method: 'POST',
    body: JSON.stringify({ ...session, ids }),
  });
}

// ─── IndexedDB ────────────────────────────────────────────────────────────────

const IDB_VERSION = 1;

async function openIdb(userId) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(`spam-toolkit-${userId}`, IDB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('senders')) {
        db.createObjectStore('senders', { keyPath: 'email' });
      }
      if (!db.objectStoreNames.contains('emails')) {
        const es = db.createObjectStore('emails', { keyPath: 'messageId' });
        es.createIndex('senderEmail', 'senderEmail', { unique: false });
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = () => reject(req.error);
  });
}

function idbTx(store, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = S.db.transaction(store, mode);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    fn(tx.objectStore(store));
  });
}

async function idbPutMany(store, items) {
  if (!items.length) return;
  return idbTx(store, 'readwrite', os => { for (const item of items) os.put(item); });
}

async function idbGetAll(store) {
  return new Promise((resolve, reject) => {
    const req = S.db.transaction(store, 'readonly').objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGetByIndex(store, idx, value) {
  return new Promise((resolve, reject) => {
    const req = S.db.transaction(store, 'readonly').objectStore(store).index(idx).getAll(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbClear(store) {
  return idbTx(store, 'readwrite', os => os.clear());
}

async function idbPutOne(store, item) {
  return idbTx(store, 'readwrite', os => os.put(item));
}

// ─── EML parser ───────────────────────────────────────────────────────────────

function decodeRfc2047(raw) {
  if (!raw) return '';
  return raw
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, charset, enc, text) => {
      try {
        let bytes;
        if (enc.toUpperCase() === 'B') {
          bytes = Uint8Array.from(atob(text), c => c.charCodeAt(0));
        } else {
          const s = text.replace(/_/g, ' ');
          const arr = [];
          let i = 0;
          while (i < s.length) {
            if (s[i] === '=' && i + 2 < s.length) {
              arr.push(parseInt(s.slice(i + 1, i + 3), 16));
              i += 3;
            } else { arr.push(s.charCodeAt(i)); i++; }
          }
          bytes = new Uint8Array(arr);
        }
        return new TextDecoder(charset).decode(bytes);
      } catch { return text; }
    })
    // Remove whitespace between adjacent encoded words
    .replace(/\?=\s+=\?/g, '');
}

function parseHeaders(text) {
  const h = {};
  let cur = null;
  for (const line of text.split('\n')) {
    if (/^[ \t]/.test(line)) {
      if (cur) h[cur] = (h[cur] || '') + ' ' + line.trim();
    } else {
      const idx = line.indexOf(':');
      if (idx > 0) {
        cur = line.slice(0, idx).toLowerCase().trim();
        h[cur] = line.slice(idx + 1).trim();
      }
    }
  }
  return h;
}

function extractEmail(from) {
  if (!from) return '';
  const angled = from.match(/<([^\s@<>]+@[^\s@<>]+)>/);
  if (angled) return angled[1].toLowerCase();
  const bare = from.match(/([^\s@<>"']+@[^\s@<>"']+)/);
  return bare ? bare[1].toLowerCase() : from.toLowerCase().trim();
}

function extractUnsubscribeUrl(header) {
  if (!header) return null;
  const m = header.match(/<(https?:[^>]+)>/);
  return m ? m[1] : null;
}

function parseIsoDate(raw) {
  if (!raw) return '';
  try {
    const d = new Date(raw);
    return isNaN(d) ? '' : d.toISOString().slice(0, 10);
  } catch { return ''; }
}

function extractPreview(emlText, headers) {
  const sep = emlText.includes('\r\n') ? '\r\n' : '\n';
  const dbl = sep + sep;
  const ct = headers['content-type'] || '';
  const boundary = (ct.match(/boundary=["']?([^"';\s\r\n]+)["']?/i) || [])[1];

  if (boundary) {
    const parts = emlText.split(`--${boundary}`);
    for (const part of parts) {
      const pi = part.indexOf(dbl);
      if (pi < 0) continue;
      const ph = parseHeaders(part.slice(0, pi));
      const pct = ph['content-type'] || '';
      if (pct.startsWith('text/plain')) {
        return part.slice(pi + dbl.length, pi + dbl.length + 800).trim().slice(0, 400);
      }
    }
    return '';
  }

  const bodyStart = emlText.indexOf(dbl);
  if (bodyStart < 0) return '';
  return emlText.slice(bodyStart + dbl.length, bodyStart + dbl.length + 800).trim().slice(0, 400);
}

async function parseEmlFile(handle) {
  const file = await handle.getFile();
  // Read first 6 KB for header parsing
  const headerSlice = await file.slice(0, 6144).text();
  const sep = headerSlice.includes('\r\n') ? '\r\n' : '\n';
  const dbl = sep + sep;
  const hEnd = headerSlice.indexOf(dbl);
  const headerText = hEnd >= 0 ? headerSlice.slice(0, hEnd) : headerSlice;
  const headers = parseHeaders(headerText);

  const from = extractEmail(decodeRfc2047(headers['from'] || ''));
  const subject = (decodeRfc2047(headers['subject'] || '')).trim() || '(no subject)';
  const date = parseIsoDate(headers['date'] || '');
  const messageId = (headers['message-id'] || '').replace(/[<>\s]/g, '') || handle.name;
  const unsubscribeUrl = extractUnsubscribeUrl(headers['list-unsubscribe'] || '');

  // For preview, read full file
  let preview = null;
  try {
    const full = await file.text();
    preview = extractPreview(full, headers);
  } catch { /* skip preview on error */ }

  return { from, subject, date, messageId, unsubscribeUrl, preview, protonId: null };
}

async function parseMetadataJson(handle) {
  const file = await handle.getFile();
  const raw = JSON.parse(await file.text());
  const p = raw.Payload || {};
  return {
    from: (p.Sender?.Address || '').toLowerCase(),
    fromName: p.Sender?.Name || '',
    subject: p.Subject || '(no subject)',
    date: p.Time ? new Date(p.Time * 1000).toISOString().slice(0, 10) : '',
    messageId: p.ExternalID || p.ID || '',
    protonId: p.ID || null,
    unsubscribeUrl: null,
    preview: null,
  };
}

// ─── Directory walking ────────────────────────────────────────────────────────

async function* walkDir(dirHandle) {
  for await (const [, handle] of dirHandle.entries()) {
    if (handle.kind === 'file') {
      yield handle;
    } else if (handle.kind === 'directory') {
      yield* walkDir(handle);
    }
  }
}

async function collectFiles(dirHandle) {
  const eml = {};
  for await (const handle of walkDir(dirHandle)) {
    const name = handle.name;
    if (name.endsWith('.metadata.json')) {
      const base = name.slice(0, -'.metadata.json'.length);
      eml[base] = eml[base] || {};
      eml[base].meta = handle;
    } else if (name.endsWith('.eml')) {
      const base = name.slice(0, -'.eml'.length);
      eml[base] = eml[base] || {};
      eml[base].eml = handle;
    }
  }
  return eml;
}

// ─── Import ───────────────────────────────────────────────────────────────────

async function runImport(dirHandle) {
  S.importState = { total: 0, done: 0, running: true, cancelled: false };
  renderScreen();

  // Phase 1: collect file handles
  updateImportProgress('Scanning directory…', 0, 0);
  const files = await collectFiles(dirHandle);
  const entries = Object.entries(files);
  S.importState.total = entries.length;

  if (!entries.length) {
    S.importState.running = false;
    showNotification('No .eml or .metadata.json files found in the selected folder.', 'error');
    renderScreen();
    return;
  }

  // Phase 2: clear old data and process
  await idbClear('emails');
  await idbClear('senders');
  S.fileHandles.clear();

  const emailBatch = [];
  const sendersMap = {};
  const BATCH = 100;

  for (let i = 0; i < entries.length; i++) {
    if (S.importState.cancelled) break;

    const [, handles] = entries[i];
    try {
      let rec = null;
      if (handles.meta) {
        rec = await parseMetadataJson(handles.meta);
      } else if (handles.eml) {
        rec = await parseEmlFile(handles.eml);
      }

      if (rec && rec.from) {
        const emailRecord = {
          messageId: rec.messageId || `${rec.from}-${i}`,
          protonId: rec.protonId || null,
          senderEmail: rec.from,
          senderName: rec.fromName || '',
          subject: rec.subject,
          date: rec.date,
          unsubscribeUrl: rec.unsubscribeUrl || null,
          preview: rec.preview || null,
          deleted: false,
        };
        emailBatch.push(emailRecord);

        if (handles.eml) S.fileHandles.set(emailRecord.messageId, handles.eml);

        const s = sendersMap[rec.from] || {
          email: rec.from,
          name: rec.fromName || '',
          count: 0,
          unsubscribeUrl: rec.unsubscribeUrl || null,
          lastDate: '',
          firstDate: '',
        };
        s.count++;
        if (!s.lastDate || rec.date > s.lastDate) s.lastDate = rec.date;
        if (!s.firstDate || (rec.date && rec.date < s.firstDate)) s.firstDate = rec.date;
        if (!s.unsubscribeUrl && rec.unsubscribeUrl) s.unsubscribeUrl = rec.unsubscribeUrl;
        sendersMap[rec.from] = s;
      }
    } catch { /* skip unparseable file */ }

    S.importState.done = i + 1;

    if ((i + 1) % BATCH === 0) {
      await idbPutMany('emails', emailBatch.splice(0));
      updateImportProgress('Parsing files…', i + 1, entries.length);
      await sleep(0);
    }
  }

  // Flush remaining
  if (emailBatch.length) await idbPutMany('emails', emailBatch);
  await idbPutMany('senders', Object.values(sendersMap));

  S.importState.running = false;
  S.importState.done = entries.length;

  if (!S.importState.cancelled) {
    showNotification(`Import complete — ${Object.keys(sendersMap).length} senders, ${entries.length} emails`, 'success');
    await navigateTo('senders');
  }
}

function updateImportProgress(msg, done, total) {
  const label = document.getElementById('import-label');
  const fill = document.getElementById('import-fill');
  const pct = document.getElementById('import-pct');
  if (label) label.textContent = msg;
  if (fill && total > 0) {
    fill.style.width = `${Math.round((done / total) * 100)}%`;
    fill.classList.remove('indeterminate');
  }
  if (pct) pct.textContent = total > 0 ? `${done} / ${total}` : '';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Notification toast ───────────────────────────────────────────────────────

function showNotification(msg, type = 'info') {
  const el = document.getElementById('notification');
  if (!el) return;
  el.className = `alert alert-${type}`;
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.hidden = true; }, 4000);
}

// ─── Navigation ───────────────────────────────────────────────────────────────

async function navigateTo(screen, params = {}) {
  S.screen = screen;
  S.selectedEmailIds = new Set();
  S.previewEmail = null;
  S.filterEmails = '';
  S.filterSenders = '';

  if (screen === 'senders') {
    S.senders = await idbGetAll('senders');
    S.senders.sort((a, b) => b.count - a.count);
    S.filteredSenders = [...S.senders];
  }
  if (screen === 'emails' && params.sender) {
    S.selectedSender = params.sender;
    S.emails = await idbGetByIndex('emails', 'senderEmail', params.sender.email);
    S.emails.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    S.filteredEmails = [...S.emails];
  }
  if (screen === 'delete' && params.sender) {
    S.selectedSender = params.sender;
    S.emails = await idbGetByIndex('emails', 'senderEmail', params.sender.email);
    S.emails.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    // Pre-select undeletable emails that have a protonId
    S.selectedEmailIds = new Set(
      S.emails.filter(e => !e.deleted && e.protonId).map(e => e.messageId)
    );
    S.sessionValid = null;
    S.protonSession = null;
    S.deleteLog = [];
    S.deleteDone = false;
    S.deleteInProgress = false;
  }

  renderScreen();
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

function renderScreen() {
  const app = document.getElementById('app');
  if (!app) return;
  app.innerHTML = '';

  if (S.screen === 'auth') {
    app.appendChild(renderAuthScreen());
    return;
  }

  // All other screens need auth
  app.appendChild(renderTopBar());
  const notif = h('div', { id: 'notification', class: 'alert alert-info', hidden: true });
  notif.style.cssText = 'position:fixed;top:60px;right:16px;z-index:200;max-width:420px;';
  app.appendChild(notif);

  const main = document.createElement('div');
  switch (S.screen) {
    case 'home':    main.appendChild(renderHome()); break;
    case 'import':  main.appendChild(renderImportScreen()); break;
    case 'senders': renderSendersScreen(main); break;
    case 'emails':  renderEmailsScreen(main); break;
    case 'delete':  main.appendChild(renderDeleteScreen()); break;
    default:        main.textContent = '404';
  }
  app.appendChild(main);
}

// ── Top bar ───────────────────────────────────────────────────────────────────

function renderTopBar() {
  const nav = h('nav', {});
  const links = [
    { label: 'Home', screen: 'home' },
    { label: 'Senders', screen: 'senders' },
    { label: 'Import', screen: 'import' },
  ];
  for (const { label, screen } of links) {
    const a = h('a', {
      href: '#',
      class: S.screen === screen ? 'active' : '',
      onclick: e => { e.preventDefault(); navigateTo(screen); },
    }, label);
    nav.appendChild(a);
  }

  return h('div', { class: 'top-bar' },
    h('span', { class: 'brand' }, 'mail-spam-toolkit'),
    nav,
    h('div', { class: 'user-area' },
      h('span', {}, S.userEmail || ''),
      h('button', { class: 'btn btn-ghost btn-sm', onclick: logout }, 'Logout'),
    ),
  );
}

// ── Auth screen ───────────────────────────────────────────────────────────────

function renderAuthScreen() {
  const wrap = h('div', { class: 'auth-wrap' },
    h('div', { class: 'auth-brand' }, 'mail-spam-toolkit'),
    h('div', { class: 'auth-tagline' }, 'private · client-side · multi-user'),
  );

  const card = h('div', { class: 'auth-card' });

  const tabs = h('div', { class: 'auth-tabs' });
  const tabLogin = h('button', { class: `auth-tab ${S.authMode === 'login' ? 'active' : ''}`,
    onclick: () => { S.authMode = 'login'; renderScreen(); } }, 'Login');
  const tabReg = h('button', { class: `auth-tab ${S.authMode === 'register' ? 'active' : ''}`,
    onclick: () => { S.authMode = 'register'; renderScreen(); } }, 'Register');
  tabs.append(tabLogin, tabReg);

  const emailField = h('div', { class: 'form-group' },
    h('label', { class: 'form-label' }, 'Email'),
    h('input', { id: 'auth-email', class: 'form-input', type: 'email', autocomplete: 'email', placeholder: 'you@example.com' }),
  );
  const pwField = h('div', { class: 'form-group' },
    h('label', { class: 'form-label' }, 'Password'),
    h('input', { id: 'auth-pw', class: 'form-input', type: 'password',
      autocomplete: S.authMode === 'login' ? 'current-password' : 'new-password',
      placeholder: S.authMode === 'register' ? 'Min. 8 characters' : '' }),
  );
  const errEl = h('div', { id: 'auth-err', class: 'alert alert-error', hidden: true });
  const submitBtn = h('button', {
    class: 'btn btn-primary',
    style: 'width:100%;justify-content:center;',
    onclick: handleAuthSubmit,
  }, S.authMode === 'login' ? 'Login' : 'Create account');

  card.append(tabs, emailField, pwField, errEl, submitBtn);
  wrap.appendChild(card);

  // Allow Enter key to submit
  setTimeout(() => {
    const inputs = card.querySelectorAll('.form-input');
    inputs.forEach(inp => inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') handleAuthSubmit();
    }));
  }, 0);

  return wrap;
}

async function handleAuthSubmit() {
  const email = document.getElementById('auth-email')?.value?.trim() || '';
  const password = document.getElementById('auth-pw')?.value || '';
  const errEl = document.getElementById('auth-err');

  const setErr = msg => { if (errEl) { errEl.textContent = msg; errEl.hidden = !msg; } };
  setErr('');

  if (!email || !password) { setErr('Email and password are required.'); return; }

  const btn = document.querySelector('.auth-card .btn-primary');
  if (btn) { btn.disabled = true; btn.textContent = '…'; }

  try {
    const res = S.authMode === 'login'
      ? await apiLogin(email, password)
      : await apiRegister(email, password);

    localStorage.setItem('mst_token', res.token);
    initFromToken(res.token);
    S.userEmail = res.user.email;
    S.db = await openIdb(S.userId);
    navigateTo('home');
  } catch (err) {
    setErr(err.message);
    if (btn) { btn.disabled = false; btn.textContent = S.authMode === 'login' ? 'Login' : 'Create account'; }
  }
}

// ── Home screen ───────────────────────────────────────────────────────────────

function renderHome() {
  const wrap = h('div', { class: 'main-content' });
  wrap.appendChild(h('div', { class: 'section-title' }, 'Dashboard'));

  // Stats
  const stats = h('div', { class: 'stats-row' });
  idbGetAll('senders').then(senders => {
    const totalEmails = senders.reduce((s, r) => s + r.count, 0);
    stats.innerHTML = '';
    stats.append(
      h('div', { class: 'stat-card' },
        h('div', { class: 'stat-num' }, senders.length.toLocaleString()),
        h('div', { class: 'stat-label' }, 'Senders'),
      ),
      h('div', { class: 'stat-card' },
        h('div', { class: 'stat-num' }, totalEmails.toLocaleString()),
        h('div', { class: 'stat-label' }, 'Emails indexed'),
      ),
    );
  });
  wrap.appendChild(stats);

  const actions = h('div', { class: 'home-actions' });
  actions.append(
    h('button', { class: 'btn btn-primary', onclick: () => navigateTo('senders') }, 'Browse Senders'),
    h('button', { class: 'btn btn-ghost', onclick: () => navigateTo('import') }, 'Import / Refresh'),
  );
  wrap.appendChild(actions);

  return wrap;
}

// ── Import screen ─────────────────────────────────────────────────────────────

function renderImportScreen() {
  const wrap = h('div', { class: 'main-content' });

  if (S.importState.running) {
    const prog = h('div', { class: 'import-wrap' },
      h('div', { class: 'import-title' }, 'Importing…'),
      h('div', { class: 'progress-wrap' },
        h('div', { class: 'progress-label' },
          h('span', { id: 'import-label' }, 'Scanning directory…'),
          h('span', { id: 'import-pct' }, ''),
        ),
        h('div', { class: 'progress-bar-track' },
          h('div', { id: 'import-fill', class: 'progress-bar-fill indeterminate', style: 'width:0%' }),
        ),
      ),
      h('button', { class: 'btn btn-ghost', onclick: () => { S.importState.cancelled = true; } }, 'Cancel'),
    );
    wrap.appendChild(prog);
    return wrap;
  }

  const dropZone = h('div', { class: 'import-drop-zone', id: 'drop-zone' },
    h('div', { class: 'import-drop-icon' }, '📁'),
    h('div', { class: 'import-drop-text' }, h('strong', {}, 'Choose your email export folder')),
    h('div', { class: 'import-drop-text' }, 'Select the folder containing your .eml files'),
    h('button', { class: 'btn btn-primary', onclick: handlePickDirectory }, 'Choose Folder'),
  );

  const fallback = h('p', { style: 'font-size:12px;color:var(--text-dim);max-width:520px;text-align:center;margin-top:4px;' },
    'Supports Protonmail Export and standard .eml files. ' +
    'Your emails are processed locally in the browser — no files are uploaded.'
  );

  // Fallback for browsers without File System Access API
  if (!('showDirectoryPicker' in window)) {
    dropZone.innerHTML = '';
    const fileInput = h('input', {
      type: 'file',
      accept: '.eml,.json',
      multiple: true,
      style: 'display:none',
      id: 'file-fallback',
    });
    fileInput.addEventListener('change', handleFileFallback);
    dropZone.append(
      h('div', { class: 'import-drop-icon' }, '📄'),
      h('div', { class: 'import-drop-text' }, h('strong', {}, 'Select .eml files')),
      h('button', { class: 'btn btn-primary', onclick: () => fileInput.click() }, 'Choose Files'),
      fileInput,
    );
  }

  wrap.appendChild(h('div', { class: 'import-wrap' },
    h('div', { class: 'import-title' }, 'Import Emails'),
    h('div', { class: 'import-sub' },
      'Select your local email export directory. Files are read directly in your browser — nothing is uploaded to the server.',
    ),
    dropZone,
    fallback,
  ));

  return wrap;
}

async function handlePickDirectory() {
  try {
    const dirHandle = await window.showDirectoryPicker({ mode: 'read' });
    await runImport(dirHandle);
  } catch (err) {
    if (err.name !== 'AbortError') showNotification(err.message, 'error');
  }
}

async function handleFileFallback(e) {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;

  S.importState = { total: files.length, done: 0, running: true, cancelled: false };
  renderScreen();

  await idbClear('emails');
  await idbClear('senders');
  S.fileHandles.clear();

  const emailBatch = [];
  const sendersMap = {};
  const metaMap = {};

  // First pass: collect metadata.json
  for (const file of files) {
    if (file.name.endsWith('.metadata.json')) {
      try {
        const raw = JSON.parse(await file.text());
        const p = raw.Payload || {};
        const base = file.name.slice(0, -'.metadata.json'.length);
        metaMap[base] = p;
      } catch { /* skip */ }
    }
  }

  // Second pass: process .eml files
  let i = 0;
  for (const file of files) {
    if (!file.name.endsWith('.eml')) { i++; continue; }
    if (S.importState.cancelled) break;

    const base = file.name.slice(0, -'.eml'.length);
    const meta = metaMap[base];

    try {
      let rec;
      if (meta) {
        rec = {
          from: (meta.Sender?.Address || '').toLowerCase(),
          fromName: meta.Sender?.Name || '',
          subject: meta.Subject || '(no subject)',
          date: meta.Time ? new Date(meta.Time * 1000).toISOString().slice(0, 10) : '',
          messageId: meta.ExternalID || meta.ID || file.name,
          protonId: meta.ID || null,
          unsubscribeUrl: null,
          preview: null,
        };
      } else {
        const text = await file.slice(0, 6144).text();
        const sep = text.includes('\r\n') ? '\r\n' : '\n';
        const dbl = sep + sep;
        const he = text.indexOf(dbl);
        const headers = parseHeaders(he >= 0 ? text.slice(0, he) : text);
        rec = {
          from: extractEmail(decodeRfc2047(headers['from'] || '')),
          fromName: '',
          subject: (decodeRfc2047(headers['subject'] || '')).trim() || '(no subject)',
          date: parseIsoDate(headers['date'] || ''),
          messageId: (headers['message-id'] || '').replace(/[<>\s]/g, '') || file.name,
          protonId: null,
          unsubscribeUrl: extractUnsubscribeUrl(headers['list-unsubscribe'] || ''),
          preview: null,
        };
      }

      if (rec.from) {
        const emailRecord = {
          messageId: rec.messageId,
          protonId: rec.protonId,
          senderEmail: rec.from,
          senderName: rec.fromName || '',
          subject: rec.subject,
          date: rec.date,
          unsubscribeUrl: rec.unsubscribeUrl || null,
          preview: rec.preview,
          deleted: false,
        };
        emailBatch.push(emailRecord);

        const s = sendersMap[rec.from] || { email: rec.from, name: rec.fromName || '', count: 0,
          unsubscribeUrl: rec.unsubscribeUrl || null, lastDate: '', firstDate: '' };
        s.count++;
        if (!s.lastDate || rec.date > s.lastDate) s.lastDate = rec.date;
        if (!s.firstDate || (rec.date && rec.date < s.firstDate)) s.firstDate = rec.date;
        sendersMap[rec.from] = s;
      }
    } catch { /* skip */ }

    S.importState.done = ++i;
    if (i % 100 === 0) {
      await idbPutMany('emails', emailBatch.splice(0));
      updateImportProgress('Parsing files…', i, files.length);
      await sleep(0);
    }
  }

  if (emailBatch.length) await idbPutMany('emails', emailBatch);
  await idbPutMany('senders', Object.values(sendersMap));
  S.importState.running = false;

  if (!S.importState.cancelled) {
    showNotification(`Import complete — ${Object.keys(sendersMap).length} senders`, 'success');
    await navigateTo('senders');
  }
}

// ── Senders screen ────────────────────────────────────────────────────────────

function renderSendersScreen(container) {
  if (!S.senders.length) {
    container.className = 'main-content';
    container.appendChild(h('div', { class: 'empty-state' },
      h('div', { class: 'empty-icon' }, '📬'),
      h('div', { class: 'empty-text' }, 'No emails imported yet.'),
      h('button', { class: 'btn btn-primary', onclick: () => navigateTo('import') }, 'Import Emails'),
    ));
    return;
  }

  container.className = '';

  const toolbar = h('div', { class: 'toolbar' },
    h('input', {
      class: 'form-input filter-input',
      type: 'text',
      placeholder: 'Filter senders…',
      value: S.filterSenders,
      oninput: e => {
        S.filterSenders = e.target.value.toLowerCase();
        applyFilterSenders();
      },
    }),
    h('span', { class: 'toolbar-spacer' }),
    h('span', { class: 'selection-info' }, `${S.filteredSenders.length} senders`),
  );

  const tableWrap = h('div', { class: 'table-wrap list-pane', style: 'height:calc(100vh - 52px - 50px);overflow-y:auto;' });
  const table = h('table', { class: 'data-table' });
  const thead = h('thead', {},
    h('tr', {},
      h('th', { class: 'col-num' }, '#'),
      h('th', { class: 'col-fill' }, 'Sender'),
      h('th', { class: 'col-count' }, 'Emails'),
      h('th', { class: 'col-date' }, 'Last'),
      h('th', { class: 'col-badge' }, 'Unsub'),
    ),
  );
  table.appendChild(thead);

  const tbody = buildSendersBody();
  table.appendChild(tbody);
  tableWrap.appendChild(table);
  container.append(toolbar, tableWrap);
}

function buildSendersBody() {
  const tbody = document.createElement('tbody');
  S.filteredSenders.forEach((s, i) => {
    const tr = h('tr', {
      onclick: () => navigateTo('emails', { sender: s }),
    },
      h('td', { class: 'col-num' }, String(i + 1)),
      h('td', { class: 'col-fill', style: 'overflow:hidden;text-overflow:ellipsis;' }, s.email),
      h('td', { class: 'col-count', style: 'text-align:right;' },
        h('span', { class: 'count-badge' }, String(s.count)),
      ),
      h('td', { class: 'col-date', style: 'color:var(--text-dim);font-size:12px;' }, s.lastDate || '—'),
      h('td', { class: 'col-badge', style: 'text-align:center;' },
        s.unsubscribeUrl
          ? h('a', { class: 'unsub-link', href: s.unsubscribeUrl, target: '_blank',
              onclick: e => e.stopPropagation() }, 'unsub')
          : h('span', { style: 'color:var(--text-muted);font-size:11px;' }, '—'),
      ),
    );
    tbody.appendChild(tr);
  });
  return tbody;
}

function applyFilterSenders() {
  const q = S.filterSenders;
  S.filteredSenders = q ? S.senders.filter(s => s.email.includes(q)) : [...S.senders];
  const tbody = document.querySelector('.data-table tbody');
  if (tbody) tbody.replaceWith(buildSendersBody());
  const info = document.querySelector('.selection-info');
  if (info) info.textContent = `${S.filteredSenders.length} senders`;
}

// ── Emails screen ─────────────────────────────────────────────────────────────

function renderEmailsScreen(container) {
  container.className = '';
  const sender = S.selectedSender;
  if (!sender) return;

  const toolbar = h('div', { class: 'toolbar' },
    h('button', { class: 'btn btn-ghost btn-sm', onclick: () => navigateTo('senders') }, '← Back'),
    h('strong', { style: 'font-size:13px;color:var(--accent);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:300px;' }, sender.email),
    h('input', {
      class: 'form-input filter-input',
      type: 'text',
      placeholder: 'Filter emails…',
      value: S.filterEmails,
      oninput: e => {
        S.filterEmails = e.target.value.toLowerCase();
        applyFilterEmails();
      },
    }),
    h('span', { class: 'toolbar-spacer' }),
    h('button', { class: 'btn btn-ghost btn-sm',
      onclick: () => {
        if (S.selectedEmailIds.size === S.filteredEmails.length) {
          S.selectedEmailIds.clear();
        } else {
          S.filteredEmails.forEach(e => S.selectedEmailIds.add(e.messageId));
        }
        refreshEmailsTable();
        refreshDeleteBtn();
      },
    }, 'Toggle All'),
    h('button', { id: 'delete-btn', class: 'btn btn-danger btn-sm',
      disabled: S.selectedEmailIds.size === 0,
      onclick: () => {
        const toDelete = S.emails.filter(e => S.selectedEmailIds.has(e.messageId));
        if (toDelete.some(e => e.protonId)) {
          navigateTo('delete', { sender });
        } else {
          showNotification('Selected emails have no Protonmail ID. Cannot delete from server.', 'error');
        }
      },
    }, `Delete selected (${S.selectedEmailIds.size})`),
  );

  const layout = h('div', { class: 'split-layout' });
  const listPane = h('div', { class: 'list-pane', id: 'email-list-pane' });
  const table = h('table', { class: 'data-table', id: 'email-table' });
  table.appendChild(h('thead', {},
    h('tr', {},
      h('th', { class: 'col-check' }, ''),
      h('th', { class: 'col-date' }, 'Date'),
      h('th', { class: 'col-fill' }, 'Subject'),
    ),
  ));
  table.appendChild(buildEmailsBody());
  listPane.appendChild(table);

  const previewPane = h('div', { class: 'preview-pane', id: 'preview-pane' },
    h('div', { class: 'preview-empty', id: 'preview-empty' }, 'Select an email to preview'),
  );

  layout.append(toolbar, listPane, previewPane);
  container.appendChild(layout);
}

function buildEmailsBody() {
  const tbody = document.createElement('tbody');
  S.filteredEmails.forEach(email => {
    const checked = S.selectedEmailIds.has(email.messageId);
    const tr = h('tr', { class: checked ? 'selected' : '' },
      h('td', { class: 'col-check',
        onclick: e => {
          e.stopPropagation();
          if (S.selectedEmailIds.has(email.messageId)) S.selectedEmailIds.delete(email.messageId);
          else S.selectedEmailIds.add(email.messageId);
          tr.className = S.selectedEmailIds.has(email.messageId) ? 'selected' : '';
          refreshDeleteBtn();
        },
      },
        h('span', { class: checked ? 'check-on' : 'check-off' }, checked ? '✓' : '○'),
      ),
      h('td', { class: 'col-date', style: 'color:var(--text-dim);font-size:12px;' },
        email.deleted ? h('span', { class: 'deleted-label' }, 'deleted') : (email.date || '—')
      ),
      h('td', { class: 'col-fill', style: 'overflow:hidden;text-overflow:ellipsis;' },
        email.subject,
        email.deleted ? h('span', { class: 'deleted-label', style: 'margin-left:6px;' }, '✗') : null,
      ),
    );
    tr.addEventListener('click', () => showPreview(email));
    tbody.appendChild(tr);
  });
  return tbody;
}

function refreshEmailsTable() {
  const tbody = document.querySelector('#email-table tbody');
  if (tbody) tbody.replaceWith(buildEmailsBody());
}

function refreshDeleteBtn() {
  const btn = document.getElementById('delete-btn');
  if (btn) {
    btn.disabled = S.selectedEmailIds.size === 0;
    btn.textContent = `Delete selected (${S.selectedEmailIds.size})`;
  }
}

function applyFilterEmails() {
  const q = S.filterEmails;
  S.filteredEmails = q
    ? S.emails.filter(e => e.subject.toLowerCase().includes(q) || e.date.includes(q))
    : [...S.emails];
  refreshEmailsTable();
}

async function showPreview(email) {
  const pane = document.getElementById('preview-pane');
  if (!pane) return;

  let preview = email.preview;

  if (!preview) {
    const handle = S.fileHandles.get(email.messageId);
    if (handle) {
      try {
        const file = await handle.getFile();
        const text = await file.text();
        const sep = text.includes('\r\n') ? '\r\n' : '\n';
        const dbl = sep + sep;
        const hEnd = text.indexOf(dbl);
        const headers = hEnd >= 0 ? parseHeaders(text.slice(0, hEnd)) : {};
        preview = extractPreview(text, headers);
        // cache it
        email.preview = preview;
      } catch { /* no preview */ }
    }
  }

  pane.innerHTML = '';
  pane.appendChild(h('div', { class: 'preview-header' }, email.subject));
  pane.appendChild(h('div', { class: 'preview-body' },
    preview || '(no preview — re-import to load previews)',
  ));
}

// ── Delete screen ─────────────────────────────────────────────────────────────

function renderDeleteScreen() {
  const wrap = h('div', { class: 'main-content' });

  wrap.appendChild(h('div', { class: 'back-link', onclick: () => navigateTo('emails', { sender: S.selectedSender }) },
    '← Back to emails',
  ));

  const inner = h('div', { class: 'delete-wrap' });
  inner.appendChild(h('div', { class: 'delete-title' },
    `Delete emails from ${S.selectedSender?.email || 'sender'}`));

  // Session input
  const sessionCard = h('div', { class: 'card' });
  sessionCard.appendChild(h('div', { class: 'card-title' }, 'Protonmail Session'));
  sessionCard.appendChild(h('p', { style: 'font-size:13px;color:var(--text-dim);margin-bottom:12px;line-height:1.6;' },
    'Open Protonmail in your browser. Press F12 → Network → click any request → copy the Cookie header value and paste it below.',
  ));
  const cookieInput = h('textarea', {
    class: 'form-input',
    id: 'cookie-input',
    placeholder: 'AUTH-xxxxxxxx=token; Session-Id=xxx; ...',
    style: 'min-height:70px;font-size:11px;',
  });
  const statusRow = h('div', { class: 'session-status', style: 'margin-top:10px;' },
    h('span', { class: `dot ${S.sessionValid === true ? 'dot-ok' : S.sessionValid === false ? 'dot-err' : 'dot-idle'}`, id: 'sess-dot' }),
    h('span', { id: 'sess-msg', style: 'font-size:13px;' },
      S.sessionValid === true ? 'Session valid' :
      S.sessionValid === false ? 'Session invalid or expired' :
      'No session verified',
    ),
    h('button', { class: 'btn btn-ghost btn-sm', style: 'margin-left:auto;', onclick: handleVerifySession }, 'Verify'),
  );
  sessionCard.append(cookieInput, statusRow);
  inner.appendChild(sessionCard);

  // Email selection
  const selectCard = h('div', { class: 'card' });
  selectCard.appendChild(h('div', { class: 'card-title' }, `Emails to delete (${S.selectedEmailIds.size})`));

  const selectable = S.emails.filter(e => !e.deleted && e.protonId);
  const noProtonId = S.emails.filter(e => !e.deleted && !e.protonId);

  if (selectable.length === 0) {
    selectCard.appendChild(h('div', { class: 'alert alert-info' },
      'No emails with Protonmail IDs found. Import with .metadata.json files to enable server deletion.'));
  } else {
    const list = h('div', { class: 'email-checklist' });
    selectable.forEach(email => {
      const row = h('div', { class: 'email-check-row' });
      const cb = h('input', { type: 'checkbox', checked: S.selectedEmailIds.has(email.messageId) ? 'checked' : '' });
      cb.addEventListener('change', () => {
        if (cb.checked) S.selectedEmailIds.add(email.messageId);
        else S.selectedEmailIds.delete(email.messageId);
        refreshDeleteConfirmBtn();
      });
      row.append(
        cb,
        h('span', { class: 'row-subject' }, email.subject),
        h('span', { class: 'row-date' }, email.date || ''),
      );
      list.appendChild(row);
    });
    selectCard.appendChild(list);
  }

  if (noProtonId.length > 0) {
    selectCard.appendChild(h('p', { style: 'font-size:12px;color:var(--text-dim);margin-top:8px;' },
      `${noProtonId.length} email(s) have no Protonmail ID and will be skipped.`));
  }

  inner.appendChild(selectCard);

  // Delete button
  const confirmBtn = h('button', {
    id: 'confirm-delete-btn',
    class: 'btn btn-danger',
    style: 'align-self:flex-start;',
    disabled: (S.selectedEmailIds.size === 0 || !S.sessionValid || S.deleteInProgress) ? 'disabled' : '',
    onclick: handleConfirmDelete,
  }, `Delete ${S.selectedEmailIds.size} message(s) permanently`);
  inner.appendChild(confirmBtn);

  // Log
  if (S.deleteLog.length > 0) {
    const logBox = h('div', { class: 'log-box', id: 'delete-log' });
    S.deleteLog.forEach(entry => {
      logBox.appendChild(h('div', { class: `log-${entry.type}` }, entry.msg));
    });
    inner.appendChild(logBox);
  }

  if (S.deleteDone) {
    inner.appendChild(h('div', { class: 'alert alert-success' }, 'All selected messages have been deleted from Protonmail.'));
  }

  wrap.appendChild(inner);
  return wrap;
}

function refreshDeleteConfirmBtn() {
  const btn = document.getElementById('confirm-delete-btn');
  if (btn) {
    const disabled = S.selectedEmailIds.size === 0 || !S.sessionValid || S.deleteInProgress;
    btn.disabled = disabled;
    btn.textContent = `Delete ${S.selectedEmailIds.size} message(s) permanently`;
  }
}

async function handleVerifySession() {
  const raw = document.getElementById('cookie-input')?.value || '';
  if (!raw.trim()) { showNotification('Paste a Cookie header value first.', 'error'); return; }

  const session = parseCookieString(raw);
  if (!session) { showNotification('Could not find AUTH-* cookie. Make sure to paste the full Cookie header.', 'error'); return; }

  const dot = document.getElementById('sess-dot');
  const msg = document.getElementById('sess-msg');
  if (msg) msg.textContent = 'Verifying…';
  if (dot) dot.className = 'dot dot-idle';

  try {
    const res = await apiVerifyProtonSession(session);
    S.sessionValid = res.valid;
    S.protonSession = res.valid ? session : null;
    if (dot) dot.className = `dot ${res.valid ? 'dot-ok' : 'dot-err'}`;
    if (msg) msg.textContent = res.valid ? 'Session valid' : 'Session invalid or expired';
    refreshDeleteConfirmBtn();
  } catch (err) {
    S.sessionValid = false;
    if (dot) dot.className = 'dot dot-err';
    if (msg) msg.textContent = err.message;
  }
}

async function handleConfirmDelete() {
  if (!S.protonSession || S.selectedEmailIds.size === 0) return;

  S.deleteInProgress = true;
  S.deleteLog = [];
  S.deleteDone = false;
  refreshDeleteConfirmBtn();

  const ids = S.emails
    .filter(e => S.selectedEmailIds.has(e.messageId) && e.protonId)
    .map(e => e.protonId);

  addLog(`Sending ${ids.length} deletion request(s)…`, 'info');

  try {
    await apiDeleteMessages(S.protonSession, ids);
    addLog(`✓ Deleted ${ids.length} message(s) from Protonmail`, 'ok');

    // Mark as deleted in IDB
    for (const msgId of S.selectedEmailIds) {
      const email = S.emails.find(e => e.messageId === msgId);
      if (email) {
        email.deleted = true;
        await idbPutOne('emails', email);
      }
    }

    // Update sender count
    if (S.selectedSender) {
      S.selectedSender.count = Math.max(0, S.selectedSender.count - ids.length);
      await idbPutOne('senders', S.selectedSender);
    }

    S.deleteLog.push({ type: 'ok', msg: '✓ Local records updated.' });
    S.deleteDone = true;
    S.deleteInProgress = false;
    renderScreen();
  } catch (err) {
    addLog(`✗ Error: ${err.message}`, 'err');
    S.deleteInProgress = false;
    renderScreen();
  }
}

function addLog(msg, type) {
  S.deleteLog.push({ msg, type });
  const logBox = document.getElementById('delete-log');
  if (logBox) {
    logBox.appendChild(h('div', { class: `log-${type}` }, msg));
    logBox.scrollTop = logBox.scrollHeight;
  }
}

// ─── Cookie parser ────────────────────────────────────────────────────────────

function parseCookieString(raw) {
  const cookies = {};
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    cookies[k] = v;
  }
  const authKey = Object.keys(cookies).find(k => k.startsWith('AUTH-'));
  if (!authKey) return null;
  return {
    uid: authKey.replace('AUTH-', ''),
    access_token: cookies[authKey],
    session_id: cookies['Session-Id'] || null,
  };
}

// ─── Auth / logout ────────────────────────────────────────────────────────────

function logout() {
  localStorage.removeItem('mst_token');
  S.token = null;
  S.userId = null;
  S.userEmail = null;
  S.db = null;
  S.screen = 'auth';
  S.authMode = 'login';
  renderScreen();
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  const token = localStorage.getItem('mst_token');
  if (token && initFromToken(token)) {
    try {
      const me = await apiFetch('/auth/me');
      S.userEmail = me.email;
      S.db = await openIdb(S.userId);
      await navigateTo('home');
      return;
    } catch {
      localStorage.removeItem('mst_token');
      S.token = null;
    }
  }
  renderScreen();
}

init();
