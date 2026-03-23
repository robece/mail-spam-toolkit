'use strict';

let ws;

function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => setStatus('Connected.');
  ws.onmessage = (e) => render(JSON.parse(e.data));
  ws.onclose = () => { setStatus('Reconnecting...'); setTimeout(connect, 1500); };
  ws.onerror = () => ws.close();
}

function send(key) {
  if (ws && ws.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify({ key }));
}

function sendHvResult(token, type) {
  if (ws && ws.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify({ hv_result: { token, type } }));
}

function sendGoto(idx) {
  if (ws && ws.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify({ goto: idx }));
}

function sendTextInput(text) {
  if (ws && ws.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify({ text_input: text }));
}

// ── global keyboard handler ──────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey) return;

  const active = document.activeElement;

  // Auth password / HV code inputs: Enter submits, Escape cancels
  if (active && (active.id === 'auth-password' || active.id === 'hv-code' ||
                 active.id === 'import-uid' || active.id === 'account-name')) {
    if (e.key === 'Enter') {
      e.preventDefault();
      const val = active.value;
      active.value = '';
      sendTextInput(val);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      active.value = '';
      send('Escape');
    }
    return;
  }

  // Filter input: only Escape clears + blurs
  if (active === document.getElementById('filter-input')) {
    if (e.key === 'Escape') {
      e.preventDefault();
      const inp = document.getElementById('filter-input');
      inp.value = '';
      inp.blur();
      if (_sendersData) renderSendersTable(_sendersData);
    }
    return;
  }

  // Deleted emails filter: Escape clears + blurs
  if (active === document.getElementById('deleted-filter')) {
    if (e.key === 'Escape') {
      e.preventDefault();
      const inp = document.getElementById('deleted-filter');
      inp.value = '';
      inp.blur();
      if (_deletedData) renderDeletedEmailsTable(_deletedData);
    }
    return;
  }

  // Emails filter: Escape clears + blurs
  if (active === document.getElementById('emails-filter')) {
    if (e.key === 'Escape') {
      e.preventDefault();
      const inp = document.getElementById('emails-filter');
      inp.value = '';
      inp.blur();
      if (_emailsData) renderEmailsTable(_emailsData);
    }
    return;
  }

  // Deleted senders filter: Escape clears + blurs
  if (active === document.getElementById('deleted-senders-filter')) {
    if (e.key === 'Escape') {
      e.preventDefault();
      const inp = document.getElementById('deleted-senders-filter');
      inp.value = '';
      inp.blur();
      if (_deletedSendersData) renderDeletedSendersTable(_deletedSendersData);
    }
    return;
  }

  if (active && active.classList.contains('url-input')) return;

  const allowed = [
    'ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Enter','Escape',' ',
    'u','U','o','O','a','A','s','S','q','Q','b','B','c','C','d','D','n','N','v','V','x','X','1','2',
  ];
  if (allowed.includes(e.key)) {
    e.preventDefault();
    send(e.key);
  }
});

// Filter input live filtering
document.getElementById('filter-input').addEventListener('input', () => {
  if (_sendersData) renderSendersTable(_sendersData);
});

// ── render dispatcher ────────────────────────────────────────────────────────

function render(msg) {
  ({
    loading:          renderLoading,
    account_setup:    renderAccountSetup,
    accounts:         renderAccounts,
    senders:          renderSenders,
    emails:           renderEmails,
    attachments:      renderAttachments,
    analytics:        renderAnalytics,
    sender_analytics: renderSenderAnalytics,
    server_select:    renderServerSelect,
    auth_prompt:      renderAuthPrompt,
    delete_progress:  renderDeleteProgress,
    deleted_emails:   renderDeletedEmails,
    deleted_senders:  renderDeletedSenders,
    human_verify:     renderHumanVerify,
    import_session:   renderImportSession,
  }[msg.type] || (() => {}))(msg.data);
}

// ── helpers ──────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function kbd(k) { return `<kbd>${k}</kbd>`; }

