'use strict';

// ─── State ───────────────────────────────────────────────────────────────────

const S = {
  // auth
  token:        localStorage.getItem('mst_token'),
  userId:       null,
  userEmail:    null,
  authMode:     'login',

  // screens: 'auth' | 'import' | 'senders' | 'emails'
  screen:       'auth',

  // data
  db:           null,
  senders:      [],
  senderFilter: '',

  // emails screen
  sender:       null,   // selected sender record
  emails:       [],
  emailFilter:  '',
  selected:     new Set(),   // messageIds selected for deletion
  preview:      null,        // { subject, body } currently previewed
  fileHandles:  new Map(),   // messageId → FileSystemFileHandle (session-only)

  // protonmail session — never persisted, lives only in memory
  session:        null,      // { uid, access_token, session_id }
  sessionVerified: false,

  // import
  importing:    false,
  importTotal:  0,
  importDone:   0,
  importCancelled: false,

  // modal: null | 'session' | 'confirm-delete' | 'deleting'
  modal:        null,
  deleteLog:    [],
};

// ─── JWT ─────────────────────────────────────────────────────────────────────

function parseJwt(t) {
  try { return JSON.parse(atob(t.split('.')[1])); } catch { return null; }
}

// ─── API ─────────────────────────────────────────────────────────────────────

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (S.token) headers['Authorization'] = `Bearer ${S.token}`;
  const r = await fetch(path, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(body.detail || `HTTP ${r.status}`), { status: r.status });
  return body;
}

// ─── IndexedDB ────────────────────────────────────────────────────────────────

async function openDb(userId) {
  return new Promise((res, rej) => {
    const req = indexedDB.open(`mst-${userId}`, 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('senders'))
        db.createObjectStore('senders', { keyPath: 'email' });
      if (!db.objectStoreNames.contains('emails')) {
        const s = db.createObjectStore('emails', { keyPath: 'messageId' });
        s.createIndex('senderEmail', 'senderEmail');
      }
    };
    req.onsuccess = e => res(e.target.result);
    req.onerror  = () => rej(req.error);
  });
}

function dbAll(store) {
  return new Promise((res, rej) => {
    const req = S.db.transaction(store, 'readonly').objectStore(store).getAll();
    req.onsuccess = () => res(req.result);
    req.onerror  = () => rej(req.error);
  });
}

function dbByIndex(store, idx, val) {
  return new Promise((res, rej) => {
    const req = S.db.transaction(store, 'readonly').objectStore(store).index(idx).getAll(val);
    req.onsuccess = () => res(req.result);
    req.onerror  = () => rej(req.error);
  });
}

function dbPutMany(store, items) {
  if (!items.length) return Promise.resolve();
  return new Promise((res, rej) => {
    const tx = S.db.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    items.forEach(i => os.put(i));
    tx.oncomplete = res;
    tx.onerror    = () => rej(tx.error);
  });
}

function dbPut(store, item) { return dbPutMany(store, [item]); }

function dbClear(store) {
  return new Promise((res, rej) => {
    const tx = S.db.transaction(store, 'readwrite');
    tx.objectStore(store).clear();
    tx.oncomplete = res;
    tx.onerror    = () => rej(tx.error);
  });
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
            if (s[i] === '=' && i + 2 < s.length) { arr.push(parseInt(s.slice(i+1,i+3),16)); i+=3; }
            else { arr.push(s.charCodeAt(i)); i++; }
          }
          bytes = new Uint8Array(arr);
        }
        return new TextDecoder(charset).decode(bytes);
      } catch { return text; }
    })
    .replace(/\?=\s+=\?/g, '');
}

function parseHeaders(text) {
  const h = {};
  let cur = null;
  for (const line of text.split('\n')) {
    if (/^[ \t]/.test(line)) { if (cur) h[cur] += ' ' + line.trim(); }
    else {
      const i = line.indexOf(':');
      if (i > 0) { cur = line.slice(0,i).toLowerCase().trim(); h[cur] = line.slice(i+1).trim(); }
    }
  }
  return h;
}

