// ═══════════════════════════════════════════════════════
//  RENDER
// ═══════════════════════════════════════════════════════

const VS_ROW_HEIGHT = 42;
const VS_BUFFER = 10;
let _vsActive = false;
let _vsLastStart = -1;
let _vsLastEnd = -1;
let _vsRaf = 0;
let _vsScrollBound = false;

function renderThreadDot(email) {
  if (hasReplies(email)) {
    const replyCount = countThreadReplies(email);
    return `<span title="Has ${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}" style="color:var(--info);font-size:10px">💬</span>`;
  }
  if (getThreadDepth(email) > 0) {
    return `<span class="thread-dot has-thread" title="Reply in thread"></span>`;
  }
  return `<span class="thread-dot no-thread"></span>`;
}

function renderEmailRowHtml(email) {
  const dateStr  = email.date ? formatDate(email.date) : '—';
  const from     = email.fromName || email.fromAddr || '—';
  const status   = renderBadge(email);
  const unread   = email.status === 'unread' ? 'unread' : '';
  const selected = selectedEmail?.id === email.id ? 'selected' : '';
  const attach   = email.attachmentCount > 0
    ? `<span style="color:var(--warn)">📎 ${email.attachmentCount}</span>` : '—';

  const dot = renderThreadDot(email);
  const threadDepth = getThreadDepth(email);
  const indent = (currentView === 'threads' && threadDepth > 0) ? (threadDepth * 12) + 'px' : '';

  const rowLabel = escHtml(`${from}: ${email.subject || '(no subject)'}`);
  return `
    <div class="email-row ${unread} ${selected}" data-id="${email.id}" role="button" tabindex="0" aria-label="${rowLabel}" onclick="selectEmail('${email.id}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();selectEmail('${email.id}')}">
      <div class="col-flag">${dot}</div>
      <div class="col-from" title="${escHtml(email.fromAddr)}">${escHtml(truncate(from, 26))}</div>
      <div class="col-subject" title="${escHtml(email.subject)}">
        <span style="${indent ? `margin-left:${indent}` : ''}">${escHtml(truncate(email.subject, 60))}</span>
      </div>
      <div class="col-date">${dateStr}</div>
      <div class="col-status">${status}</div>
      <div class="col-attach">${attach}</div>
    </div>`;
}

function vsRenderSlice(force) {
  if (!_vsActive) return;
  const scroller = document.getElementById('email-scroll');
  const window_  = document.getElementById('vs-window');
  if (!scroller || !window_) return;

  const viewH = scroller.clientHeight;
  const scrollTop = scroller.scrollTop;
  const total = filteredEmails.length;

  // Bulk-tag bar lives above #email-list in the same scroller; account for its height
  const listTop = document.getElementById('email-list').offsetTop;
  const relativeTop = Math.max(0, scrollTop - listTop);

  let start = Math.floor(relativeTop / VS_ROW_HEIGHT) - VS_BUFFER;
  let end   = Math.ceil((relativeTop + viewH) / VS_ROW_HEIGHT) + VS_BUFFER;
  start = Math.max(0, start);
  end   = Math.min(total, end);

  if (!force && start === _vsLastStart && end === _vsLastEnd) return;
  _vsLastStart = start;
  _vsLastEnd = end;

  let html = '';
  for (let i = start; i < end; i++) html += renderEmailRowHtml(filteredEmails[i]);
  window_.style.transform = `translateY(${start * VS_ROW_HEIGHT}px)`;
  window_.innerHTML = html;
}

function vsOnScroll() {
  if (_vsRaf) return;
  _vsRaf = requestAnimationFrame(() => {
    _vsRaf = 0;
    vsRenderSlice(false);
  });
}

function vsBindScrollOnce() {
  if (_vsScrollBound) return;
  const scroller = document.getElementById('email-scroll');
  if (!scroller) return;
  scroller.addEventListener('scroll', vsOnScroll, { passive: true });
  window.addEventListener('resize', () => vsRenderSlice(true));
  _vsScrollBound = true;
}