function setHeader(t) { document.getElementById('header').textContent = t; }
function setStatus(t)  { document.getElementById('status').textContent = t; }
function setFooter(h)  { document.getElementById('footer').innerHTML = h; }
function setContent(h) { document.getElementById('content').innerHTML = h; }

function scrollCursor() {
  requestAnimationFrame(() => {
    const el = document.querySelector('.cursor-row');
    if (el) el.scrollIntoView({ block: 'nearest' });
  });
}

// ── accounts screen ──────────────────────────────────────────────────────────

function renderAccounts(d) {
  hideFilterBar();
  setHeader(`Mail Spam Toolkit  —  Accounts (${d.total})`);
  setStatus('');
  setFooter(
    kbd('↑↓')+' Navigate &nbsp; '+
    kbd('N')+' New account &nbsp; '+
    kbd('D')+' Toggle disable &nbsp; '+
    kbd('B')+' Back'
  );

  let rows = '';
  for (const r of d.rows) {
    const cur      = r.is_cursor ? 'cursor-row' : '';
    const disabled = r.disabled
      ? '<span class="coming-soon">disabled</span>'
      : '<span class="check-on">✓ active</span>';
    rows += `<tr class="${cur}">
      <td class="c-sender">${esc(r.name)}</td>
      <td class="c-unsub" style="width:120px;text-align:left">${esc(r.provider)}</td>
      <td class="c-emails" style="width:120px;text-align:left">${disabled}</td>
    </tr>`;
  }

  setContent(`<table class="data-table">
    <thead><tr>
      <th class="c-sender">Account</th>
      <th style="width:120px">Provider</th>
      <th style="width:120px">Status</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`);
  scrollCursor();
}

// ── account setup screen ─────────────────────────────────────────────────────

function renderAccountSetup(d) {
  hideFilterBar();
  setHeader('Mail Spam Toolkit  —  Account Setup');
  setStatus('');

  const errorHtml = d.error ? `<div class="auth-error">${esc(d.error)}</div>` : '';

  if (d.step === 'provider') {
    setFooter(kbd('1') + ' Select Protonmail');
    setContent(`<div class="action-screen">
      <div class="action-title">Set up your first account</div>
      <div class="action-subtitle">Select mail provider</div>
      <div class="server-list">
        <div class="server-item" onclick="send('1')">
          <span class="server-key">${kbd('1')}</span>
          <span class="server-name">Protonmail</span>
        </div>
        <div class="server-item server-item-disabled">
          <span class="server-key">${kbd('2')}</span>
          <span class="server-name">Gmail</span>
          <span class="coming-soon">Coming soon</span>
        </div>
      </div>
    </div>`);
  } else {
    setFooter(kbd('Enter') + ' Create &nbsp; ' + kbd('Esc') + ' Back');
    setContent(`<div class="action-screen">
      <div class="action-title">New <span class="action-sender">${esc(d.provider)}</span> account</div>
      <div class="action-body">
        Choose a name for this account. A folder with this name will be created inside <code>data/</code>.<br>
        Place your <b>.eml</b> files there and restart the app to load them.<br><br>
        Letters, numbers, and <code>. _ @ + -</code> allowed — no spaces.
      </div>
      ${errorHtml}
      <div class="auth-form">
        <div class="auth-field">
          <label class="auth-label">Account name</label>
          <input id="account-name" type="text" class="auth-input"
                 placeholder="e.g. user@mail.com" maxlength="100"
                 spellcheck="false" autocomplete="off">
        </div>
      </div>
    </div>`);
    requestAnimationFrame(() => {
      const el = document.getElementById('account-name');
      if (el) el.focus();
    });
  }
}

// ── loading screen ───────────────────────────────────────────────────────────

function renderLoading(d) {
  hideFilterBar();
  setHeader('Mail Spam Toolkit');
  setStatus('');
  setFooter('');
  const pct = d.total > 0 ? Math.min(100, Math.round(d.current / d.total * 100)) : 0;
  setContent(`<div class="loading-screen">
    <div class="loading-title">Loading data…</div>
    <div class="loading-msg">${esc(d.message)}</div>
    <div class="loading-bar-wrap">
      <div class="loading-bar-fill" style="width:${pct}%"></div>
    </div>
    <div class="loading-pct">${pct}%</div>
  </div>`);
}