function extractEmail(from) {
  if (!from) return '';
  const m = from.match(/<([^\s@<>]+@[^\s@<>]+)>/);
  if (m) return m[1].toLowerCase();
  const b = from.match(/([^\s@<>"']+@[^\s@<>"']+)/);
  return b ? b[1].toLowerCase() : from.toLowerCase().trim();
}

function extractUnsub(hdr) {
  if (!hdr) return null;
  const m = hdr.match(/<(https?:[^>]+)>/);
  return m ? m[1] : null;
}

function isoDate(raw) {
  try { const d = new Date(raw); return isNaN(d) ? '' : d.toISOString().slice(0,10); } catch { return ''; }
}

function extractPreview(emlText, headers) {
  const sep  = emlText.includes('\r\n') ? '\r\n' : '\n';
  const dbl  = sep + sep;
  const ct   = headers['content-type'] || '';
  const bnd  = (ct.match(/boundary=["']?([^"';\s\r\n]+)["']?/i) || [])[1];
  if (bnd) {
    for (const part of emlText.split(`--${bnd}`)) {
      const pi = part.indexOf(dbl);
      if (pi < 0) continue;
      const ph = parseHeaders(part.slice(0, pi));
      if ((ph['content-type'] || '').startsWith('text/plain'))
        return part.slice(pi + dbl.length, pi + dbl.length + 800).trim().slice(0, 500);
    }
    return '';
  }
  const bi = emlText.indexOf(dbl);
  return bi < 0 ? '' : emlText.slice(bi + dbl.length, bi + dbl.length + 800).trim().slice(0, 500);
}

// ─── Import ───────────────────────────────────────────────────────────────────

async function* walkDir(dir) {
  for await (const [, h] of dir.entries()) {
    if (h.kind === 'file') yield h;
    else yield* walkDir(h);
  }
}

async function runImport(dirHandle) {
  S.importing = true; S.importDone = 0; S.importTotal = 0; S.importCancelled = false;
  renderScreen();

  // collect
  const files = {};
  for await (const h of walkDir(dirHandle)) {
    if (h.name.endsWith('.metadata.json')) {
      const b = h.name.slice(0, -'.metadata.json'.length);
      (files[b] = files[b] || {}).meta = h;
    } else if (h.name.endsWith('.eml')) {
      const b = h.name.slice(0, -'.eml'.length);
      (files[b] = files[b] || {}).eml = h;
    }
  }

  const entries = Object.entries(files);
  S.importTotal = entries.length;
  if (!entries.length) {
    S.importing = false;
    toast('No .eml or .metadata.json files found.', 'error');
    renderScreen(); return;
  }

  await dbClear('emails'); await dbClear('senders');
  S.fileHandles.clear();

  const emailBuf = [], sMap = {};
  const BATCH = 100;

  for (let i = 0; i < entries.length; i++) {
    if (S.importCancelled) break;
    const [, h] = entries[i];
    try {
      let rec = null;
      if (h.meta) {
        const p = JSON.parse(await (await h.meta.getFile()).text()).Payload || {};
        rec = {
          messageId: p.ExternalID || p.ID || '',
          protonId:  p.ID || null,
          senderEmail: (p.Sender?.Address || '').toLowerCase(),
          senderName:  p.Sender?.Name || '',
          subject:     p.Subject || '(no subject)',
          date:        p.Time ? new Date(p.Time * 1000).toISOString().slice(0,10) : '',
          unsubUrl:    null, preview: null, deleted: false,
        };
      } else if (h.eml) {
        const txt = await (await h.eml.getFile()).slice(0, 6144).text();
        const sep = txt.includes('\r\n') ? '\r\n' : '\n';
        const dbl = sep + sep;
        const he = txt.indexOf(dbl);
        const hdrs = parseHeaders(he >= 0 ? txt.slice(0, he) : txt);
        rec = {
          messageId:   (hdrs['message-id'] || '').replace(/[<>\s]/g,'') || h.eml.name,
          protonId:    null,
          senderEmail: extractEmail(decodeRfc2047(hdrs['from'] || '')),
          senderName:  '',
          subject:     decodeRfc2047(hdrs['subject'] || '').trim() || '(no subject)',
          date:        isoDate(hdrs['date'] || ''),
          unsubUrl:    extractUnsub(hdrs['list-unsubscribe'] || ''),
          preview:     null, deleted: false,
        };
      }
      if (rec?.senderEmail) {
        emailBuf.push(rec);
        if (h.eml) S.fileHandles.set(rec.messageId, h.eml);
        const s = sMap[rec.senderEmail] || {
          email: rec.senderEmail, name: rec.senderName || '',
          count: 0, unsubUrl: rec.unsubUrl || null, lastDate: '', firstDate: '',
        };
        s.count++;
        if (!s.lastDate  || rec.date > s.lastDate)  s.lastDate  = rec.date;
        if (!s.firstDate || (rec.date && rec.date < s.firstDate)) s.firstDate = rec.date;
        if (!s.unsubUrl && rec.unsubUrl) s.unsubUrl = rec.unsubUrl;
        sMap[rec.senderEmail] = s;
      }
    } catch { /* skip */ }

    S.importDone = i + 1;
    if ((i + 1) % BATCH === 0) {
      await dbPutMany('emails', emailBuf.splice(0));
      updateImportBar(); await sleep(0);
    }
  }

  if (emailBuf.length) await dbPutMany('emails', emailBuf);
  await dbPutMany('senders', Object.values(sMap));
  S.importing = false;

  if (!S.importCancelled) {
    toast(`Import complete — ${Object.keys(sMap).length} senders, ${S.importDone} emails`);
    goto('senders');
  }
}

function updateImportBar() {
  const fill = document.getElementById('imp-fill');
  const lbl  = document.getElementById('imp-lbl');
  if (fill && S.importTotal > 0) {
    fill.style.width = `${Math.round(S.importDone / S.importTotal * 100)}%`;
    fill.classList.remove('indeterminate');
  }
  if (lbl) lbl.textContent = `${S.importDone.toLocaleString()} / ${S.importTotal.toLocaleString()} files`;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Toast ────────────────────────────────────────────────────────────────────

function toast(msg, type = 'success') {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  el.style.opacity = '1';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.opacity = '0'; }, 3500);
}

// ─── Navigation ───────────────────────────────────────────────────────────────

async function goto(screen, params = {}) {
  S.screen = screen;

  if (screen === 'senders') {
    S.senders = await dbAll('senders');
    S.senders.sort((a, b) => b.count - a.count);
    S.senderFilter = '';
  }

  if (screen === 'emails' && params.sender) {
    S.sender   = params.sender;
    S.emails   = await dbAll('emails').then(all => all.filter(e => e.senderEmail === params.sender.email));
    S.emails.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    S.emailFilter = '';
    S.selected    = new Set();
    S.preview     = null;
  }

  renderScreen();
}

// ─── Cookie parser ────────────────────────────────────────────────────────────

function parseCookies(raw) {
  const c = {};
  raw.split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i < 0) return;
    c[p.slice(0,i).trim()] = p.slice(i+1).trim();
  });
  const k = Object.keys(c).find(k => k.startsWith('AUTH-'));
  if (!k) return null;
  return { uid: k.replace('AUTH-',''), access_token: c[k], session_id: c['Session-Id'] || null };
}

