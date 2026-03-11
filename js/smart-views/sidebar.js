// ═══════════════════════════════════════════════════════
//  SMART VIEWS — Sidebar & sub-view tabs
//  Renders the smart views nav list, the Emails/Attachments
//  tab toggle, and the attachments sub-view table.
// ═══════════════════════════════════════════════════════

function renderSvTabToggle() {
  const el = document.getElementById('sv-tab-toggle');
  if (!el) return;
  el.style.display = 'flex';
  el.className = 'sv-tab-toggle';
  el.innerHTML = `
    <button class="sv-tab-btn${svSubView === 'emails' ? ' active' : ''}" onclick="setSvSubView('emails')">Emails</button>
    <button class="sv-tab-btn${svSubView === 'attachments' ? ' active' : ''}" onclick="setSvSubView('attachments')">Attachments</button>
  `;
}

function hideSvTabToggle() {
  const el = document.getElementById('sv-tab-toggle');
  if (el) el.style.display = 'none';
}

function setSvSubView(sub) {
  svSubView = sub;
  renderSvTabToggle();
  const header = document.querySelector('.email-list-header');
  if (sub === 'attachments') {
    if (header) header.style.display = 'none';
    document.getElementById('bulk-tag-bar').style.display = 'none';
    showSvAttachments();
  } else {
    if (header) header.style.display = '';
    applyFilters(); // rebuilds filteredEmails and calls renderEmailList + refreshBulkTagBar
  }
}

async function showSvAttachments() {
  const container = document.getElementById('email-list');
  container.innerHTML = '<div style="padding:20px; color:var(--muted); font-size:12px;">Loading attachments…</div>';

  const emailIds = new Set(filteredEmails.map(e => e.id));
  const allAtts = await dbGetAll('attachments');
  const atts = allAtts.filter(a => emailIds.has(a.emailId));

  const emailMap = new Map(filteredEmails.map(e => [e.id, e]));
  const rows = atts.map(a => ({ ...a, email: emailMap.get(a.emailId) }));
  rows.sort((a, b) => (b.email?.date || '').localeCompare(a.email?.date || ''));

  if (!rows.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📎</div>
        <div class="empty-text">No attachments in the filtered emails.</div>
      </div>`;
    return;
  }

  container.innerHTML = `
    <table style="width:100%; border-collapse:collapse; font-size:12px;">
      <thead style="position:sticky; top:0; background:var(--surface); border-bottom:1px solid var(--border2); z-index:1;">
        <tr style="height:34px;">
          <th style="text-align:left; padding:8px; font-family:var(--mono); font-size:10px; letter-spacing:0.08em; color:var(--muted); text-transform:uppercase;">File</th>
          <th style="text-align:left; padding:8px; font-family:var(--mono); font-size:10px; letter-spacing:0.08em; color:var(--muted); text-transform:uppercase;">Subject</th>
          <th style="text-align:left; padding:8px; font-family:var(--mono); font-size:10px; letter-spacing:0.08em; color:var(--muted); text-transform:uppercase;">From</th>
          <th style="text-align:left; padding:8px; font-family:var(--mono); font-size:10px; letter-spacing:0.08em; color:var(--muted); text-transform:uppercase;">Date</th>
          <th style="text-align:left; padding:8px; font-family:var(--mono); font-size:10px; letter-spacing:0.08em; color:var(--muted); text-transform:uppercase;">Size</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(r => {
          const hasFile = !!r.storedPath;
          const fileIcon = hasFile ? '📎' : '📋';
          const fileAction = hasFile ? `onclick="openAttachmentFromDisk('${escHtml(r.storedPath)}')" style="cursor:pointer; color:var(--accent);"` : '';
          const dateStr = r.email?.date ? formatDate(r.email.date) : '—';
          const from = r.email?.fromName || r.email?.fromAddr || '—';
          const subject = r.email?.subject || '—';
          const emailId = r.email?.id ? escHtml(r.email.id) : '';
          const subjectTrunc = subject.length > 45 ? subject.slice(0, 45) + '…' : subject;
          return `
            <tr style="border-bottom:1px solid var(--border); height:38px;"
                onmouseover="this.style.background='var(--surface2)'"
                onmouseout="this.style.background=''">
              <td style="padding:8px; max-width:220px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                <span ${fileAction} title="${escHtml(r.filename)}" style="display:flex; align-items:center; gap:4px;">
                  ${fileIcon} ${escHtml(r.filename)}
                </span>
              </td>
              <td style="padding:8px; max-width:240px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                ${emailId
                  ? `<a href="#" onclick="selectEmail('${emailId}');return false;" style="color:var(--accent); text-decoration:none;" title="${escHtml(subject)}">${escHtml(subjectTrunc)}</a>`
                  : escHtml(subjectTrunc)}
              </td>
              <td style="padding:8px; max-width:160px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--muted);">
                ${escHtml(from)}
              </td>
              <td style="padding:8px; font-family:var(--mono); font-size:11px; color:var(--muted); white-space:nowrap;">
                ${dateStr}
              </td>
              <td style="padding:8px; font-family:var(--mono); font-size:11px; color:var(--muted); white-space:nowrap;">
                ${formatSize(r.size)}
              </td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}

function renderSmartViewsSidebar() {
  const container = document.getElementById('smart-views-nav');
  if (!container) return;
  if (!smartViews.length) {
    container.innerHTML = '<div style="padding:4px 8px 4px 16px; font-size:11px; color:var(--muted); font-style:italic;">No smart views yet</div>';
    return;
  }
  container.innerHTML = [...smartViews].sort((a, b) => a.name.localeCompare(b.name)).map(sv => {
    const count   = allEmails.filter(e => applySmartViewRules(e, sv)).length;
    const isActive = currentView === 'sv-' + sv.id;
    return `
      <button class="nav-item ${isActive ? 'active' : ''}" data-view="sv-${escHtml(sv.id)}"
              onclick="switchView('sv-${escHtml(sv.id)}')"
              oncontextmenu="event.preventDefault(); showSmartViewEditor('${escHtml(sv.id)}')"
              title="Right-click to edit">
        ${escHtml(sv.icon || '🔍')} ${escHtml(sv.name)}
        <span class="nav-count">${count}</span>
      </button>`;
  }).join('');
}