// ── senders screen ───────────────────────────────────────────────────────────

let _sendersData = null;

function clickRow(idx) { sendGoto(idx); }

function renderSendersTable(d) {
  const filter = (document.getElementById('filter-input').value || '').toLowerCase();
  let rows = '';
  for (const r of d.rows) {
    if (filter && !r.sender.toLowerCase().includes(filter)) continue;
    const cur = r.is_cursor ? 'cursor-row' : '';
    const ub  = r.unsubscribed
      ? '<span class="check-on">✓</span>'
      : '<span class="check-off">·</span>';
    const cu  = r.can_unsubscribe
      ? '<span class="can-unsub">(can unsubscribe)</span>' : '';
    rows += `<tr class="${cur}" data-i="${r.index}" onclick="clickRow(${r.index})">
      <td class="c-num">${r.num}</td>
      <td class="c-unsub">${ub}</td>
      <td class="c-sender">${esc(r.sender)}${cu}</td>
      <td class="c-emails">${r.email_count}</td>
    </tr>`;
  }
  const tbody = document.getElementById('senders-tbody');
  if (tbody) {
    tbody.innerHTML = rows;
  } else {
    setContent(`<table class="data-table">
      <thead><tr>
        <th class="c-num">#</th>
        <th class="c-unsub">Unsubscribed</th>
        <th class="c-sender">Sender</th>
        <th class="c-emails">Emails</th>
      </tr></thead>
      <tbody id="senders-tbody">${rows}</tbody>
    </table>`);
  }
  scrollCursor();
}

function renderSenders(d) {
  if (d.open_url) window.open(d.open_url, '_blank', 'noopener');
  _sendersData = d;
  setHeader(`Mail Spam Toolkit  —  ${d.total_emails} emails  |  ${d.total} senders  |  ${d.unsub_count} unsubscribed`);
  setStatus(d.status);
  setFooter(
    kbd('↑↓')+' Navigate &nbsp; '+
    kbd('Enter')+' Emails &nbsp; '+
    kbd('O')+' Open &nbsp; '+
    kbd('S')+' Sender Analytics &nbsp; '+
    kbd('A')+' Analytics &nbsp; '+
    kbd('X')+' Deleted Senders &nbsp; '+
    kbd('C')+' Accounts &nbsp; '+
    kbd('Q')+' Quit'
  );
  document.getElementById('filter-bar').style.display = '';
  renderSendersTable(d);
}

function hideFilterBar() {
  const fb = document.getElementById('filter-bar');
  if (fb) fb.style.display = 'none';
}

// ── emails screen ────────────────────────────────────────────────────────────

let _emailsData = null;

function renderEmailsTable(d) {
  const filter = (document.getElementById('emails-filter')?.value || '').toLowerCase();
  let rows = '';
  for (const r of d.rows) {
    if (filter && !r.subject.toLowerCase().includes(filter)) continue;
    const cur      = r.is_cursor ? 'cursor-row' : '';
    const check    = r.selected
      ? '<span class="check-on">✓</span>'
      : '<span class="check-off">○</span>';
    const attBadge = r.has_attachments
      ? ' <span class="att-badge">(has attachments)</span>' : '';
    rows += `<tr class="${cur}" data-i="${r.index}">
      <td class="c-check">${check}</td>
      <td class="c-subject">${esc(r.subject)}${attBadge}</td>
      <td class="c-date">${esc(r.date)}</td>
    </tr>`;
  }
  const tbody = document.getElementById('emails-tbody');
  if (tbody) {
    tbody.innerHTML = rows;
    scrollCursor();
  }
}