function renderEmailList() {
  const container = document.getElementById('email-list');

  if (!filteredEmails.length) {
    _vsActive = false;
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📭</div>
        <div class="empty-text">${allEmails.length === 0
          ? 'No emails imported yet.<br>Use the Import button to get started.'
          : 'No emails match the current filter.'
        }</div>
      </div>`;
    return;
  }

  _vsActive = true;
  _vsLastStart = _vsLastEnd = -1;
  vsBindScrollOnce();

  const totalHeight = filteredEmails.length * VS_ROW_HEIGHT;
  container.innerHTML = `<div class="vs-spacer" style="height:${totalHeight}px"><div class="vs-window" id="vs-window"></div></div>`;

  const scroller = document.getElementById('email-scroll');
  if (scroller) scroller.scrollTop = 0;
  vsRenderSlice(true);
}


function renderBadge(email) {
  return email.status === 'unread'
    ? '<span class="badge badge-unread">unread</span>'
    : '<span class="badge badge-actioned">read</span>';
}

// Update a single email row in the list without re-rendering everything
function updateEmailRow(email) {
  const row = document.querySelector(`#email-list .email-row[data-id="${CSS.escape(email.id)}"]`);
  if (!row) return;

  // Update unread highlight
  if (email.status === 'unread') row.classList.add('unread');
  else row.classList.remove('unread');

  // Update flag dot
  row.querySelector('.col-flag').innerHTML = renderThreadDot(email);

  // Update status badge
  row.querySelector('.col-status').innerHTML = renderBadge(email);
}

function selectEmail(id) {
  const email = emailIdIndex.get(id);
  if (!email) return;

  // Update selection highlight in DOM without full list re-render
  const prevIdx = selectedEmailIdx;
  const newIdx = filteredEmails.findIndex(e => e.id === id);
  selectedEmail = email;
  selectedEmailIdx = newIdx;

  const prevRow = prevIdx >= 0 && filteredEmails[prevIdx]
    ? document.querySelector(`#email-list .email-row[data-id="${CSS.escape(filteredEmails[prevIdx].id)}"]`)
    : null;
  const newRow = newIdx >= 0
    ? document.querySelector(`#email-list .email-row[data-id="${CSS.escape(id)}"]`)
    : null;
  if (prevRow) prevRow.classList.remove('selected');
  if (newRow) newRow.classList.add('selected');

  // Open modal immediately — no awaiting anything
  openDetail(email);

  // Mark as read in background (fire-and-forget)
  if (email.status === 'unread') {
    email.status = 'read';
    if (newRow) newRow.classList.remove('unread');
    dbPut('emails', email);
    updateHeaderStatsFast();
  }
}

// ── Truncation controls state ────────────────────────────
let _truncMatches = [];     // [{lineIndex, snippet}]
let _truncCurrent = -1;     // which match is previewed (-1 = none)
let _truncOrigBody = null;  // original body before any preview

// Clears match state, sets the status label, and hides all truncation buttons
function _resetTruncControls(statusText) {
  _truncMatches = [];
  _truncCurrent = -1;
  const status = document.getElementById('trunc-status');
  if (status) status.textContent = statusText;
  for (const id of ['trunc-prev-btn', 'trunc-next-btn', 'trunc-save-btn', 'trunc-reset-btn', 'trunc-save-full-btn']) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  }
}

function truncFindMatches() {
  const email = selectedEmail;
  if (!email) return;
  _truncOrigBody = selectedEmailBody || '';
  _truncMatches = findTruncationMatches(_truncOrigBody);

  if (!_truncMatches.length) {
    _resetTruncControls('No truncation points found');
    return;
  }

  // Auto-select first match for preview
  _truncCurrent = 0;
  truncUpdatePreview();
}

function truncNav(dir) {
  if (!_truncMatches.length) return;
  _truncCurrent = Math.max(0, Math.min(_truncMatches.length - 1, _truncCurrent + dir));
  truncUpdatePreview();
}

