// ═══════════════════════════════════════════════════════
//  RENDER
// ═══════════════════════════════════════════════════════

function renderEmailList() {
  const container = document.getElementById('email-list');

  if (!filteredEmails.length) {
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

  container.innerHTML = filteredEmails.map(email => {
    const dateStr  = email.date ? formatDate(email.date) : '—';
    const from     = email.fromName || email.fromAddr || '—';
    const status   = renderBadge(email);
    const unread   = email.status === 'unread' ? 'unread' : '';
    const selected = selectedEmail?.id === email.id ? 'selected' : '';
    const attach   = email.attachmentCount > 0
      ? `<span style="color:var(--warn)">📎 ${email.attachmentCount}</span>` : '—';
    
    // Thread indicator
    const emailHasReplies = hasReplies(email);
    const threadDepth = getThreadDepth(email);
    let dot = '';
    if (email.isActionable) {
      dot = `<span title="Actionable" style="color:var(--danger);font-size:10px">⚡</span>`;
    } else if (emailHasReplies) {
      const replyCount = countThreadReplies(email);
      dot = `<span title="Has ${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}" style="color:var(--info);font-size:10px">💬</span>`;
    } else if (threadDepth > 0) {
      dot = `<span class="thread-dot has-thread" title="Reply in thread"></span>`;
    } else {
      dot = `<span class="thread-dot no-thread"></span>`;
    }

    // Thread indentation — only in Threads view to show reply hierarchy
    const indent = (currentView === 'threads' && threadDepth > 0) ? (threadDepth * 12) + 'px' : '';

    // Overdue flag for awaiting view
    const overdueFlag = email._overdue ? `<span style="color:var(--danger);margin-left:4px" title="Overdue">🔴</span>` : '';

    return `
      <div class="email-row ${unread} ${selected}" data-id="${email.id}" onclick="selectEmail('${email.id}')">
        <div class="col-flag">${dot}</div>
        <div class="col-from" title="${escHtml(email.fromAddr)}">${escHtml(truncate(from, 26))}</div>
        <div class="col-subject" title="${escHtml(email.subject)}">
          <span style="${indent ? `margin-left:${indent}` : ''}">${escHtml(truncate(email.subject, 60))}${overdueFlag}</span>
        </div>
        <div class="col-date">${dateStr}</div>
        <div class="col-status">${status}</div>
        <div class="col-attach">${attach}</div>
      </div>`;
  }).join('');

  refreshBulkTagBar();
}


function renderBadge(email) {
  switch (email.status) {
    case 'unread':    return '<span class="badge badge-unread">unread</span>';
    case 'replied':   return '<span class="badge badge-replied">replied</span>';
    case 'awaiting':  return '<span class="badge badge-awaiting">awaiting</span>';
    case 'actioned':  return '<span class="badge badge-actioned">actioned</span>';
    default:
      if (email.isActionable) return '<span class="badge badge-action">action!</span>';
      return '<span class="badge badge-actioned">read</span>';
  }
}

// Update a single email row in the list without re-rendering everything
function updateEmailRow(email) {
  const row = document.querySelector(`#email-list .email-row[data-id="${CSS.escape(email.id)}"]`);
  if (!row) return;

  // Update unread highlight
  if (email.status === 'unread') row.classList.add('unread');
  else row.classList.remove('unread');

  // Update flag dot
  const emailHasReplies = hasReplies(email);
  const threadDepth = getThreadDepth(email);
  let dot = '';
  if (email.isActionable) {
    dot = `<span title="Actionable" style="color:var(--danger);font-size:10px">⚡</span>`;
  } else if (emailHasReplies) {
    const replyCount = countThreadReplies(email);
    dot = `<span title="Has ${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}" style="color:var(--info);font-size:10px">💬</span>`;
  } else if (threadDepth > 0) {
    dot = `<span class="thread-dot has-thread" title="Reply in thread"></span>`;
  } else {
    dot = `<span class="thread-dot no-thread"></span>`;
  }
  row.querySelector('.col-flag').innerHTML = dot;

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

  const rows = document.querySelectorAll('#email-list .email-row');
  if (prevIdx >= 0 && rows[prevIdx]) rows[prevIdx].classList.remove('selected');
  if (newIdx >= 0 && rows[newIdx]) rows[newIdx].classList.add('selected');

  // Open modal immediately — no awaiting anything
  openDetail(email);

  // Mark as read in background (fire-and-forget)
  if (email.status === 'unread') {
    email.status = 'read';
    if (newIdx >= 0 && rows[newIdx]) rows[newIdx].classList.remove('unread');
    dbPut('emails', email);
    updateHeaderStatsFast();
  }
}

function openDetail(email) {
  document.getElementById('email-modal-overlay').classList.add('open');
  document.getElementById('email-modal-overlay').scrollTop = 0;
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

  // Action buttons
  const awaitingBtn = email.status === 'awaiting'
    ? `<button class="btn" onclick="setStatus('${email.id}','read')" title="Clear awaiting status">✓ Clear Awaiting</button>`
    : `<button class="btn" onclick="setStatus('${email.id}','awaiting')" title="Mark: I sent this, waiting for reply">⏳ Mark Awaiting</button>`;

  document.getElementById('det-actions').innerHTML = `
    ${awaitingBtn}
    <button class="btn" onclick="setStatus('${email.id}','actioned')" title="Mark as actioned">✓ Actioned</button>
    <button class="btn" onclick="toggleActionable('${email.id}')" title="Toggle actionable flag">
      ${email.isActionable ? '⚡ Unmark Action' : '⚡ Mark Action'}
    </button>
    <button class="btn${email.isLowValue ? ' btn-warn' : ''}" onclick="toggleLowValue('${email.id}')" title="Toggle low value flag">
      ${email.isLowValue ? '↓ Unmark Low Value' : '↓ Low Value'}
    </button>
    ${(email.isSystemEmail || email.manualSystemOverride) ? `
    <button class="btn" onclick="toggleAutomated('${email.id}')" title="${email.isSystemEmail ? 'Unmark automated — removes from automated view and protects from bulk discard' : 'Re-mark as automated'}">
      ${email.isSystemEmail ? '🤖 Unmark Automated' : '🤖 Re-mark Automated'}
    </button>` : ''}
    <button class="btn btn-danger" onclick="deleteEmail('${email.id}')">✕</button>
    <button class="btn" onclick="aiTagEmail('${email.id}')" title="Tag and summarize with Claude AI">✨ AI Tag</button>
  `;

  // Tags
  renderDetailTags(email);

  // Body
  const bodyEl = document.getElementById('det-body');
  bodyEl.innerHTML = '';
  if (email.aiSummary) {
    const summaryEl = document.createElement('div');
    summaryEl.className = 'ai-summary-box';
    summaryEl.textContent = '✨ ' + email.aiSummary;
    bodyEl.appendChild(summaryEl);
  }
  const labelEl = document.createElement('div');
  labelEl.className = 'detail-body-label';
  labelEl.textContent = 'Email Body';
  bodyEl.appendChild(labelEl);
  const bodyText = document.createTextNode(email.textBody || '(no plain text body)');
  bodyEl.appendChild(bodyText);

  // Attachments — show placeholder immediately, load in background
  const attPanel = document.getElementById('det-attachments');
  if (email.hasAttachments) {
    attPanel.style.display = '';
    attPanel.innerHTML = `<div class="detail-attach-title">Attachments (loading…)</div>`;
    const emailIdAtLoad = email.id;
    dbGetByIndex('attachments', 'emailId', email.id).then(atts => {
      // Only update if the same email is still open
      if (!selectedEmail || selectedEmail.id !== emailIdAtLoad) return;

      const ATTACH_THRESHOLD = 3;

      const renderAttachItem = a => {
        const hasFile = !!a.storedPath;
        const action = hasFile
          ? `onclick="openAttachmentFromDisk('${a.storedPath}')" title="Click to open"`
          : 'title="File not stored on disk"';
        const icon = hasFile ? '📎' : '📋';

        const extractable = isExtractableType(a.contentType, a.filename);
        let extractBtn = '';
        let textPreview = '';
        if (extractable) {
          const status = a.extractionStatus;
          if (!status || status === 'failed') {
            const lbl = status === 'failed' ? '↺' : '⇩T';
            extractBtn = `<button id="extract-btn-${a.id}" class="btn" onclick="extractTextManualFromDisk('${a.id}')" style="padding:2px 6px; font-size:10px;" title="${status === 'failed' ? 'Retry extract' : 'Extract text'}">${lbl}</button>`;
          } else if (status === 'done') {
            if (a.extractedText) {
              extractBtn = `<button class="btn" onclick="toggleAttachText('${a.id}')" style="padding:2px 6px; font-size:10px;" title="Toggle extracted text">T✓</button><button id="extract-btn-${a.id}" class="btn" onclick="extractTextManualFromDisk('${a.id}')" style="padding:2px 6px; font-size:10px;" title="Re-extract">↺</button>`;
              textPreview = `<div id="att-text-${a.id}" style="display:none; margin:2px 0 4px 0; padding:8px 10px; background:var(--surface); border:1px solid var(--border2); border-radius:4px; font-size:11px; line-height:1.55; color:var(--text); white-space:pre-wrap; max-height:300px; overflow-y:auto;">${escHtml(a.extractedText)}</div>`;
            } else {
              extractBtn = `<button id="extract-btn-${a.id}" class="btn" onclick="extractTextManualFromDisk('${a.id}')" style="padding:2px 6px; font-size:10px;" title="Re-extract">↺</button>`;
            }
          }
        }

        return `
          <div class="attach-item">
            <div class="attach-chip" ${action} style="flex:1; min-width:0; margin:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
              ${icon} ${escHtml(a.filename)}<span class="attach-size" style="margin-left:6px;">${formatSize(a.size)}</span>${hasFile ? '<span style="color:var(--accent);margin-left:4px">●</span>' : ''}
            </div>
            ${extractBtn}
            <button class="btn" onclick="editAttachmentMetadata('${a.id}')" style="padding:2px 6px; font-size:10px;" title="Edit metadata">✏</button>
          </div>
          ${textPreview}
          <div id="att-meta-${a.id}" style="display:none; padding:8px; background:var(--surface); border:1px solid var(--border2); border-radius:4px; margin:2px 0 4px 0;">
            <div style="display:grid; grid-template-columns:120px 1fr; gap:8px; font-size:12px;">
              <label style="color:var(--muted); padding-top:4px;">Transmittal Ref:</label>
              <input type="text" class="search-input" value="${escHtml(a.transmittalRef || '')}" onchange="updateAttachment('${a.id}', 'transmittalRef', this.value)" style="width:100%;" placeholder="e.g., T-2024-001">

              <label style="color:var(--muted); padding-top:4px;">Source Party:</label>
              <div style="display:flex; gap:4px;">
                <input type="text" id="party-${a.id}" class="search-input" value="${escHtml(a.sourceParty || '')}" onchange="updateAttachment('${a.id}', 'sourceParty', this.value)" style="flex:1;" placeholder="e.g., RCY, CAG, LTA">
                <button class="btn" onclick="autoFillParty('${a.id}', '${escHtml(email.fromAddr)}')" style="padding:2px 6px; font-size:10px;" title="Auto-suggest from sender">✨</button>
              </div>

              <label style="color:var(--muted); padding-top:4px;">Document Type:</label>
              <select class="btn" onchange="updateAttachment('${a.id}', 'documentType', this.value)" style="width:100%;">
                <option value="">—</option>
                <option value="Drawing" ${a.documentType === 'Drawing' ? 'selected' : ''}>Drawing</option>
                <option value="Specification" ${a.documentType === 'Specification' ? 'selected' : ''}>Specification</option>
                <option value="Report" ${a.documentType === 'Report' ? 'selected' : ''}>Report</option>
                <option value="Minutes" ${a.documentType === 'Minutes' ? 'selected' : ''}>Minutes</option>
                <option value="RFI" ${a.documentType === 'RFI' ? 'selected' : ''}>RFI</option>
                <option value="Submittal" ${a.documentType === 'Submittal' ? 'selected' : ''}>Submittal</option>
                <option value="Certificate" ${a.documentType === 'Certificate' ? 'selected' : ''}>Certificate</option>
                <option value="Other" ${a.documentType === 'Other' ? 'selected' : ''}>Other</option>
              </select>

              <label style="color:var(--muted); padding-top:4px;">Hash:</label>
              <span style="font-family:var(--mono); font-size:10px; color:var(--muted); padding-top:4px;">${a.hash}</span>
            </div>
          </div>
        `;
      };

      const visibleHtml = atts.slice(0, ATTACH_THRESHOLD).map(renderAttachItem).join('');
      const overflowCount = atts.length - ATTACH_THRESHOLD;
      const overflowHtml = overflowCount > 0
        ? `<div class="attach-overflow" style="display:none;">${atts.slice(ATTACH_THRESHOLD).map(renderAttachItem).join('')}</div>
           <button class="attach-show-more" onclick="toggleAttachMore(this)" data-more-label="+${overflowCount} more">+${overflowCount} more</button>`
        : '';

      attPanel.innerHTML = `
        <div class="detail-attach-title">Attachments (${atts.length})</div>
        <div class="attach-list">${visibleHtml}${overflowHtml}</div>
      `;
    });
  } else {
    attPanel.style.display = 'none';
  }
  
  // Email Type & Issue Linking
  const issuePanel = document.getElementById('det-body').parentElement;
  // Remove any previously appended issue section before re-adding
  const oldIssueSection = document.getElementById('det-issue-section');
  if (oldIssueSection) oldIssueSection.remove();
  const issueSection = document.createElement('div');
  issueSection.id = 'det-issue-section';
  issueSection.style.cssText = 'border-top:1px solid var(--border); padding:20px 24px 24px;';
  
  // Email Type Selector
  const currentType = email.emailType || '';
  issueSection.innerHTML = `
    <div style="margin-bottom:16px;">
      <label style="display:block; font-size:12px; color:var(--muted); margin-bottom:6px;">📝 Remarks:</label>
      <textarea id="email-remarks" class="search-input" rows="3"
        style="width:100%; resize:vertical; font-family:var(--sans); font-size:13px; line-height:1.5;"
        placeholder="Add notes or thoughts about this email…"
        onblur="saveRemarks('${email.id}', this.value)"
      >${escHtml(email.remarks || '')}</textarea>
    </div>

    <div style="margin-bottom:16px;">
      <label style="display:block; font-size:12px; color:var(--muted); margin-bottom:6px;">🏷 Email Type:</label>
      <select id="email-type-select" class="btn" onchange="updateEmailType('${email.id}', this.value)" style="width:200px;">
        <option value="">— None —</option>
        <option value="query" ${currentType === 'query' ? 'selected' : ''}>Query</option>
        <option value="decision" ${currentType === 'decision' ? 'selected' : ''}>Decision</option>
        <option value="risk" ${currentType === 'risk' ? 'selected' : ''}>Risk</option>
        <option value="action" ${currentType === 'action' ? 'selected' : ''}>Action</option>
      </select>
    </div>

    <div>
      <label style="display:block; font-size:12px; color:var(--muted); margin-bottom:6px;">🔗 Linked Issues:</label>
      <div id="linked-issues-list"></div>
      <button class="btn" onclick="linkEmailToIssue('${email.id}')" style="margin-top:8px;">+ Link to Issue</button>
    </div>
  `;
  
  issuePanel.appendChild(issueSection);
  
  // Render linked issues
  renderLinkedIssues(email);
}

async function renderLinkedIssues(email) {
  const container = document.getElementById('linked-issues-list');
  if (!container) return;
  
  const linkedIssues = email.linkedIssues || [];
  
  if (linkedIssues.length === 0) {
    container.innerHTML = '<div style="color:var(--muted); font-size:12px; font-style:italic;">No linked issues</div>';
    return;
  }
  
  const issues = await Promise.all(linkedIssues.map(id => dbGet('issues', id)));
  container.innerHTML = issues.filter(Boolean).map(issue => {
    const statusIcon = issue.status === 'resolved' ? '✓' : '◐';
    return `
      <div style="display:flex; align-items:center; gap:8px; padding:6px; background:var(--surface2); border-radius:4px; margin-bottom:4px;">
        <span>${statusIcon}</span>
        <span style="flex:1; font-size:13px; cursor:pointer;" onclick="showIssueDetail('${issue.id}')">${escHtml(issue.title)}</span>
        <button class="btn" onclick="unlinkEmailFromIssue('${issue.id}', '${email.id}')" style="padding:2px 6px; font-size:10px;">×</button>
      </div>
    `;
  }).join('');
}

async function saveRemarks(emailId, text) {
  const trimmed = text.trim();
  const email = allEmails.find(e => e.id === emailId) || await dbGet('emails', emailId);
  if (!email) return;
  const prev = email.remarks || null;
  if ((trimmed || null) === prev) return; // no change
  email.remarks = trimmed || null;
  await dbPut('emails', email);
  const idx = allEmails.findIndex(e => e.id === emailId);
  if (idx !== -1) allEmails[idx].remarks = email.remarks;
  toast('Remarks saved', 'ok');
}

async function updateEmailType(emailId, type) {
  const email = await dbGet('emails', emailId);
  if (!email) return;

  email.emailType = type || null;
  await dbPut('emails', email);
  toast(`Email type ${type ? 'set to ' + type : 'cleared'}`, 'ok');
}

async function linkEmailToIssue(emailId) {
  const issues = await dbGetAll('issues');
  const openIssues = issues.filter(i => i.status !== 'resolved');
  
  if (openIssues.length === 0) {
    const create = confirm('No open issues found. Create new issue?');
    if (create) {
      await createNewIssue();
      // After creating, try linking again
      setTimeout(() => linkEmailToIssue(emailId), 500);
    }
    return;
  }
  
  // Show selection dialog
  const selection = prompt(
    'Select issue number to link:\n\n' +
    openIssues.map((iss, idx) => `${idx + 1}. ${iss.title}`).join('\n') +
    '\n\nEnter number (or 0 to create new issue):'
  );
  
  if (!selection) return;
  
  const num = parseInt(selection);
  if (num === 0) {
    await createNewIssue();
    setTimeout(() => linkEmailToIssue(emailId), 500);
    return;
  }
  
  const selectedIssue = openIssues[num - 1];
  if (!selectedIssue) {
    toast('Invalid selection', 'err');
    return;
  }
  
  // Link email to issue
  const email = await dbGet('emails', emailId);
  if (!email.linkedIssues) email.linkedIssues = [];
  if (!email.linkedIssues.includes(selectedIssue.id)) {
    email.linkedIssues.push(selectedIssue.id);
    await dbPut('emails', email);
  }
  
  // Link issue to email
  if (!selectedIssue.linkedEmails) selectedIssue.linkedEmails = [];
  if (!selectedIssue.linkedEmails.includes(emailId)) {
    selectedIssue.linkedEmails.push(emailId);
    await dbPut('issues', selectedIssue);
  }
  
  // Auto-link thread emails if user confirms
  const threadEmails = getThreadEmails(email);
  if (threadEmails.length > 1) {
    const linkThread = confirm(`Link all ${threadEmails.length} emails in this thread to the issue?`);
    if (linkThread) {
      for (const te of threadEmails) {
        if (te.id === emailId) continue; // Already linked
        if (!te.linkedIssues) te.linkedIssues = [];
        if (!te.linkedIssues.includes(selectedIssue.id)) {
          te.linkedIssues.push(selectedIssue.id);
          await dbPut('emails', te);
        }
        if (!selectedIssue.linkedEmails.includes(te.id)) {
          selectedIssue.linkedEmails.push(te.id);
        }
      }
      await dbPut('issues', selectedIssue);
      toast(`Linked ${threadEmails.length} emails to issue`, 'ok');
    } else {
      toast('Email linked to issue', 'ok');
    }
  } else {
    toast('Email linked to issue', 'ok');
  }
  
  // Refresh display
  selectEmail(emailId);
}

function showThread(emailId) {
  const email = allEmails.find(e => e.id === emailId);
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
  selectedEmail = null;
  selectedEmailIdx = -1;
  document.getElementById('email-modal-overlay').classList.remove('open');
}

function handleModalOverlayClick(e) {
  if (e.target === document.getElementById('email-modal-overlay')) closeDetail();
}

function navigateEmail(dir) {
  const newIdx = selectedEmailIdx + dir;
  if (newIdx < 0 || newIdx >= filteredEmails.length) return;
  selectEmail(filteredEmails[newIdx].id);
  // Scroll the newly selected row into view in the list
  const rows = document.querySelectorAll('#email-list .email-row');
  if (rows[newIdx]) rows[newIdx].scrollIntoView({ block: 'nearest' });
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

function editAttachmentMetadata(attId) {
  const metaPanel = document.getElementById(`att-meta-${attId}`);
  if (metaPanel) {
    metaPanel.style.display = metaPanel.style.display === 'none' ? 'block' : 'none';
  }
}

async function updateAttachment(attId, field, value) {
  const att = await dbGet('attachments', attId);
  if (!att) return;
  
  att[field] = value.trim();
  await dbPut('attachments', att);
  
  toast(`Updated ${field}`, 'ok');
}

function suggestSourceParty(domain) {
  // Common domain → party mapping for Singapore construction projects
  const mapping = {
    'rcy.com.sg': 'RCY',
    'changiairport.com': 'CAG',
    'lta.gov.sg': 'LTA',
    'surbanajurong.com': 'Surbana Jurong',
    'element.com': 'Element',
    'wsp.com': 'WSP',
    'asiainfrasolutions.com': 'Asia Infra Solutions',
    'ccccltd.sg': 'CCCC',
    'bentley.com': 'Bentley',
    'obayashi.com.sg': 'Obayashi',
  };
  
  // Check exact match
  if (mapping[domain]) return mapping[domain];
  
  // Extract company name from domain
  // For domains like: obayashi.com.sg, company.co.uk, firm.com
  // We want: obayashi, company, firm (the part BEFORE the TLD)
  const parts = domain.split('.');
  
  if (parts.length >= 2) {
    // Get the part before TLD
    // If domain is company.com.sg or company.co.uk (2-part TLD), take parts[0]
    // If domain is company.com, take parts[0]
    const name = parts[0];
    
    // Capitalize first letter
    return name.charAt(0).toUpperCase() + name.slice(1);
  }
  
  return '';
}

async function autoFillParty(attId, fromAddr) {
  const domain = fromAddr.split('@')[1];
  if (!domain) {
    toast('Cannot determine domain from sender', 'err');
    return;
  }
  
  const suggested = suggestSourceParty(domain);
  if (!suggested) {
    toast('No suggestion available for ' + domain, 'warn');
    return;
  }
  
  // Fill the input field
  const input = document.getElementById(`party-${attId}`);
  if (input) {
    input.value = suggested;
    // Trigger the onchange to save
    await updateAttachment(attId, 'sourceParty', suggested);
  }
}

async function showTransmittalRegister() {
  const container = document.getElementById('email-list');
  const atts = await dbGetAll('attachments');
  
  // Get email info for each attachment
  const rows = await Promise.all(atts.map(async a => {
    const email = await dbGet('emails', a.emailId);
    return { ...a, email };
  }));
  
  // Sort by date descending
  rows.sort((a, b) => (b.email?.date || '').localeCompare(a.email?.date || ''));
  
  if (!rows.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📋</div>
        <div class="empty-text">No attachments imported yet.</div>
      </div>`;
    return;
  }
  
  // Get unique values for filters
  const parties = [...new Set(rows.map(r => r.sourceParty).filter(Boolean))].sort();
  const types = [...new Set(rows.map(r => r.documentType).filter(Boolean))].sort();
  
  container.innerHTML = `
    <div style="display:flex; flex-direction:column; height:100%;">
      <div style="padding:12px 20px; border-bottom:1px solid var(--border); display:flex; gap:8px; flex-wrap:wrap; background:var(--surface);">
        <input type="text" id="tx-search" class="search-input" placeholder="Search filename, ref..." oninput="filterTransmittalRegister()" style="width:200px;">
        <select id="tx-party" class="btn" onchange="filterTransmittalRegister()" style="width:150px;">
          <option value="">All Parties</option>
          ${parties.map(p => `<option value="${escHtml(p)}">${escHtml(p)}</option>`).join('')}
        </select>
        <select id="tx-type" class="btn" onchange="filterTransmittalRegister()" style="width:150px;">
          <option value="">All Types</option>
          ${types.map(t => `<option value="${escHtml(t)}">${escHtml(t)}</option>`).join('')}
        </select>
        <select id="tx-stored" class="btn" onchange="filterTransmittalRegister()" style="width:120px;">
          <option value="">All Files</option>
          <option value="stored">Stored Only</option>
          <option value="missing">Missing Only</option>
        </select>
        <button class="btn btn-primary" onclick="bulkAutoFillMetadata(false)" style="margin-left:auto;">✨ Auto-fill Empty</button>
        <button class="btn" onclick="bulkAutoFillMetadata(true)" title="Overwrite existing source parties">✨ Force Auto-fill All</button>
        <button class="btn" onclick="bulkExtractAttachmentText()" title="Extract text from all stored attachments that haven't been processed yet">📄 Extract Text</button>
        <button class="btn" onclick="exportTransmittalCSV()">⬇ Export CSV</button>
      </div>
      <div id="tx-table-container" style="overflow:auto; flex:1;"></div>
    </div>
  `;
  
  // Store rows for filtering
  window._txRows = rows;
  
  // Render initial table
  renderTransmittalTable(rows);
}

function filterTransmittalRegister() {
  const search = document.getElementById('tx-search').value.toLowerCase();
  const party = document.getElementById('tx-party').value;
  const type = document.getElementById('tx-type').value;
  const stored = document.getElementById('tx-stored').value;
  
  let filtered = window._txRows.filter(r => {
    // Search filter
    if (search && !(
      (r.filename || '').toLowerCase().includes(search) ||
      (r.transmittalRef || '').toLowerCase().includes(search)
    )) return false;
    
    // Party filter
    if (party && r.sourceParty !== party) return false;
    
    // Type filter
    if (type && r.documentType !== type) return false;
    
    // Stored filter
    if (stored === 'stored' && !r.storedPath) return false;
    if (stored === 'missing' && r.storedPath) return false;
    
    return true;
  });
  
  renderTransmittalTable(filtered);
}

function renderTransmittalTable(rows) {
  const container = document.getElementById('tx-table-container');
  
  if (!rows.length) {
    container.innerHTML = '<div class="empty-state"><div class="empty-text">No attachments match the filter.</div></div>';
    return;
  }
  
  container.innerHTML = `
    <table style="width:100%; border-collapse:collapse; font-size:12px;">
      <thead style="position:sticky; top:0; background:var(--surface); border-bottom:1px solid var(--border2); z-index:1;">
        <tr style="height:34px;">
          <th style="text-align:left; padding:8px; font-family:var(--mono); font-size:10px; letter-spacing:0.08em; color:var(--muted); text-transform:uppercase;">FILE</th>
          <th style="text-align:left; padding:8px; font-family:var(--mono); font-size:10px; letter-spacing:0.08em; color:var(--muted); text-transform:uppercase;">TRANSMITTAL REF</th>
          <th style="text-align:left; padding:8px; font-family:var(--mono); font-size:10px; letter-spacing:0.08em; color:var(--muted); text-transform:uppercase;">SOURCE PARTY</th>
          <th style="text-align:left; padding:8px; font-family:var(--mono); font-size:10px; letter-spacing:0.08em; color:var(--muted); text-transform:uppercase;">TYPE</th>
          <th style="text-align:left; padding:8px; font-family:var(--mono); font-size:10px; letter-spacing:0.08em; color:var(--muted); text-transform:uppercase;">SIZE</th>
          <th style="text-align:left; padding:8px; font-family:var(--mono); font-size:10px; letter-spacing:0.08em; color:var(--muted); text-transform:uppercase;">DATE</th>
          <th style="text-align:left; padding:8px; font-family:var(--mono); font-size:10px; letter-spacing:0.08em; color:var(--muted); text-transform:uppercase;">FROM</th>
          <th style="text-align:center; padding:8px; font-family:var(--mono); font-size:10px; letter-spacing:0.08em; color:var(--muted); text-transform:uppercase;">STORED</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(r => {
          const hasFile = !!r.storedPath;
          const fileIcon = hasFile ? '📎' : '📋';
          const fileAction = hasFile ? `onclick="openAttachmentFromDisk('${r.storedPath}')" style="cursor:pointer; color:var(--accent);"` : '';
          const dateStr = r.email?.date ? formatDate(r.email.date) : '—';
          const from = r.email?.fromName || r.email?.fromAddr || '—';
          
          return `
            <tr style="border-bottom:1px solid var(--border); height:38px;" onmouseover="this.style.background='var(--surface2)'" onmouseout="this.style.background=''">
              <td style="padding:8px; max-width:300px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                <span ${fileAction} title="${escHtml(r.filename)}" style="display:flex; align-items:center; gap:4px;">
                  ${r.isNested ? '<span style="color:var(--muted);margin-right:8px;">↳</span>' : ''}
                  ${fileIcon} ${escHtml(truncate(r.filename, r.isNested ? 35 : 40))}
                  ${r.isNested ? `<span style="color:var(--muted);font-size:10px;margin-left:4px;" title="From: ${escHtml(r.parentFilename)}">(nested)</span>` : ''}
                </span>
              </td>
              <td style="padding:4px;" onclick="editCellInline(this, '${r.id}', 'transmittalRef')" title="Click to edit">
                <div style="padding:4px; cursor:text; min-height:20px; ${!r.transmittalRef ? 'color:var(--muted);' : ''}">
                  ${escHtml(r.transmittalRef || 'Click to edit')}
                </div>
              </td>
              <td style="padding:4px;" onclick="editCellInline(this, '${r.id}', 'sourceParty')" title="Click to edit">
                <div style="padding:4px; cursor:text; min-height:20px; ${!r.sourceParty ? 'color:var(--muted);' : ''}">
                  ${escHtml(r.sourceParty || 'Click to edit')}
                </div>
              </td>
              <td style="padding:4px;" onclick="editCellInline(this, '${r.id}', 'documentType')" title="Click to edit">
                <div style="padding:4px; cursor:text; min-height:20px; ${!r.documentType ? 'color:var(--muted);' : ''}">
                  ${escHtml(r.documentType || 'Click to edit')}
                </div>
              </td>
              <td style="padding:8px; font-family:var(--mono); font-size:11px; color:var(--muted);">
                ${formatSize(r.size)}
              </td>
              <td style="padding:8px; font-family:var(--mono); font-size:11px; color:var(--muted);">
                ${dateStr}
              </td>
              <td style="padding:8px; max-width:180px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escHtml(from)}">
                ${escHtml(truncate(from, 24))}
              </td>
              <td style="padding:8px; text-align:center;">
                ${hasFile ? '<span style="color:var(--accent)">●</span>' : '<span style="color:var(--muted)">○</span>'}
              </td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;
}

function exportTransmittalCSV() {
  const rows = window._txRows;
  if (!rows || !rows.length) {
    toast('No data to export', 'warn');
    return;
  }
  
  // CSV headers
  const headers = ['Filename', 'Transmittal Ref', 'Source Party', 'Document Type', 'Size (bytes)', 'Date', 'From Email', 'From Name', 'Stored Path', 'Hash'];
  
  // CSV rows
  const csvRows = rows.map(r => [
    r.filename,
    r.transmittalRef || '',
    r.sourceParty || '',
    r.documentType || '',
    r.size,
    r.email?.date || '',
    r.email?.fromAddr || '',
    r.email?.fromName || '',
    r.storedPath || '',
    r.hash
  ].map(field => {
    // Escape quotes and wrap in quotes if contains comma
    const str = String(field);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }).join(','));
  
  const csv = [headers.join(','), ...csvRows].join('\n');
  
  // Download
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `transmittal-register-${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  
  toast(`Exported ${rows.length} attachments`, 'ok');
}

function editCellInline(cell, attId, field) {
  // Prevent multiple edits
  if (cell.querySelector('input, select')) return;
  
  const div = cell.querySelector('div');
  const currentValue = div.textContent.trim();
  const value = (currentValue === 'Click to edit' || currentValue === '—') ? '' : currentValue;
  
  // Create input based on field type
  let input;
  if (field === 'documentType') {
    input = document.createElement('select');
    input.className = 'search-input';
    input.style.cssText = 'width:100%; padding:4px; font-size:12px;';
    input.innerHTML = `
      <option value="">—</option>
      <option value="Drawing" ${value === 'Drawing' ? 'selected' : ''}>Drawing</option>
      <option value="Specification" ${value === 'Specification' ? 'selected' : ''}>Specification</option>
      <option value="Report" ${value === 'Report' ? 'selected' : ''}>Report</option>
      <option value="Minutes" ${value === 'Minutes' ? 'selected' : ''}>Minutes</option>
      <option value="RFI" ${value === 'RFI' ? 'selected' : ''}>RFI</option>
      <option value="Submittal" ${value === 'Submittal' ? 'selected' : ''}>Submittal</option>
      <option value="Certificate" ${value === 'Certificate' ? 'selected' : ''}>Certificate</option>
      <option value="Other" ${value === 'Other' ? 'selected' : ''}>Other</option>
    `;
  } else {
    input = document.createElement('input');
    input.type = 'text';
    input.className = 'search-input';
    input.style.cssText = 'width:100%; padding:4px; font-size:12px;';
    input.value = value;
  }
  
  // Replace div with input
  div.style.display = 'none';
  cell.appendChild(input);
  input.focus();
  if (input.select) input.select();
  
  // Save on blur or enter
  const save = async () => {
    const newValue = input.value.trim();
    await updateAttachment(attId, field, newValue);
    
    // Update the row data
    const row = window._txRows.find(r => r.id === attId);
    if (row) row[field] = newValue;
    
    // Refresh the display
    div.textContent = newValue || 'Click to edit';
    div.style.color = newValue ? 'var(--text)' : 'var(--muted)';
    div.style.display = '';
    input.remove();
  };
  
  input.onblur = save;
  input.onkeydown = (e) => {
    if (e.key === 'Enter') save();
    if (e.key === 'Escape') {
      div.style.display = '';
      input.remove();
    }
  };
  
  // For select, save immediately on change
  if (field === 'documentType') {
    input.onchange = save;
  }
}

async function bulkAutoFillMetadata(force = false) {
  const atts = await dbGetAll('attachments');
  
  // Find attachments to fill (empty or all if force)
  const toFill = [];
  for (const att of atts) {
    if (force || !att.sourceParty) {
      const email = await dbGet('emails', att.emailId);
      if (email && email.fromAddr) {
        toFill.push({ att, email });
      }
    }
  }
  
  if (!toFill.length) {
    toast('No attachments to auto-fill', 'warn');
    return;
  }
  
  const proceed = confirm(
    force 
      ? `Force auto-fill source party for ${toFill.length} attachment${toFill.length !== 1 ? 's' : ''}?\n\n` +
        'This will OVERWRITE existing source party values.\n\n' +
        'Use sender email domains to suggest party names.'
      : `Auto-fill source party for ${toFill.length} attachment${toFill.length !== 1 ? 's' : ''} with empty metadata?\n\n` +
        'This will use sender email domains to suggest party names.'
  );
  
  if (!proceed) return;
  
  let filled = 0;
  for (const { att, email } of toFill) {
    const domain = email.fromAddr.split('@')[1];
    const suggested = suggestSourceParty(domain);
    
    if (suggested) {
      att.sourceParty = suggested;
      await dbPut('attachments', att);
      filled++;
    }
  }
  
  toast(`Auto-filled ${filled} attachment${filled !== 1 ? 's' : ''}`, 'ok');
  
  // Refresh the view
  if (currentView === 'transmittals') {
    showTransmittalRegister();
  }
}