function renderEmails(d) {
  hideFilterBar();
  _emailsData = d;
  setHeader(`${esc(d.sender)}  —  ${d.selected_count}/${d.total} selected`);
  setStatus(d.status);

  const deleteHint = d.selected_count > 0
    ? ' &nbsp; ' + kbd('D') + ' Delete in server'
    : '';

  setFooter(
    kbd('↑↓')+' Navigate &nbsp; '+
    kbd('Space')+' Select/Unselect &nbsp; '+
    kbd('A')+' Select All &nbsp; '+
    kbd('O')+' Attachments &nbsp; '+
    kbd('S')+' Sender Analytics &nbsp; '+
    kbd('B')+' Back' +
    deleteHint
  );

  const preview = d.preview || '(no preview available)';
  const prevFilter = document.getElementById('emails-filter')?.value || '';

  const existingTbody = document.getElementById('emails-tbody');
  if (existingTbody) {
    renderEmailsTable(d);
    const prevEl = document.getElementById('emails-preview');
    if (prevEl) prevEl.textContent = preview;
    return;
  }

  setContent(`<div class="split-layout">
    <div class="emails-pane">
      <div class="filter-bar" style="background:transparent;border:none;padding:6px 12px">
        <input id="emails-filter" type="text" placeholder="Filter by subject…"
               style="max-width:360px" spellcheck="false" autocomplete="off"
               value="${esc(prevFilter)}">
      </div>
      <table class="data-table">
        <thead><tr>
          <th class="c-check"></th>
          <th class="c-subject">Subject</th>
          <th class="c-date">Date</th>
        </tr></thead>
        <tbody id="emails-tbody"></tbody>
      </table>
    </div>
    <div class="preview-pane">
      <div class="preview-label">Preview</div>
      <div class="preview-body" id="emails-preview">${esc(preview)}</div>
    </div>
  </div>`);

  renderEmailsTable(d);

  document.getElementById('emails-filter').addEventListener('input', () => {
    if (_emailsData) renderEmailsTable(_emailsData);
  });
}

// ── attachments screen ────────────────────────────────────────────────────────

function renderAttachments(d) {
  hideFilterBar();
  setHeader(`Attachments  —  ${esc(d.subject)}`);
  setStatus('');
  setFooter(kbd('Esc')+' / '+kbd('B')+' Back to emails');

  if (!d.attachments || d.attachments.length === 0) {
    setContent(`<div class="att-screen"><p class="att-empty">No attachments could be extracted.</p></div>`);
    return;
  }

  const rows = d.attachments.map(a => {
    const size = a.size_bytes >= 1024
      ? `${Math.round(a.size_bytes / 1024)} KB`
      : `${a.size_bytes} B`;
    return `<tr>
      <td class="att-filename">
        <a href="${esc(a.download_url)}" download="${esc(a.filename)}" class="att-dl-link">${esc(a.filename)}</a>
      </td>
      <td class="att-type">${esc(a.content_type)}</td>
      <td class="att-size">${size}</td>
    </tr>`;
  }).join('');

  setContent(`<div class="att-screen">
    <p class="att-hint">Click a filename to download it.</p>
    <table class="data-table att-table">
      <thead><tr>
        <th class="att-filename">Filename</th>
        <th class="att-type">Type</th>
        <th class="att-size">Size</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`);
}

// ── server select screen ─────────────────────────────────────────────────────

function renderImportSession(d) {
  hideFilterBar();
  removeCaptchaListener();
  setHeader('Mail Spam Toolkit  —  Import Protonmail Session');
  setStatus('');
  setFooter(kbd('Enter') + ' Import &nbsp; ' + kbd('B') + ' Cancel');

  const errorHtml = d.error ? `<div class="auth-error">${esc(d.error)}</div>` : '';

  setContent(`<div class="action-screen">
    <div class="action-title">Import session from browser</div>
    <div class="action-body">
      <b>How to get the cookie string:</b><br>
      1. Open <b>mail.proton.me</b> (logged in) → F12 → Network tab<br>
      2. Refresh the page → click any request to <b>mail.proton.me</b><br>
      3. Headers → Request Headers → find <b>Cookie:</b><br>
      4. Copy the full value and paste below
    </div>
    ${errorHtml}
    <div class="auth-form">
      <div class="auth-field">
        <label class="auth-label">Cookie header value</label>
        <input id="import-uid" type="password" class="auth-input"
               placeholder="AUTH-xxx=eyJ...; Session-Id=..." spellcheck="false" autocomplete="off">
      </div>
    </div>
  </div>`);

  requestAnimationFrame(() => {
    const el = document.getElementById('import-uid');
    if (el) el.focus();
  });
}