function truncUpdatePreview() {
  const match = _truncMatches[_truncCurrent];
  const bodyEl = document.getElementById('det-body-text');
  const status = document.getElementById('trunc-status');
  const prevBtn = document.getElementById('trunc-prev-btn');
  const nextBtn = document.getElementById('trunc-next-btn');
  const saveBtn = document.getElementById('trunc-save-btn');
  const resetBtn = document.getElementById('trunc-reset-btn');
  if (!bodyEl || !match) return;

  const truncated = truncateAtLine(_truncOrigBody, match.lineIndex);
  bodyEl.textContent = truncated || '(empty after truncation)';
  const lines = (_truncOrigBody || '').split('\n');
  const removedLines = lines.length - match.lineIndex;
  status.textContent = `Match ${_truncCurrent + 1}/${_truncMatches.length} · "${match.snippet.slice(0,40)}${match.snippet.length>40?'…':''}" · removes ${removedLines} line${removedLines!==1?'s':''}`;
  prevBtn.style.display = _truncCurrent > 0 ? '' : 'none';
  nextBtn.style.display = _truncCurrent < _truncMatches.length - 1 ? '' : 'none';
  saveBtn.style.display = '';
  resetBtn.style.display = '';
}

async function truncSave() {
  const email = selectedEmail;
  if (!email || _truncCurrent < 0 || !_truncMatches.length) return;
  const match = _truncMatches[_truncCurrent];
  const truncated = truncateAtLine(_truncOrigBody, match.lineIndex);
  selectedEmailBody = truncated;
  await putBody(email.id, truncated);
  updateSearchMatchForBody(email.id, truncated);
  _truncOrigBody = truncated;
  _resetTruncControls('Saved');
  toast('Body truncated and saved');
}

async function truncSaveFull() {
  const email = selectedEmail;
  if (!email || _truncOrigBody === null) return;
  selectedEmailBody = _truncOrigBody;
  await putBody(email.id, _truncOrigBody);
  updateSearchMatchForBody(email.id, _truncOrigBody);
  _resetTruncControls('Saved');
  toast('Full body saved');
}

function truncReset() {
  const bodyEl = document.getElementById('det-body-text');
  if (bodyEl && _truncOrigBody !== null) bodyEl.textContent = _truncOrigBody;
  _resetTruncControls('');
}
// ── End truncation controls ──────────────────────────────

// ── Manual body editing ──────────────────────────────────
function editBodyText() {
  const bodyTextEl = document.getElementById('det-body-text');
  const editBtn = document.getElementById('body-edit-btn');
  if (!bodyTextEl || !selectedEmail) return;

  // Already in edit mode — cancel
  if (bodyTextEl.querySelector('textarea')) {
    cancelBodyEdit();
    return;
  }

  const currentText = selectedEmailBody || '';
  const ta = document.createElement('textarea');
  ta.id = 'body-edit-textarea';
  ta.value = currentText;
  ta.className = 'body-edit-textarea';
  ta.spellcheck = false;

  const btnRow = document.createElement('div');
  btnRow.id = 'body-edit-btn-row';
  btnRow.style.cssText = 'display:flex;gap:6px;margin-top:8px;';
  btnRow.innerHTML = `
    <button class="btn" style="padding:2px 10px;font-size:11px;color:var(--accent);" onclick="saveBodyEdit()">Save</button>
    <button class="btn" style="padding:2px 10px;font-size:11px;" onclick="cancelBodyEdit()">Cancel</button>
  `;

  bodyTextEl.textContent = '';
  bodyTextEl.appendChild(ta);
  bodyTextEl.appendChild(btnRow);
  ta.focus();

  if (editBtn) editBtn.textContent = '✏ Editing…';
}

async function saveBodyEdit() {
  const ta = document.getElementById('body-edit-textarea');
  const editBtn = document.getElementById('body-edit-btn');
  if (!ta || !selectedEmail) return;

  const newText = ta.value;
  selectedEmailBody = newText;
  await putBody(selectedEmail.id, newText);
  updateSearchMatchForBody(selectedEmail.id, newText);

  const bodyTextEl = document.getElementById('det-body-text');
  if (bodyTextEl) _renderBodyText(bodyTextEl, newText || '(no plain text body)', null);
  if (editBtn) editBtn.textContent = '✏ Edit Body';
  toast('Body saved');
}