// ─── Render helpers ───────────────────────────────────────────────────────────

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'cls') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (typeof v === 'function') e.addEventListener(k, v);
    else e.setAttribute(k, v);
  }
  kids.flat().forEach(k => k != null && e.append(typeof k === 'string' ? document.createTextNode(k) : k));
  return e;
}

function renderScreen() {
  const app = document.getElementById('app');
  if (!app) return;
  app.innerHTML = '';

  if (S.screen === 'auth') { app.appendChild(renderAuth()); return; }

  app.appendChild(renderTopBar());
  const main = document.createElement('div');
  if (S.screen === 'senders') renderSenders(main);
  else if (S.screen === 'emails') renderEmails(main);
  else if (S.screen === 'import') main.appendChild(renderImport());
  app.appendChild(main);

  if (S.modal) app.appendChild(renderModal());
}

// ─── Top bar ─────────────────────────────────────────────────────────────────

function renderTopBar() {
  const sessIndicator = S.sessionVerified
    ? el('span', { cls: 'sess-badge sess-ok' }, '● session active',
        el('button', { cls: 'sess-clear', click: () => { S.session = null; S.sessionVerified = false; renderScreen(); } }, 'clear'))
    : null;

  return el('div', { cls: 'topbar' },
    el('span', { cls: 'brand' }, 'mail-spam-toolkit'),
    el('nav', {},
      navLink('Senders', 'senders'),
      navLink('Import',  'import'),
    ),
    el('div', { cls: 'topbar-right' },
      sessIndicator,
      el('span', { cls: 'topbar-user' }, S.userEmail || ''),
      el('button', { cls: 'btn btn-ghost btn-sm', click: logout }, 'Logout'),
    ),
  );
}