function renderServerSelect(d) {
  hideFilterBar();
  removeCaptchaListener();
  setHeader(`Mail Spam Toolkit  —  Delete in Server`);
  setStatus('');
  setFooter(kbd('Esc')+' / '+kbd('B')+' Cancel');

  setContent(`<div class="action-screen">
    <div class="action-title">Delete ${d.count} email(s) from <span class="action-sender">${esc(d.sender)}</span></div>
    <div class="action-subtitle">Select mail server</div>
    <div class="server-list">
      <div class="server-item" onclick="send('1')">
        <span class="server-key">${kbd('1')}</span>
        <span class="server-name">Protonmail</span>
      </div>
      <div class="server-item server-item-disabled">
        <span class="server-key">${kbd('2')}</span>
        <span class="server-name">Gmail</span>
        <span class="coming-soon">Coming soon</span>
      </div>
    </div>
  </div>`);
}

// ── auth prompt screen ───────────────────────────────────────────────────────

function renderAuthPrompt(d) {
  hideFilterBar();
  setHeader(`Mail Spam Toolkit  —  Protonmail Authentication`);
  setStatus('');
  setFooter(kbd('Enter')+' Confirm &nbsp; '+kbd('Esc')+' Cancel');

  const errorHtml = d.error
    ? `<div class="auth-error">${esc(d.error)}</div>`
    : '';

  setContent(`<div class="action-screen">
    <div class="action-title">Authenticate to delete ${d.count} email(s)</div>
    ${errorHtml}
    <div class="auth-form">
      <div class="auth-field">
        <label class="auth-label">Account</label>
        <div class="auth-value">${esc(d.username || '(not configured)')}</div>
      </div>
      <div class="auth-field">
        <label class="auth-label">Password</label>
        <input id="auth-password" type="password" class="auth-input"
               placeholder="Protonmail password…"
               autocomplete="current-password" spellcheck="false">
      </div>
      <div class="auth-note">Password is sent only to Protonmail's API and never written to disk.</div>
    </div>
  </div>`);

  requestAnimationFrame(() => {
    const el = document.getElementById('auth-password');
    if (el) el.focus();
  });
}

// ── human verify screen ──────────────────────────────────────────────────────

let _hvMsgListener = null;

function removeCaptchaListener() {
  if (_hvMsgListener) {
    window.removeEventListener('message', _hvMsgListener);
    _hvMsgListener = null;
  }
}