function cancelBodyEdit() {
  const editBtn = document.getElementById('body-edit-btn');
  const bodyTextEl = document.getElementById('det-body-text');
  if (bodyTextEl && selectedEmail) {
    _renderBodyText(bodyTextEl, selectedEmailBody || '(no plain text body)', null);
  }
  if (editBtn) editBtn.textContent = '✏ Edit Body';
}
// ── End manual body editing ──────────────────────────────

// Renders body text into `el`, replacing [cid:XXX] patterns with <img> elements
// when cidMap (Map<contentId, blobUrl>) is provided. Safe: uses DOM, not innerHTML.
function _renderBodyText(el, text, cidMap) {
  el.textContent = '';
  if (!cidMap || cidMap.size === 0) {
    el.textContent = text;
    return;
  }
  const cidPattern = /\[cid:([^\]]+)\]/g;
  let lastIndex = 0;
  let match;
  while ((match = cidPattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      el.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
    }
    const blobUrl = cidMap.get(match[1]);
    if (blobUrl) {
      const img = document.createElement('img');
      img.src = blobUrl;
      img.alt = match[1];
      img.style.cssText = 'max-width:100%; display:block; margin:4px 0; border-radius:2px;';
      el.appendChild(img);
    } else {
      el.appendChild(document.createTextNode(match[0]));
    }
    lastIndex = cidPattern.lastIndex;
  }
  if (lastIndex < text.length) {
    el.appendChild(document.createTextNode(text.slice(lastIndex)));
  }
}

// Element focused before the detail modal opened, restored on close
let _focusBeforeModal = null;

// Id of the email whose body currently sits in selectedEmailBody, while the modal
// is open on it. Lets openDetail tell a re-render of the same email (attachment
// action, automated toggle) from opening a different one. Cleared on close, so
// reopening an email always re-reads the stored body.
let _loadedBodyId = null;

