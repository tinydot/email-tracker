// ═══════════════════════════════════════════════════════
//  ISSUE MANAGEMENT
// ═══════════════════════════════════════════════════════

async function showIssuesList() {
  const container = document.getElementById('email-list');
  const issues = await dbGetAll('issues');
  
  // Sort by created date descending
  issues.sort((a, b) => (b.createdDate || '').localeCompare(a.createdDate || ''));
  
  if (!issues.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📋</div>
        <div class="empty-text">No issues created yet.</div>
        <button class="btn btn-primary" onclick="createNewIssue()" style="margin-top:16px;">+ Create Issue</button>
      </div>`;
    return;
  }
  
  container.innerHTML = `
    <div style="padding:20px;">
      <button class="btn btn-primary" onclick="createNewIssue()" style="margin-bottom:20px;">+ Create Issue</button>
      <div style="display:flex; flex-direction:column; gap:12px;">
        ${await Promise.all(issues.map(async issue => {
          const linkedCount = issue.linkedEmails?.length || 0;
          const lastEmail = linkedCount > 0 
            ? await dbGet('emails', issue.linkedEmails[issue.linkedEmails.length - 1])
            : null;
          const lastUpdate = lastEmail?.date || issue.createdDate;
          const timeAgo = lastUpdate ? formatTimeAgo(new Date(lastUpdate)) : '';
          
          const statusColor = issue.status === 'resolved' ? 'var(--success)' : 'var(--warn)';
          const statusIcon = issue.status === 'resolved' ? '✓' : '◐';
          
          return `
            <div class="issue-card" onclick="showIssueDetail('${issue.id}')" style="
              padding:16px; 
              background:var(--surface2); 
              border:1px solid var(--border); 
              border-radius:6px; 
              cursor:pointer;
            ">
              <div style="display:flex; align-items:start; gap:12px;">
                <span style="color:${statusColor}; font-size:20px; flex-shrink:0;">${statusIcon}</span>
                <div style="flex:1; min-width:0;">
                  <div style="font-size:15px; font-weight:500; margin-bottom:4px;">${escHtml(issue.title)}</div>
                  <div style="font-size:12px; color:var(--muted);">
                    ${linkedCount} email${linkedCount !== 1 ? 's' : ''} • 
                    Last update: ${timeAgo} • 
                    Status: ${issue.status === 'resolved' ? 'Resolved' : 'Open'}
                  </div>
                </div>
              </div>
            </div>
          `;
        }))}
      </div>
    </div>
  `;
}

function createNewIssue() {
  const container = document.getElementById('email-list');
  container.innerHTML = `
    <div style="padding:20px; max-width:480px;">
      <h2 style="margin:0 0 16px 0; font-size:16px;">New Issue</h2>
      <input id="new-issue-title" type="text" class="search-input" placeholder="Issue title…"
             style="width:100%; margin-bottom:12px; padding:8px 10px; font-size:14px;"
             onkeydown="if(event.key==='Enter') submitNewIssue(); if(event.key==='Escape') switchView('issues');">
      <div style="display:flex; gap:8px;">
        <button class="btn btn-primary" onclick="submitNewIssue()">Create</button>
        <button class="btn" onclick="switchView('issues')">Cancel</button>
      </div>
    </div>`;
  document.getElementById('new-issue-title').focus();
}

async function submitNewIssue() {
  const input = document.getElementById('new-issue-title');
  const title = input ? input.value.trim() : '';
  if (!title) { input && input.focus(); return; }

  const issue = {
    id: 'issue-' + Date.now(),
    title,
    status: 'open',
    createdDate: new Date().toISOString(),
    resolvedDate: null,
    linkedEmails: []
  };

  await dbPut('issues', issue);
  toast('Issue created', 'ok');
  updateNavCounts();
  showIssueDetail(issue.id);
}

async function showIssueDetail(issueId) {
  const issue = await dbGet('issues', issueId);
  if (!issue) return;
  
  // Get all linked emails
  const emails = await Promise.all(
    (issue.linkedEmails || []).map(id => dbGet('emails', id))
  );
  
  // Sort by date
  emails.sort((a, b) => (a?.date || '').localeCompare(b?.date || ''));
  
  const container = document.getElementById('email-list');
  container.innerHTML = `
    <div style="padding:20px;">
      <div style="margin-bottom:20px;">
        <button class="btn" onclick="switchView('issues')" style="margin-bottom:12px;">← Back to Issues</button>
        
        <div style="display:flex; align-items:center; gap:12px; margin-bottom:12px;">
          <h2 style="margin:0; flex:1;">${escHtml(issue.title)}</h2>
          ${issue.status === 'resolved' 
            ? `<button class="btn" onclick="updateIssueStatus('${issue.id}', 'open')">Reopen</button>`
            : `<button class="btn btn-primary" onclick="updateIssueStatus('${issue.id}', 'resolved')">✓ Mark Resolved</button>`
          }
          <button class="btn btn-danger" onclick="deleteIssue('${issue.id}')">Delete</button>
        </div>
        
        <div style="font-size:12px; color:var(--muted);">
          Status: <strong>${issue.status === 'resolved' ? 'Resolved' : 'Open'}</strong> • 
          Created: ${formatDate(issue.createdDate)} •
          ${issue.resolvedDate ? `Resolved: ${formatDate(issue.resolvedDate)}` : ''}
          ${emails.length} linked email${emails.length !== 1 ? 's' : ''}
        </div>
      </div>
      
      <div style="border-top:1px solid var(--border); padding-top:20px;">
        <div style="display:flex; align-items:center; margin-bottom:12px;">
          <h3 style="font-size:14px; margin:0; flex:1; text-transform:uppercase; letter-spacing:0.05em; color:var(--muted);">Timeline</h3>
          <button class="btn" onclick="showLinkEmailModal('${issue.id}')" style="font-size:11px;">+ Link Email</button>
        </div>

        ${emails.length === 0
          ? '<div style="color:var(--muted); font-style:italic;">No emails linked yet</div>'
          : emails.map(email => {
            if (!email) return '';
            const ALLOWED_TYPES = new Set(['query', 'decision', 'risk', 'action']);
            const safeType = ALLOWED_TYPES.has(email.emailType) ? email.emailType : '';
            const typeLabel = safeType
              ? `<span class="email-type-badge ${safeType}">${safeType}</span>`
              : '';
            const attachIcon = email.attachmentCount > 0 ? ` 📎 ${email.attachmentCount}` : '';
            
            return `
              <div onclick="selectEmailFromIssue('${email.id}')" style="
                padding:12px; 
                background:var(--surface); 
                border:1px solid var(--border); 
                border-radius:4px; 
                margin-bottom:8px;
                cursor:pointer;
              " onmouseover="this.style.background='var(--surface2)'" onmouseout="this.style.background='var(--surface)'">
                <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
                  <span style="font-size:11px; color:var(--muted);">${formatDate(email.date)}</span>
                  ${typeLabel}
                  <span style="flex:1"></span>
                  <button class="btn" onclick="event.stopPropagation(); unlinkEmailFromIssue('${issue.id}', '${email.id}')" style="padding:2px 6px; font-size:10px;">Unlink</button>
                </div>
                <div style="font-weight:500; margin-bottom:2px;">${escHtml(email.subject)}</div>
                <div style="font-size:12px; color:var(--muted);">From: ${escHtml(email.fromName || email.fromAddr)}${attachIcon}</div>
              </div>
            `;
          }).join('')
        }
      </div>
    </div>
  `;
  
  // Add CSS for email type badges if not already present
  if (!document.getElementById('email-type-badges-css')) {
    const style = document.createElement('style');
    style.id = 'email-type-badges-css';
    style.textContent = `
      .email-type-badge {
        font-size: 10px;
        padding: 2px 6px;
        border-radius: 3px;
        font-weight: 500;
        text-transform: uppercase;
      }
      .email-type-badge.query { background: var(--info); color: white; }
      .email-type-badge.decision { background: var(--accent); color: white; }
      .email-type-badge.risk { background: var(--danger); color: white; }
      .email-type-badge.action { background: var(--warn); color: white; }
    `;
    document.head.appendChild(style);
  }
}

async function showLinkEmailModal(issueId) {
  const issue = await dbGet('issues', issueId);
  if (!issue) return;

  const allEmails = await dbGetAll('emails');
  const linked = new Set(issue.linkedEmails || []);
  const candidates = allEmails
    .filter(e => !linked.has(e.id))
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  // Remove any existing modal
  const existing = document.getElementById('link-email-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'link-email-modal';
  modal.style.cssText = `
    position:fixed; inset:0; background:rgba(0,0,0,0.4);
    display:flex; align-items:center; justify-content:center; z-index:1000;
  `;

  const renderRows = (filter) => {
    const filtered = candidates.filter(e =>
      !filter ||
      (e.subject || '').toLowerCase().includes(filter) ||
      (e.fromName || '').toLowerCase().includes(filter) ||
      (e.fromAddr || '').toLowerCase().includes(filter)
    );
    if (filtered.length === 0) {
      return '<div style="color:var(--muted); font-style:italic; padding:12px;">No emails match</div>';
    }
    return filtered.map(e => `
      <div onclick="linkEmailFromModal('${issueId}', '${e.id}')" style="
        padding:10px 12px; cursor:pointer; border-bottom:1px solid var(--border);
      " onmouseover="this.style.background='var(--surface2)'" onmouseout="this.style.background=''">
        <div style="font-weight:500; font-size:13px;">${escHtml(e.subject || '(no subject)')}</div>
        <div style="font-size:11px; color:var(--muted);">
          ${escHtml(e.fromName || e.fromAddr)} &nbsp;·&nbsp; ${formatDate(e.date)}
        </div>
      </div>
    `).join('');
  };

  modal.innerHTML = `
    <div style="
      background:var(--surface); border:1px solid var(--border2); border-radius:6px;
      width:540px; max-height:70vh; display:flex; flex-direction:column;
    ">
      <div style="padding:16px; border-bottom:1px solid var(--border); display:flex; align-items:center; gap:12px;">
        <span style="font-weight:600; flex:1;">Link email to: ${escHtml(issue.title)}</span>
        <button class="btn" onclick="document.getElementById('link-email-modal').remove()">✕</button>
      </div>
      <div style="padding:12px; border-bottom:1px solid var(--border);">
        <input id="link-email-search" class="search-input" placeholder="Filter by subject or sender…" style="width:100%;">
      </div>
      <div id="link-email-rows" style="overflow-y:auto; flex:1;">
        ${renderRows('')}
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // Wire up search after mount
  modal.querySelector('#link-email-search').addEventListener('input', function() {
    document.getElementById('link-email-rows').innerHTML = renderRows(this.value.toLowerCase());
  });

  // Close on backdrop click
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

async function linkEmailFromModal(issueId, emailId) {
  const [issue, email] = await Promise.all([dbGet('issues', issueId), dbGet('emails', emailId)]);
  if (!issue || !email) return;

  if (!issue.linkedEmails) issue.linkedEmails = [];
  if (!issue.linkedEmails.includes(emailId)) {
    issue.linkedEmails.push(emailId);
    await dbPut('issues', issue);
  }

  if (!email.linkedIssues) email.linkedIssues = [];
  if (!email.linkedIssues.includes(issueId)) {
    email.linkedIssues.push(issueId);
    await dbPut('emails', email);
  }

  const modal = document.getElementById('link-email-modal');
  if (modal) modal.remove();

  toast('Email linked to issue', 'ok');
  showIssueDetail(issueId);
}

async function updateIssueStatus(issueId, newStatus) {
  const issue = await dbGet('issues', issueId);
  if (!issue) return;
  
  issue.status = newStatus;
  if (newStatus === 'resolved') {
    issue.resolvedDate = new Date().toISOString();
  } else {
    issue.resolvedDate = null;
  }
  
  await dbPut('issues', issue);
  toast(`Issue ${newStatus}`, 'ok');
  updateNavCounts();
  showIssueDetail(issueId);
}

async function deleteIssue(issueId) {
  if (!confirm('Delete this issue? (Emails will not be deleted)')) return;
  
  // Unlink from all emails
  const issue = await dbGet('issues', issueId);
  if (issue && issue.linkedEmails) {
    for (const emailId of issue.linkedEmails) {
      const email = await dbGet('emails', emailId);
      if (email && email.linkedIssues) {
        email.linkedIssues = email.linkedIssues.filter(id => id !== issueId);
        await dbPut('emails', email);
      }
    }
  }
  
  await dbDelete('issues', issueId);
  toast('Issue deleted', 'ok');
  updateNavCounts();
  switchView('issues');
}

async function unlinkEmailFromIssue(issueId, emailId) {
  const issue = await dbGet('issues', issueId);
  const email = await dbGet('emails', emailId);
  
  if (issue && issue.linkedEmails) {
    issue.linkedEmails = issue.linkedEmails.filter(id => id !== emailId);
    await dbPut('issues', issue);
  }
  
  if (email && email.linkedIssues) {
    email.linkedIssues = email.linkedIssues.filter(id => id !== issueId);
    await dbPut('emails', email);
  }
  
  toast('Email unlinked', 'ok');
  showIssueDetail(issueId);
}

async function selectEmailFromIssue(emailId) {
  // Switch to all emails view and select this email
  currentView = 'all';
  await selectEmail(emailId);
  showPanel('list');
  applyFilters();
}

function formatTimeAgo(date) {
  const now = new Date();
  const diff = now - date;
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
  if (days < 365) return `${Math.floor(days / 30)} months ago`;
  return `${Math.floor(days / 365)} years ago`;
}