function renderHumanVerify(d) {
  hideFilterBar();
  setHeader('Mail Spam Toolkit  —  Human Verification');
  setStatus('');

  const hasCaptcha = d.methods && d.methods.includes('captcha');
  const hasEmail   = d.methods && d.methods.includes('email');
  const errorHtml  = d.email_error
    ? `<div class="auth-error">${esc(d.email_error)}</div>` : '';

  if (!d.email_sent) {
    // ── State 1: choose / trigger verification method ────────────────────────
    setFooter(kbd('B') + ' Cancel');

    if (hasCaptcha && d.web_url) {
      // Render iframe with proxy src
      removeCaptchaListener();
      const proxySrc = d.web_url.replace('https://verify.proton.me', '/captcha-proxy');

      _hvMsgListener = (ev) => {
        if (ev.origin && ev.origin.includes('proton')) {
          console.log('[HV postMessage]', ev.origin, ev.data);
        }
        const data = ev.data;
        if (!data) return;
        let token = null;
        let type  = 'captcha';
        if (data && typeof data === 'object') {
          if (data.type === 'pm_captcha') {
            token = data.payload;
          } else if (data.type === 'pm_human_verification') {
            token = data.token || data.payload?.token;
            type  = data.tokenType || data.payload?.type || 'captcha';
          } else if (data.token) {
            token = data.token;
          }
        }
        if (token) {
          removeCaptchaListener();
          sendHvResult(token, type);
        }
      };
      window.addEventListener('message', _hvMsgListener);

      setContent(`<div class="action-screen">
        <div class="action-title">Complete the CAPTCHA to continue</div>
        <div class="action-body">
          Solve the challenge below to delete <b>${d.count}</b> email(s) from <b>${esc(d.sender)}</b>.
        </div>
        ${errorHtml}
        <iframe src="${proxySrc}" class="captcha-frame" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe>
      </div>`);
    } else {
      // Fallback: show available method buttons
      let footerParts = [];
      if (hasEmail) footerParts.push(kbd('1') + ' Send email code');
      footerParts.push(kbd('B') + ' Cancel');
      setFooter(footerParts.join(' &nbsp; '));

      let methodsHtml = '';
      if (hasEmail) {
        methodsHtml += `<button class="auth-btn" onclick="send('1')">Send email code</button>`;
      }

      setContent(`<div class="action-screen">
        <div class="action-title">Human Verification Required</div>
        <div class="action-body">
          Protonmail requires identity verification before deleting
          <b>${d.count}</b> email(s) from <b>${esc(d.sender)}</b>.<br><br>
          Available methods: <b>${(d.methods || []).join(', ') || 'none'}</b>
        </div>
        ${errorHtml}
        <div class="auth-form">${methodsHtml}</div>
      </div>`);
    }
  } else {
    // ── State 2: email code sent — let user enter it ─────────────────────────
    removeCaptchaListener();
    setFooter(kbd('Enter') + ' Submit &nbsp; ' + kbd('B') + ' Cancel');

    setContent(`<div class="action-screen">
      <div class="action-title">Enter Verification Code</div>
      <div class="action-body">
        Protonmail sent a 6-digit code to your recovery email.<br>
        Enter it below to delete <b>${d.count}</b> email(s) from <b>${esc(d.sender)}</b>.
      </div>
      ${errorHtml}
      <div class="auth-form">
        <div class="auth-field">
          <label class="auth-label">Verification Code</label>
          <input id="hv-code" type="text" class="auth-input"
                 placeholder="123456" maxlength="6"
                 autocomplete="one-time-code" spellcheck="false">
        </div>
      </div>
    </div>`);

    requestAnimationFrame(() => {
      const el = document.getElementById('hv-code');
      if (el) el.focus();
    });
  }
}

// ── delete progress screen ───────────────────────────────────────────────────

function renderDeleteProgress(d) {
  hideFilterBar();
  setHeader(`Mail Spam Toolkit  —  Deleting from Protonmail`);
  setStatus('');
  setFooter(d.complete ? kbd('B')+' Back' : 'Deleting…');

  const pct = d.total > 0 ? Math.round(d.done / d.total * 100) : 0;

  let msg = '';
  if (d.error) {
    msg = `<div class="del-error">Error: ${esc(d.error)}</div>`;
  } else if (d.complete) {
    const errNote = d.errors > 0 ? ` (${d.errors} could not be found on server)` : '';
    msg = `<div class="del-success">Done — ${d.done} of ${d.total} emails deleted${errNote}.</div>`;
  } else {
    msg = `<div class="del-msg">Deleting ${d.done} / ${d.total}…</div>`;
  }

  setContent(`<div class="loading-screen">
    ${msg}
    <div class="loading-bar-wrap" style="max-width:480px;width:100%">
      <div class="loading-bar-fill" style="width:${pct}%"></div>
    </div>
    <div class="loading-pct">${pct}%</div>
  </div>`);
}

// ── deleted senders screen ───────────────────────────────────────────────────

let _deletedSendersData = null;