function openDetail(email) {
  // Remember focus so we can restore it when the modal closes (a11y)
  if (!document.getElementById('email-modal-overlay').classList.contains('open')) {
    _focusBeforeModal = document.activeElement;
  }

  // Reset truncation state for new email
  _truncMatches = [];
  _truncCurrent = -1;
  _truncOrigBody = null;

  document.getElementById('email-modal-overlay').classList.add('open');
  document.getElementById('email-modal-overlay').scrollTop = 0;
  // Move focus into the dialog so keyboard/screen-reader users land inside it
  document.getElementById('detail-panel').focus();
  updateModalNavButtons();

  // Subject
  document.getElementById('det-subject').textContent = email.subject || '(no subject)';

  // Thread context
  const threadDepth = getThreadDepth(email);
  const emailHasReplies = hasReplies(email);
  let threadInfo = '';
  
  if (threadDepth > 0) {
    const rootEmail = getThreadRoot(email);
    const replyCount = countThreadReplies(rootEmail);
    threadInfo = `<span><b>Thread:</b> Reply ${threadDepth} of ${replyCount + 1} ${rootEmail.id !== email.id ? `→ <a href="#" onclick="selectEmail('${rootEmail.id}');return false;" style="color:var(--accent)">View root</a>` : ''}</span>`;
  } else if (emailHasReplies) {
    const replyCount = countThreadReplies(email);
    threadInfo = `<span><b>Thread:</b> ${replyCount} ${replyCount === 1 ? 'reply' : 'replies'} <a href="#" onclick="showThread('${email.id}');return false;" style="color:var(--accent)">View all</a></span>`;
  }

  // Meta
  const toStr = email.toAddrs?.join(', ') || '—';
  const ccStr = email.ccAddrs?.join(', ') || '';
  const uid = email.id.replace(/[^a-z0-9]/gi, '');
  document.getElementById('det-meta').innerHTML = `
    <span><b>From:</b> ${escHtml(email.fromName ? `${email.fromName} <${email.fromAddr}>` : email.fromAddr)}</span>
    ${recipientSpan('To', toStr, 80, uid)}
    ${ccStr ? recipientSpan('CC', ccStr, 80, uid) : ''}
    <span><b>Date:</b> ${email.date ? new Date(email.date).toLocaleString() : '—'}</span>
    ${threadInfo}
    <span><b>File:</b> <span style="font-family:var(--mono);font-size:11px;color:var(--muted)">${escHtml(email.fileName || '')}</span></span>
  `;

  document.getElementById('det-actions').innerHTML = `
    ${(email.isSystemEmail || email.manualSystemOverride) ? `
    <button class="btn" onclick="toggleAutomated('${email.id}')" title="${email.isSystemEmail ? 'Unmark automated — removes from automated view and protects from bulk discard' : 'Re-mark as automated'}">
      ${email.isSystemEmail ? '🤖 Unmark Automated' : '🤖 Re-mark Automated'}
    </button>` : ''}
    <button class="btn btn-danger" onclick="deleteEmail('${email.id}')">✕</button>
    <button class="btn" onclick="quickAddContact('${escHtml(email.fromAddr || '')}','${escHtml((email.fromName || '').replace(/'/g, "\\'"))}')" title="Add/edit sender in Address Book">👤 Contact</button>
  `;

  // Tags
  renderDetailTags(email);

  // Body
  const bodyEl = document.getElementById('det-body');
  bodyEl.innerHTML = '';

  const labelEl = document.createElement('div');
  labelEl.className = 'detail-body-label';
  labelEl.textContent = 'Email Body';
  bodyEl.appendChild(labelEl);

  // Truncation controls
  const truncCtrl = document.createElement('div');
  truncCtrl.id = 'trunc-controls';
  truncCtrl.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:4px 0 8px 0;font-size:11px;';
  truncCtrl.innerHTML = `
    <button class="btn" id="trunc-find-btn" onclick="truncFindMatches()" style="padding:2px 8px;font-size:11px;" title="Scan body for reply/quote markers and show truncation options">✂ Truncation</button>
    <button class="btn" onclick="reimportEmlBody('${email.id}')" style="padding:2px 8px;font-size:11px;" title="Pick the original .eml file to reimport its full body text">↺ Reimport EML</button>
    <button class="btn" onclick="openOriginalEml('${email.id}')" style="padding:2px 8px;font-size:11px;" title="Download the original .eml file to open in your email client">⬇ Open Original</button>
    <button class="btn" id="body-edit-btn" onclick="editBodyText()" style="padding:2px 8px;font-size:11px;" title="Manually edit the body text">✏ Edit Body</button>
    <span id="trunc-status" style="color:var(--muted);"></span>
    <button class="btn" id="trunc-prev-btn" onclick="truncNav(-1)" style="display:none;padding:2px 6px;font-size:11px;">◀</button>
    <button class="btn" id="trunc-next-btn" onclick="truncNav(1)" style="display:none;padding:2px 6px;font-size:11px;">▶</button>
    <button class="btn" id="trunc-save-btn" onclick="truncSave()" style="display:none;padding:2px 8px;font-size:11px;color:var(--accent);" title="Save body truncated at this point">Save Truncated</button>
    <button class="btn" id="trunc-save-full-btn" onclick="truncSaveFull()" style="display:none;padding:2px 8px;font-size:11px;" title="Save full reimported body without any truncation">Save Full</button>
    <button class="btn" id="trunc-reset-btn" onclick="truncReset()" style="display:none;padding:2px 6px;font-size:11px;" title="Reset to original body">Reset</button>
  `;
  bodyEl.appendChild(truncCtrl);

  const bodyTextEl = document.createElement('div');
  bodyTextEl.id = 'det-body-text';
  bodyEl.appendChild(bodyTextEl);

  if (_loadedBodyId === email.id) {
    // Re-render of the email already open (attachment actions, automated toggle)
    // — reuse the loaded body rather than re-reading it, which would also throw
    // away a reimported body the user hasn't saved yet.
    _renderBodyText(bodyTextEl, selectedEmailBody || '(no plain text body)', null);
  } else {
    // Bodies aren't held in allEmails — fetch this one, same placeholder-then-fill
    // pattern as the attachment panel below.
    selectedEmailBody = '';
    _loadedBodyId     = null;
    bodyTextEl.textContent = 'Loading…';
    const bodyIdAtLoad = email.id;
    getBody(bodyIdAtLoad).then(text => {
      if (!selectedEmail || selectedEmail.id !== bodyIdAtLoad) return;
      selectedEmailBody = text;
      _loadedBodyId     = bodyIdAtLoad;
      const el = document.getElementById('det-body-text');
      if (el) _renderBodyText(el, text || '(no plain text body)', null);
    });
  }

  // Attachments — show placeholder immediately, load in background
  const attPanel = document.getElementById('det-attachments');
  // Remove any previously appended issue section from older renders
  const oldIssueSection = document.getElementById('det-issue-section');
  if (oldIssueSection) oldIssueSection.remove();
  if (email.hasAttachments) {
    attPanel.style.display = '';
    attPanel.innerHTML = `<div class="detail-attach-title">Attachments (loading…)</div>`;
    const emailIdAtLoad = email.id;
    dbGetByIndex('attachments', 'emailId', email.id).then(async atts => {
      // Only update if the same email is still open
      if (!selectedEmail || selectedEmail.id !== emailIdAtLoad) return;

      const ATTACH_THRESHOLD = 3;

      const renderAttachItem = (a, showingBlacklisted = false) => {
        const action = `onclick="downloadEmlForAttachment('${escHtml(a.emailId)}')" title="Download the original .eml to open this attachment"`;
        const icon = '📎';
        const blacklistBtn = `<button class="btn" onclick="toggleAttachmentBlacklist('${a.id}')" style="padding:2px 6px; font-size:10px; ${a.isBlacklisted ? 'color:var(--accent);' : 'color:var(--muted);'}" title="${a.isBlacklisted ? 'Unblacklist (show in list)' : 'Blacklist (hide from list)'}">${a.isBlacklisted ? '🚫' : '○'}</button>`;

        const extractable = isExtractableType(a.contentType, a.filename);
        let extractBtn = '';
        let textPreview = '';
        if (extractable) {
          const status = a.extractionStatus;
          if (!status || status === 'failed') {
            const lbl = status === 'failed' ? '↺' : '⇩T';
            extractBtn = `<button id="extract-btn-${a.id}" class="btn" onclick="extractTextFromEml('${a.id}')" style="padding:2px 6px; font-size:10px;" title="${status === 'failed' ? 'Retry extract' : 'Extract text'}">${lbl}</button>`;
          } else if (status === 'done') {
            if (a.extractedText) {
              extractBtn = `<button class="btn" onclick="toggleAttachText('${a.id}')" style="padding:2px 6px; font-size:10px;" title="Toggle extracted text">T✓</button><button id="extract-btn-${a.id}" class="btn" onclick="extractTextFromEml('${a.id}')" style="padding:2px 6px; font-size:10px;" title="Re-extract">↺</button>`;
              textPreview = `<div id="att-text-${a.id}" style="display:none; margin:2px 0 4px 0; padding:8px 10px; background:var(--surface); border:1px solid var(--border2); border-radius:4px; font-size:11px; line-height:1.55; color:var(--text); white-space:pre-wrap; max-height:300px; overflow-y:auto;">${escHtml(a.extractedText)}</div>`;
            } else {
              extractBtn = `<button id="extract-btn-${a.id}" class="btn" onclick="extractTextFromEml('${a.id}')" style="padding:2px 6px; font-size:10px;" title="Re-extract">↺</button>`;
            }
          } else if (status === 'unsupported') {
            // No retry button — retrying a format we have no extractor for
            // can only fail again.  Show why on hover instead.
            const why = a.extractionNote || 'no extractor for this format';
            extractBtn = `<span style="padding:2px 6px; font-size:10px; color:var(--muted); cursor:help;" title="${escHtml(why)}">T—</span>`;
          }
        }

        return `
          <div class="attach-item">
            <div class="attach-chip" ${action} style="flex:1; min-width:0; margin:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
              ${icon} ${escHtml(a.filename)}<span class="attach-size" style="margin-left:6px;">${formatSize(a.size)}</span>
            </div>
            ${extractBtn}
            ${blacklistBtn}
          </div>
          ${textPreview}
        `;
      };

      const visibleAtts = atts.filter(a => !a.isBlacklisted);
      const blacklistedAtts = atts.filter(a => a.isBlacklisted);

      const visibleHtml = visibleAtts.slice(0, ATTACH_THRESHOLD).map(a => renderAttachItem(a)).join('');
      const overflowCount = visibleAtts.length - ATTACH_THRESHOLD;
      const overflowHtml = overflowCount > 0
        ? `<div class="attach-overflow" style="display:none;">${visibleAtts.slice(ATTACH_THRESHOLD).map(a => renderAttachItem(a)).join('')}</div>
           <button class="attach-show-more" onclick="toggleAttachMore(this)" data-more-label="+${overflowCount} more">+${overflowCount} more</button>`
        : '';

      const blacklistedHtml = blacklistedAtts.length > 0
        ? `<div id="att-blacklisted-section" style="margin-top:4px;">
             <button class="btn" onclick="toggleBlacklistedSection(this)" style="font-size:11px; color:var(--muted); padding:2px 6px;" data-expanded="false">
               🚫 ${blacklistedAtts.length} hidden
             </button>
             <div id="att-blacklisted-items" style="display:none; margin-top:4px; opacity:0.6;">
               ${blacklistedAtts.map(a => renderAttachItem(a, true)).join('')}
             </div>
           </div>`
        : '';

      attPanel.innerHTML = `
        <div class="detail-attach-title">Attachments (${visibleAtts.length}${blacklistedAtts.length > 0 ? `+${blacklistedAtts.length}` : ''})</div>
        <div class="attach-list">${visibleHtml}${overflowHtml}${blacklistedHtml}</div>
      `;
    });
  } else {
    attPanel.style.display = 'none';
  }
}