function navLink(label, screen) {
  return el('a', { href: '#', cls: S.screen === screen ? 'active' : '',
    click: e => { e.preventDefault(); goto(screen); } }, label);
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

function renderAuth() {
  const wrap = el('div', { cls: 'auth-wrap' },
    el('div', { cls: 'auth-brand' }, 'mail-spam-toolkit'),
    el('div', { cls: 'auth-sub' }, 'private · client-side · multi-user'),
  );

  const card = el('div', { cls: 'auth-card' });
  const tabs = el('div', { cls: 'auth-tabs' },
    el('button', { cls: `auth-tab ${S.authMode==='login'?'active':''}`,
      click: () => { S.authMode='login'; renderScreen(); } }, 'Login'),
    el('button', { cls: `auth-tab ${S.authMode==='register'?'active':''}`,
      click: () => { S.authMode='register'; renderScreen(); } }, 'Register'),
  );

  const emailIn = el('input', { id:'a-email', cls:'form-input', type:'email', placeholder:'you@example.com', autocomplete:'email' });
  const pwIn    = el('input', { id:'a-pw',    cls:'form-input', type:'password',
    placeholder: S.authMode==='register' ? 'Min. 8 characters' : '',
    autocomplete: S.authMode==='login' ? 'current-password' : 'new-password' });
  const errEl   = el('div', { id:'a-err', cls:'auth-error', style:'display:none' });
  const submitBtn = el('button', { cls:'btn btn-primary auth-submit',
    click: () => handleAuth(emailIn, pwIn, errEl, submitBtn) },
    S.authMode==='login' ? 'Login' : 'Create account');

  [emailIn, pwIn].forEach(i => i.addEventListener('keydown', e => {
    if (e.key === 'Enter') handleAuth(emailIn, pwIn, errEl, submitBtn);
  }));

  card.append(tabs,
    el('div', { cls:'form-group' }, el('label', { cls:'form-label' }, 'Email'), emailIn),
    el('div', { cls:'form-group' }, el('label', { cls:'form-label' }, 'Password'), pwIn),
    errEl, submitBtn,
  );
  wrap.appendChild(card);
  return wrap;
}

async function handleAuth(emailIn, pwIn, errEl, btn) {
  const email = emailIn.value.trim(), pw = pwIn.value;
  errEl.style.display = 'none';
  if (!email || !pw) { errEl.textContent = 'Email and password required.'; errEl.style.display = ''; return; }
  btn.disabled = true; btn.textContent = '…';
  try {
    const res = S.authMode === 'login'
      ? await api('/auth/login',    { method:'POST', body: JSON.stringify({ email, password: pw }) })
      : await api('/auth/register', { method:'POST', body: JSON.stringify({ email, password: pw }) });
    localStorage.setItem('mst_token', res.token);
    S.token = res.token; S.userId = parseJwt(res.token).sub; S.userEmail = res.user.email;
    S.db = await openDb(S.userId);
    goto('senders');
  } catch (err) {
    errEl.textContent = err.message; errEl.style.display = '';
    btn.disabled = false; btn.textContent = S.authMode==='login' ? 'Login' : 'Create account';
  }
}

// ─── Import screen ────────────────────────────────────────────────────────────

function renderImport() {
  const wrap = el('div', { cls: 'import-wrap' });

  if (S.importing) {
    wrap.append(
      el('div', { cls: 'import-title' }, 'Importing…'),
      el('div', { cls: 'progress-wrap' },
        el('div', { cls: 'progress-top' },
          el('span', { id: 'imp-lbl' }, 'Scanning…'),
        ),
        el('div', { cls: 'progress-track' },
          el('div', { id: 'imp-fill', cls: 'progress-fill indeterminate', style: 'width:0%' }),
        ),
      ),
      el('button', { cls: 'btn btn-ghost', click: () => { S.importCancelled = true; } }, 'Cancel'),
    );
    return wrap;
  }

  const dropZone = el('div', { cls: 'drop-zone' },
    el('div', { cls: 'drop-icon' }, '📁'),
    el('p', { cls: 'drop-label' }, 'Select your Protonmail export folder'),
    el('p', { cls: 'drop-sub' }, 'Reads .eml and .metadata.json files directly in your browser — nothing is uploaded.'),
    el('button', { cls: 'btn btn-primary', click: pickDir }, 'Choose Folder'),
  );

  if (!('showDirectoryPicker' in window)) {
    const fi = el('input', { type:'file', multiple:true, accept:'.eml,.json', style:'display:none', id:'file-input' });
    fi.addEventListener('change', handleFileFallback);
    dropZone.innerHTML = '';
    dropZone.append(
      el('div', { cls: 'drop-icon' }, '📄'),
      el('p', { cls: 'drop-label' }, 'Select your .eml files'),
      el('button', { cls: 'btn btn-primary', click: () => fi.click() }, 'Choose Files'),
      fi,
    );
  }

  wrap.append(
    el('div', { cls: 'import-title' }, 'Import Emails'),
    dropZone,
  );
  return el('div', { cls: 'content-pad' }, wrap);
}

async function pickDir() {
  try {
    const h = await window.showDirectoryPicker({ mode: 'read' });
    runImport(h);
  } catch(e) { if (e.name !== 'AbortError') toast(e.message, 'error'); }
}

async function handleFileFallback(e) {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;
  S.importing = true; S.importTotal = files.length; S.importDone = 0; S.importCancelled = false;
  renderScreen();
  await dbClear('emails'); await dbClear('senders'); S.fileHandles.clear();
  const emailBuf = [], sMap = {}, metaMap = {};
  for (const f of files) {
    if (f.name.endsWith('.metadata.json')) {
      try { const p = JSON.parse(await f.text()).Payload||{}; metaMap[f.name.replace('.metadata.json','')] = p; } catch{}
    }
  }
  let i = 0;
  for (const f of files) {
    if (!f.name.endsWith('.eml') || S.importCancelled) { i++; continue; }
    const base = f.name.replace('.eml',''), meta = metaMap[base];
    try {
      let rec;
      if (meta) {
        rec = { messageId: meta.ExternalID||meta.ID||f.name, protonId: meta.ID||null,
          senderEmail:(meta.Sender?.Address||'').toLowerCase(), senderName:meta.Sender?.Name||'',
          subject:meta.Subject||'(no subject)', date:meta.Time?new Date(meta.Time*1000).toISOString().slice(0,10):'',
          unsubUrl:null, preview:null, deleted:false };
      } else {
        const txt = await f.slice(0,6144).text();
        const sep = txt.includes('\r\n')?'\r\n':'\n', dbl=sep+sep, he=txt.indexOf(dbl);
        const hdrs = parseHeaders(he>=0?txt.slice(0,he):txt);
        rec = { messageId:(hdrs['message-id']||'').replace(/[<>\s]/g,'')||f.name, protonId:null,
          senderEmail:extractEmail(decodeRfc2047(hdrs['from']||'')), senderName:'',
          subject:decodeRfc2047(hdrs['subject']||'').trim()||'(no subject)',
          date:isoDate(hdrs['date']||''), unsubUrl:extractUnsub(hdrs['list-unsubscribe']||''),
          preview:null, deleted:false };
      }
      if (rec.senderEmail) {
        emailBuf.push(rec);
        const s = sMap[rec.senderEmail]||{email:rec.senderEmail,name:rec.senderName||'',count:0,unsubUrl:rec.unsubUrl||null,lastDate:'',firstDate:''};
        s.count++; if(!s.lastDate||rec.date>s.lastDate)s.lastDate=rec.date;
        if(!s.firstDate||(rec.date&&rec.date<s.firstDate))s.firstDate=rec.date;
        if(!s.unsubUrl&&rec.unsubUrl)s.unsubUrl=rec.unsubUrl;
        sMap[rec.senderEmail]=s;
      }
    } catch {}
    S.importDone = ++i;
    if (i%100===0) { await dbPutMany('emails',emailBuf.splice(0)); updateImportBar(); await sleep(0); }
  }
  if (emailBuf.length) await dbPutMany('emails',emailBuf);
  await dbPutMany('senders',Object.values(sMap));
  S.importing = false;
  if (!S.importCancelled) { toast(`Import complete — ${Object.keys(sMap).length} senders`); goto('senders'); }
}

// ─── Senders screen ───────────────────────────────────────────────────────────

function renderSenders(container) {
  container.className = 'screen-senders';

  const filtered = S.senders.filter(s =>
    !S.senderFilter || s.email.includes(S.senderFilter)
  );

  // toolbar
  const filterIn = el('input', {
    cls: 'form-input filter-in', type: 'text',
    placeholder: 'Filter senders…', value: S.senderFilter,
    input: e => { S.senderFilter = e.target.value.toLowerCase(); renderSenders(container); },
  });
  const toolbar = el('div', { cls: 'toolbar' },
    filterIn,
    el('span', { cls: 'toolbar-count' }, `${filtered.length.toLocaleString()} senders`),
  );

  if (!filtered.length) {
    const empty = S.senders.length === 0
      ? el('div', { cls: 'empty' },
          el('div', { cls: 'empty-icon' }, '📬'),
          el('p', {}, 'No emails imported yet.'),
          el('button', { cls: 'btn btn-primary', click: () => goto('import') }, 'Import Emails'),
        )
      : el('div', { cls: 'empty' }, el('p', {}, 'No senders match the filter.'));
    container.append(toolbar, empty);
    return;
  }

  // table
  const tbody = el('tbody', {});
  filtered.forEach((s, i) => {
    const tr = el('tr', { click: () => goto('emails', { sender: s }) },
      el('td', { cls: 'col-n' }, String(i + 1)),
      el('td', { cls: 'col-sender' }, s.email),
      el('td', { cls: 'col-count' }, el('span', { cls: 'badge' }, s.count.toLocaleString())),
      el('td', { cls: 'col-date' },  s.lastDate || '—'),
      el('td', { cls: 'col-unsub' },
        s.unsubUrl
          ? el('a', { href: s.unsubUrl, target: '_blank', cls: 'unsub-btn',
              click: e => e.stopPropagation() }, 'Unsub ↗')
          : el('span', { cls: 'no-unsub' }, '—'),
      ),
    );
    tbody.appendChild(tr);
  });

  const table = el('table', { cls: 'data-table' },
    el('thead', {},
      el('tr', {},
        el('th', { cls: 'col-n' }, '#'),
        el('th', { cls: 'col-sender' }, 'Sender'),
        el('th', { cls: 'col-count' }, 'Emails'),
        el('th', { cls: 'col-date' }, 'Last'),
        el('th', { cls: 'col-unsub' }, 'Unsubscribe'),
      ),
    ),
    tbody,
  );

  const tableWrap = el('div', { cls: 'table-scroll' }, table);
  container.append(toolbar, tableWrap);
}

// ─── Emails screen ────────────────────────────────────────────────────────────

function renderEmails(container) {
  container.className = 'screen-emails';
  const s = S.sender;

  const filtered = S.emails.filter(e =>
    !S.emailFilter ||
    e.subject.toLowerCase().includes(S.emailFilter) ||
    e.date.includes(S.emailFilter)
  );

  // ── action bar (sticky at top) ──────────────────────────────────────────
  const allSelectable = filtered.filter(e => !e.deleted && e.protonId);
  const nSelected = [...S.selected].filter(id => allSelectable.some(e => e.messageId === id)).length;

  const selAllBtn = el('button', { cls: 'btn btn-ghost btn-sm', click: () => {
    if (nSelected === allSelectable.length && allSelectable.length > 0) {
      allSelectable.forEach(e => S.selected.delete(e.messageId));
    } else {
      allSelectable.forEach(e => S.selected.add(e.messageId));
    }
    renderEmails(container);
  }}, nSelected === allSelectable.length && allSelectable.length > 0 ? 'Deselect all' : 'Select all');

  const deleteBtn = el('button', {
    cls: `btn btn-danger ${nSelected === 0 ? 'btn-disabled' : ''}`,
    click: () => nSelected > 0 && openDeleteFlow(),
  }, nSelected > 0 ? `🗑 Delete selected (${nSelected})` : '🗑 Delete selected');
  if (nSelected === 0) deleteBtn.setAttribute('disabled', '');

  const filterIn = el('input', {
    cls: 'form-input filter-in', type: 'text',
    placeholder: 'Filter emails…', value: S.emailFilter,
    input: e => { S.emailFilter = e.target.value.toLowerCase(); renderEmails(container); },
  });

  const actionBar = el('div', { cls: 'action-bar' },
    el('button', { cls: 'btn btn-ghost btn-sm back-btn', click: () => goto('senders') }, '← Senders'),
    el('span', { cls: 'sender-label' }, s.email),
    filterIn,
    el('span', { cls: 'toolbar-spacer' }),
    selAllBtn,
    deleteBtn,
  );

  // ── list + preview split ─────────────────────────────────────────────────
  const tbody = el('tbody', {});

  filtered.forEach(email => {
    const isSel = S.selected.has(email.messageId);
    const isActive = S.preview?.messageId === email.messageId;
    const tr = el('tr', { cls: [isSel ? 'sel' : '', isActive ? 'active' : '', email.deleted ? 'deleted-row' : ''].join(' ').trim() });

    const checkCell = el('td', { cls: 'col-check',
      click: e => { e.stopPropagation(); toggleSelect(email.messageId, email.deleted, email.protonId, container); }
    },
      !email.deleted && email.protonId
        ? el('span', { cls: isSel ? 'chk chk-on' : 'chk chk-off' }, isSel ? '✓' : '○')
        : el('span', { cls: 'chk chk-na' }, '·'),
    );

    const dateCell    = el('td', { cls: 'col-date'    }, email.date || '—');
    const subjectCell = el('td', { cls: 'col-subject' },
      email.subject,
      email.deleted ? el('span', { cls: 'del-tag' }, 'deleted') : null,
    );

    tr.append(checkCell, dateCell, subjectCell);
    tr.addEventListener('click', () => showPreview(email, container));
    tbody.appendChild(tr);
  });

  const table = el('table', { cls: 'data-table' },
    el('thead', {},
      el('tr', {},
        el('th', { cls: 'col-check' }, ''),
        el('th', { cls: 'col-date'  }, 'Date'),
        el('th', { cls: 'col-subject' }, 'Subject'),
      ),
    ),
    tbody,
  );

  const listPane    = el('div', { cls: 'list-pane'    }, table);
  const previewPane = el('div', { cls: 'preview-pane', id: 'preview-pane' },
    S.preview
      ? [ el('div', { cls: 'preview-subject' }, S.preview.subject),
          el('div', { cls: 'preview-body' }, S.preview.body || '(no preview — re-import folder to load)') ]
      : el('div', { cls: 'preview-empty' }, 'Click an email to preview'),
  );

  container.append(actionBar, el('div', { cls: 'split' }, listPane, previewPane));
}

function toggleSelect(messageId, deleted, protonId, container) {
  if (deleted || !protonId) return;
  if (S.selected.has(messageId)) S.selected.delete(messageId);
  else S.selected.add(messageId);
  renderEmails(container);
}

async function showPreview(email, container) {
  let body = email.preview;
  if (!body) {
    const h = S.fileHandles.get(email.messageId);
    if (h) {
      try {
        const txt = await (await h.getFile()).text();
        const sep = txt.includes('\r\n') ? '\r\n' : '\n';
        const dbl = sep + sep;
        const he = txt.indexOf(dbl);
        const hdrs = parseHeaders(he >= 0 ? txt.slice(0, he) : txt);
        body = extractPreview(txt, hdrs);
        email.preview = body;
      } catch {}
    }
  }
  S.preview = { messageId: email.messageId, subject: email.subject, body };
  renderEmails(container);
}

// ─── Delete flow (modal) ──────────────────────────────────────────────────────

function openDeleteFlow() {
  if (S.sessionVerified) {
    S.modal = 'confirm-delete';
  } else {
    S.modal = 'session';
  }
  renderScreen();
}

function renderModal() {
  const overlay = el('div', { cls: 'modal-overlay', click: e => { if (e.target === overlay) closeModal(); } });

  if (S.modal === 'session') overlay.appendChild(renderSessionModal());
  else if (S.modal === 'confirm-delete') overlay.appendChild(renderConfirmModal());
  else if (S.modal === 'deleting') overlay.appendChild(renderDeletingModal());

  return overlay;
}

function closeModal() { S.modal = null; renderScreen(); }

function renderSessionModal() {
  const cookieIn = el('textarea', {
    cls: 'form-input cookie-input',
    placeholder: 'AUTH-xxxxxxxx=token; Session-Id=xxx; ...',
  });

  const statusEl = el('div', { cls: 'modal-status', style: 'display:none' });

  const verifyBtn = el('button', { cls: 'btn btn-primary', click: async () => {
    const raw = cookieIn.value.trim();
    if (!raw) { showModalStatus(statusEl, 'Paste your Protonmail Cookie header first.', 'error'); return; }
    const session = parseCookies(raw);
    if (!session) { showModalStatus(statusEl, 'Could not find AUTH-* cookie. Copy the full Cookie header.', 'error'); return; }
    verifyBtn.disabled = true; verifyBtn.textContent = 'Verifying…';
    try {
      const res = await api('/proton/verify-session', { method: 'POST', body: JSON.stringify(session) });
      if (res.valid) {
        S.session = session; S.sessionVerified = true;
        S.modal = 'confirm-delete';
        renderScreen();
      } else {
        showModalStatus(statusEl, 'Session invalid or expired. Refresh Protonmail and copy the Cookie header again.', 'error');
        verifyBtn.disabled = false; verifyBtn.textContent = 'Verify Session';
      }
    } catch(err) {
      showModalStatus(statusEl, err.message, 'error');
      verifyBtn.disabled = false; verifyBtn.textContent = 'Verify Session';
    }
  }}, 'Verify Session');

  return el('div', { cls: 'modal-card' },
    el('div', { cls: 'modal-title' }, 'Protonmail Session Required'),
    el('div', { cls: 'modal-desc' },
      el('p', {}, 'To delete emails from Protonmail you need to provide your session:'),
      el('ol', {},
        el('li', {}, 'Open Protonmail in another browser tab'),
        el('li', {}, 'Press F12 → Network tab'),
        el('li', {}, 'Click any request to mail.proton.me'),
        el('li', {}, 'Find the Cookie request header → copy its value'),
        el('li', {}, 'Paste it below'),
      ),
    ),
    el('div', { cls: 'form-group' },
      el('label', { cls: 'form-label' }, 'Cookie header value'),
      cookieIn,
    ),
    statusEl,
    el('div', { cls: 'modal-actions' },
      el('button', { cls: 'btn btn-ghost', click: closeModal }, 'Cancel'),
      verifyBtn,
    ),
  );
}

function renderConfirmModal() {
  const toDelete = S.emails.filter(e => S.selected.has(e.messageId) && e.protonId && !e.deleted);
  const n = toDelete.length;

  return el('div', { cls: 'modal-card' },
    el('div', { cls: 'modal-title' }, `Delete ${n} email${n !== 1 ? 's' : ''} permanently?`),
    el('div', { cls: 'modal-desc' },
      el('p', {}, `This will permanently delete ${n} message${n!==1?'s':''} from the Protonmail server for `),
      el('strong', {}, S.sender?.email || ''),
      el('p', { cls: 'warn-text' }, 'This action cannot be undone.'),
    ),
    el('div', { cls: 'modal-actions' },
      el('button', { cls: 'btn btn-ghost', click: closeModal }, 'Cancel'),
      el('button', { cls: 'btn btn-danger', click: () => executeDelete(toDelete) },
        `Delete ${n} message${n!==1?'s':''} permanently`),
    ),
  );
}

function renderDeletingModal() {
  const logEl = el('div', { cls: 'delete-log', id: 'del-log' });
  S.deleteLog.forEach(({ msg, cls }) => logEl.appendChild(el('div', { cls }, msg)));

  return el('div', { cls: 'modal-card' },
    el('div', { cls: 'modal-title' }, 'Deleting…'),
    logEl,
  );
}

async function executeDelete(emails) {
  S.modal = 'deleting';
  S.deleteLog = [];
  renderScreen();

  const ids = emails.map(e => e.protonId);
  appendLog(`Sending ${ids.length} deletion request(s)…`, 'log-info');

  try {
    await api('/proton/delete', { method: 'POST', body: JSON.stringify({ ...S.session, ids }) });
    appendLog(`✓ Deleted from Protonmail server`, 'log-ok');

    // update IDB
    for (const email of emails) { email.deleted = true; await dbPut('emails', email); }
    ids.forEach(id => S.selected.delete(emails.find(e => e.protonId === id)?.messageId));
    if (S.sender) { S.sender.count = Math.max(0, S.sender.count - ids.length); await dbPut('senders', S.sender); }

    appendLog('✓ Local records updated.', 'log-ok');
    await sleep(800);
    S.modal = null;
    toast(`✓ ${ids.length} message${ids.length!==1?'s':''} deleted`);
    // re-render emails screen with updated data
    S.emails = S.emails.map(e => emails.find(d => d.messageId === e.messageId) ? {...e, deleted:true} : e);
    renderScreen();
  } catch(err) {
    appendLog(`✗ ${err.message}`, 'log-err');
    const retry = el('div', { cls: 'modal-actions', style: 'margin-top:16px' },
      el('button', { cls: 'btn btn-ghost', click: closeModal }, 'Close'),
    );
    document.querySelector('.modal-card')?.appendChild(retry);
  }
}

function appendLog(msg, cls) {
  S.deleteLog.push({ msg, cls });
  const log = document.getElementById('del-log');
  if (log) { log.appendChild(el('div', { cls }, msg)); log.scrollTop = log.scrollHeight; }
}

function showModalStatus(el, msg, type) {
  el.textContent = msg;
  el.className = `modal-status alert-${type}`;
  el.style.display = '';
}

// ─── Auth / logout ────────────────────────────────────────────────────────────

function logout() {
  localStorage.removeItem('mst_token');
  Object.assign(S, { token:null, userId:null, userEmail:null, db:null, screen:'auth',
    session:null, sessionVerified:false, senders:[], emails:[], selected: new Set() });
  renderScreen();
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  const token = localStorage.getItem('mst_token');
  if (token) {
    const p = parseJwt(token);
    if (p?.sub) {
      try {
        S.token = token; S.userId = p.sub;
        const me = await api('/auth/me');
        S.userEmail = me.email;
        S.db = await openDb(S.userId);
        goto('senders'); return;
      } catch { localStorage.removeItem('mst_token'); S.token = null; }
    }
  }
  renderScreen();
}

init();