function renderDeletedSendersTable(d) {
  const filter = (document.getElementById('deleted-senders-filter')?.value || '').toLowerCase();
  let rows = '';
  for (const r of d.rows) {
    if (filter && !r.email.toLowerCase().includes(filter)) continue;
    const cur   = r.is_cursor ? 'cursor-row' : '';
    const unsub = r.unsubscribed
      ? '<span class="check-on">✓</span>'
      : '<span class="check-off">·</span>';
    const cu = r.can_unsub
      ? '<span class="can-unsub">(can unsubscribe)</span>' : '';
    rows += `<tr class="${cur}" onclick="sendGoto(${r.index})">
      <td class="c-unsub">${unsub}</td>
      <td class="c-sender">${esc(r.email)}${cu}</td>
      <td class="c-emails">${r.deleted_count}</td>
    </tr>`;
  }
  const tbody = document.getElementById('deleted-senders-tbody');
  if (tbody) {
    tbody.innerHTML = rows;
    scrollCursor();
  }
}

function renderDeletedSenders(d) {
  hideFilterBar();
  _deletedSendersData = d;
  setHeader(`Mail Spam Toolkit  —  Deleted Senders (${d.total})`);
  setStatus('');
  setFooter(kbd('↑↓')+' Navigate &nbsp; '+kbd('Enter')+' View deleted emails &nbsp; '+kbd('U')+' Toggle unsubscribed &nbsp; '+kbd('B')+' Back');

  if (d.total === 0) {
    setContent(`<div class="att-screen"><p class="att-empty">No senders with deleted emails yet.</p></div>`);
    return;
  }

  const prevFilter = document.getElementById('deleted-senders-filter')?.value || '';

  const existingTbody = document.getElementById('deleted-senders-tbody');
  if (existingTbody) {
    renderDeletedSendersTable(d);
    return;
  }

  setContent(`<div>
    <div class="filter-bar" style="background:transparent;border:none;padding:6px 12px">
      <input id="deleted-senders-filter" type="text" placeholder="Filter by sender…"
             style="max-width:360px" spellcheck="false" autocomplete="off"
             value="${esc(prevFilter)}">
    </div>
    <table class="data-table">
      <thead><tr>
        <th class="c-unsub">Unsub</th>
        <th class="c-sender">Sender</th>
        <th class="c-emails">Deleted</th>
      </tr></thead>
      <tbody id="deleted-senders-tbody"></tbody>
    </table>
  </div>`);

  renderDeletedSendersTable(d);

  document.getElementById('deleted-senders-filter').addEventListener('input', () => {
    if (_deletedSendersData) renderDeletedSendersTable(_deletedSendersData);
  });
}

// ── deleted emails screen ────────────────────────────────────────────────────

let _deletedData = null;

function renderDeletedEmailsTable(d) {
  const filter = (document.getElementById('deleted-filter')?.value || '').toLowerCase();
  let rows = '';
  for (const r of d.rows) {
    if (filter && !r.subject.toLowerCase().includes(filter)) continue;
    const cur    = r.is_cursor ? 'cursor-row' : '';
    const backup = r.has_backup
      ? '<span class="del-backup-badge">⊙ backup</span>'
      : '';
    rows += `<tr class="${cur} del-row">
      <td class="c-subject del-subject">${esc(r.subject)}${backup}</td>
      <td class="c-date">${esc(r.date_str)}</td>
      <td class="del-date-col">${esc(r.deleted_at)}</td>
    </tr>`;
  }
  const tbody = document.getElementById('deleted-tbody');
  if (tbody) {
    tbody.innerHTML = rows;
    scrollCursor();
  }
}