function showThread(emailId) {
  const email = emailIdIndex.get(emailId);
  if (!email) return;
  
  const threadEmails = getThreadEmails(email);
  if (threadEmails.length === 0) return;

  // Temporarily override filtered list
  filteredEmails = threadEmails;
  renderEmailList();
  
  // Select root
  const root = getThreadRoot(email);
  selectEmail(root.id);
  
  toast(`Showing thread with ${threadEmails.length} emails`, 'ok');
}

function renderDetailTags(email) {
  const tags       = email.tags || [];
  const exclusions = email.tagExclusions || [];
  const row        = document.getElementById('det-tags');

  // Compute top-5 globally used tags not already on this email or excluded
  const freq = {};
  for (const e of allEmails) {
    for (const t of (e.tags || [])) freq[t] = (freq[t] || 0) + 1;
  }
  const suggestions = Object.entries(freq)
    .filter(([t]) => !tags.includes(t) && !exclusions.includes(t))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([t]) => t);

  const safeId = escHtml(email.id);
  const activeChips = tags.map(t => `
    <span class="tag-chip active">
      # ${escHtml(t)}
      <button class="tag-btn-remove" onclick="removeTag('${safeId}','${escHtml(t)}')" title="Remove tag">×</button><button class="tag-btn-exclude" onclick="excludeTag('${safeId}','${escHtml(t)}')" title="Exclude — prevent auto/bulk re-tagging">⊘</button>
    </span>`).join('');

  const excludedChips = exclusions.map(t => `
    <span class="tag-chip excluded" title="Excluded from auto-tagging — click to un-exclude" onclick="unexcludeTag('${safeId}','${escHtml(t)}')">
      ⊘ ${escHtml(t)}
    </span>`).join('');

  const suggestChips = suggestions.length ? `
    <span class="tag-suggest-sep"></span>
    ${suggestions.map(t => `<span class="tag-chip tag-suggest" title="Add tag: ${escHtml(t)}" onclick="addTag('${safeId}','${escHtml(t)}')">+ ${escHtml(t)}</span>`).join('')}` : '';

  row.innerHTML = activeChips + excludedChips + suggestChips +
    `<button class="tag-add" onclick="addTag('${safeId}')">+ tag</button>`;
}

function closeDetail() {
  const wasOpen = document.getElementById('email-modal-overlay').classList.contains('open');
  selectedEmail = null;
  selectedEmailIdx = -1;
  // Drop the loaded body — reopening re-reads it, so the panel can't show a stale
  // one. A reimported body that was never saved is discarded here too.
  selectedEmailBody = '';
  _loadedBodyId     = null;
  document.getElementById('email-modal-overlay').classList.remove('open');
  // Restore focus to the element that opened the modal (a11y)
  if (wasOpen && _focusBeforeModal && document.contains(_focusBeforeModal)) {
    _focusBeforeModal.focus();
  }
  _focusBeforeModal = null;
}

function handleModalOverlayClick(e) {
  if (e.target === document.getElementById('email-modal-overlay')) closeDetail();
}

function navigateEmail(dir) {
  const newIdx = selectedEmailIdx + dir;
  if (newIdx < 0 || newIdx >= filteredEmails.length) return;
  selectEmail(filteredEmails[newIdx].id);
  // Scroll the newly selected row into view in the list
  if (_vsActive) {
    const scroller = document.getElementById('email-scroll');
    const listTop = document.getElementById('email-list').offsetTop;
    if (scroller) {
      const rowTop = listTop + newIdx * VS_ROW_HEIGHT;
      const rowBot = rowTop + VS_ROW_HEIGHT;
      if (rowTop < scroller.scrollTop) scroller.scrollTop = rowTop;
      else if (rowBot > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = rowBot - scroller.clientHeight;
    }
  } else {
    const row = document.querySelector(`#email-list .email-row[data-id="${CSS.escape(filteredEmails[newIdx].id)}"]`);
    if (row) row.scrollIntoView({ block: 'nearest' });
  }
}

function updateModalNavButtons() {
  const prevBtn = document.getElementById('nav-prev');
  const nextBtn = document.getElementById('nav-next');
  const counter = document.getElementById('nav-counter');
  if (!prevBtn) return;
  prevBtn.disabled = selectedEmailIdx <= 0;
  nextBtn.disabled = selectedEmailIdx < 0 || selectedEmailIdx >= filteredEmails.length - 1;
  counter.textContent = selectedEmailIdx >= 0
    ? `${selectedEmailIdx + 1}/${filteredEmails.length}`
    : '';
}

async function toggleAttachmentBlacklist(attId) {
  const att = await dbGet('attachments', attId);
  if (!att) return;
  att.isBlacklisted = !att.isBlacklisted;
  await dbPut('attachments', att);
  // Re-render the attachment panel for the current email
  if (selectedEmail) openDetail(selectedEmail);
}

function toggleBlacklistedSection(btn) {
  const expanded = btn.dataset.expanded === 'true';
  const items = document.getElementById('att-blacklisted-items');
  if (!items) return;
  items.style.display = expanded ? 'none' : 'block';
  btn.dataset.expanded = expanded ? 'false' : 'true';
}


// Used by sv-attachments view to fold attachment rows sharing the same hash
// into a single representative row. Stays minimal — keeps only the fields
// that view actually reads.
function deduplicateAttachmentsByHash(rows) {
  const hashMap = new Map();
  for (const r of rows) {
    const key = r.hash || `__no_hash__${r.id}`;
    if (!hashMap.has(key)) {
      hashMap.set(key, { ...r, _allEmails: [r.email], _allIds: [r.id] });
    } else {
      const rep = hashMap.get(key);
      rep._allEmails.push(r.email);
      rep._allIds.push(r.id);
    }
  }
  return [...hashMap.values()];
}