function renderDeletedEmails(d) {
  hideFilterBar();
  _deletedData = d;
  setHeader(`${esc(d.sender)}  —  Deleted Emails (${d.total})`);
  setStatus('');
  setFooter(kbd('↑↓') + ' Navigate &nbsp; ' + kbd('B') + ' Back');

  if (d.total === 0) {
    setContent(`<div class="att-screen"><p class="att-empty">No deleted emails for this sender.</p></div>`);
    return;
  }

  const preview = d.preview || '(no preview available)';
  const prevFilter = document.getElementById('deleted-filter')?.value || '';

  // If the skeleton already exists, just update dynamic parts
  const existingTbody = document.getElementById('deleted-tbody');
  if (existingTbody) {
    renderDeletedEmailsTable(d);
    const prevEl = document.getElementById('deleted-preview');
    if (prevEl) prevEl.textContent = preview;
    return;
  }

  setContent(`<div class="split-layout">
    <div class="emails-pane">
      <div class="filter-bar" style="background:transparent;border:none;padding:6px 12px">
        <input id="deleted-filter" type="text" placeholder="Filter by subject…"
               style="max-width:360px" spellcheck="false" autocomplete="off"
               value="${esc(prevFilter)}">
      </div>
      <table class="data-table">
        <thead><tr>
          <th class="c-subject">Subject</th>
          <th class="c-date">Original Date</th>
          <th class="del-date-col">Deleted On</th>
        </tr></thead>
        <tbody id="deleted-tbody"></tbody>
      </table>
    </div>
    <div class="preview-pane">
      <div class="preview-label">Preview</div>
      <div class="preview-body" id="deleted-preview">${esc(preview)}</div>
    </div>
  </div>`);

  renderDeletedEmailsTable(d);

  document.getElementById('deleted-filter').addEventListener('input', () => {
    if (_deletedData) renderDeletedEmailsTable(_deletedData);
  });
}

// ── sender analytics screen ──────────────────────────────────────────────────

function renderSenderAnalytics(d) {
  hideFilterBar();
  setHeader(`${esc(d.sender)}  —  Sender Analytics`);
  setStatus('');
  setFooter(kbd('←→')+' Year &nbsp; '+kbd('B')+' / '+kbd('Esc')+' Back');

  if (!d.years || d.years.length === 0) {
    setContent(`<div class="sa-screen"><p class="sa-empty">No dated emails found for this sender.</p></div>`);
    return;
  }

  const prev = d.has_prev
    ? `<span class="sa-arrow sa-arrow-on">◀</span>`
    : `<span class="sa-arrow sa-arrow-off">◀</span>`;
  const next = d.has_next
    ? `<span class="sa-arrow sa-arrow-on">▶</span>`
    : `<span class="sa-arrow sa-arrow-off">▶</span>`;

  const bars = d.months.map(m => `
    <div class="sa-col">
      <div class="sa-count">${m.count > 0 ? m.count : ''}</div>
      <div class="sa-bar-track">
        <div class="sa-bar-fill" style="height:${m.pct}%"></div>
      </div>
      <div class="sa-label">${m.month}</div>
    </div>`).join('');

  setContent(`<div class="sa-screen">
    <div class="sa-year-row">
      ${prev}<span class="sa-year">${d.year}</span>${next}
    </div>
    <div class="sa-subtitle">${d.total_year} email${d.total_year !== 1 ? 's' : ''} in ${d.year}</div>
    <div class="sa-chart">${bars}</div>
  </div>`);
}

// ── analytics screen ─────────────────────────────────────────────────────────

function renderAnalytics(d) {
  hideFilterBar();
  setHeader('Analytics');
  setStatus('');
  setFooter(kbd('B')+' / '+kbd('Esc')+' Back');

  const senderBars = d.top_senders.map(r =>
    `<div class="bar-row">
      <span class="bar-label" title="${esc(r.sender)}">${esc(r.sender)}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${r.pct}%"></div></div>
      <span class="bar-val">${r.count}</span>
    </div>`
  ).join('');

  const domainBars = d.top_domains.map(r =>
    `<div class="bar-row">
      <span class="bar-label">${esc(r.domain)}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${r.pct}%;background:var(--yellow)"></div></div>
      <span class="bar-val">${r.count}</span>
    </div>`
  ).join('');

  setContent(`<div class="analytics-grid">
    <div class="analytics-summary">
      <div class="stat-block"><div class="stat-num">${d.total_senders}</div><div class="stat-label">Senders</div></div>
      <div class="stat-block"><div class="stat-num">${d.total_emails}</div><div class="stat-label">Emails</div></div>
      <div class="stat-block"><div class="stat-num">${d.unsubscribed}</div><div class="stat-label">Unsubscribed</div></div>
    </div>
    <div class="analytics-card">
      <h3>Top Senders by Volume</h3>
      ${senderBars}
    </div>
    <div class="analytics-card">
      <h3>Top Domains by Emails</h3>
      ${domainBars}
    </div>
  </div>`);
}

connect();
