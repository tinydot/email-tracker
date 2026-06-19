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
    showSvAttachments();
  } else {
    if (header) header.style.display = '';
    applyFilters(); // rebuilds filteredEmails and calls renderEmailList
  }
}

let _svThumbUrls = [];
let _svAttachmentRows = [];

async function showSvAttachments() {
  // Revoke any previous thumbnail blob URLs
  for (const url of _svThumbUrls) URL.revokeObjectURL(url);
  _svThumbUrls = [];

  const container = document.getElementById('email-list');
  container.innerHTML = '<div style="padding:20px; color:var(--muted); font-size:12px;">Loading attachments…</div>';

  const emailIds = new Set(filteredEmails.map(e => e.id));
  const allAtts = await dbGetAll('attachments');
  const atts = allAtts.filter(a => emailIds.has(a.emailId) && !a.isBlacklisted);

  const emailMap = new Map(filteredEmails.map(e => [e.id, e]));
  const rawRows = atts.map(a => ({ ...a, email: emailMap.get(a.emailId) }));
  rawRows.sort((a, b) => (b.email?.date || '').localeCompare(a.email?.date || ''));

  if (!rawRows.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📎</div>
        <div class="empty-text">No attachments in the filtered emails.</div>
      </div>`;
    return;
  }

  const rows = deduplicateAttachmentsByHash(rawRows);
  _svAttachmentRows = rows;

  container.innerHTML = `
    <div style="display:flex; flex-direction:column; height:100%;">
      <div style="padding:8px 12px; border-bottom:1px solid var(--border); display:flex; gap:8px; align-items:center; background:var(--surface); flex-shrink:0;">
        <span style="font-size:12px; color:var(--muted);">${rows.length} attachment${rows.length !== 1 ? 's' : ''}</span>
        <button onclick="exportSvAttachmentsCsv()" style="margin-left:auto; font-size:11px; padding:4px 10px; cursor:pointer; background:var(--surface2); border:1px solid var(--border2); border-radius:4px; color:var(--text);" title="Export this table to CSV">⬇ Export CSV</button>
      </div>
      <div style="overflow:auto; flex:1;">
    <table style="width:100%; border-collapse:collapse; font-size:12px;">
      <thead style="position:sticky; top:0; background:var(--surface); border-bottom:1px solid var(--border2); z-index:1;">
        <tr style="height:34px;">
          <th style="text-align:left; padding:8px; font-family:var(--mono); font-size:10px; letter-spacing:0.08em; color:var(--muted); text-transform:uppercase;">File</th>
          <th style="text-align:left; padding:8px; font-family:var(--mono); font-size:10px; letter-spacing:0.08em; color:var(--muted); text-transform:uppercase;">Subject</th>
          <th style="text-align:left; padding:8px; font-family:var(--mono); font-size:10px; letter-spacing:0.08em; color:var(--muted); text-transform:uppercase;">Size</th>
          <th style="text-align:left; padding:8px; font-family:var(--mono); font-size:10px; letter-spacing:0.08em; color:var(--muted); text-transform:uppercase;">Date</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(r => {
          const hasFile = !!r.storedPath;
          const isImage = r.contentType && r.contentType.startsWith('image/');
          const fileIcon = isImage ? '🖼' : (hasFile ? '📎' : '📋');
          const fileAction = hasFile ? `onclick="openAttachmentFromDisk('${escHtml(r.storedPath)}')" style="cursor:pointer; color:var(--accent);"` : '';
          const thumbHtml = isImage && hasFile
            ? `<img data-thumb="${escHtml(r.storedPath)}" style="width:36px;height:36px;object-fit:cover;border-radius:3px;border:1px solid var(--border2);flex-shrink:0;background:var(--surface2);" alt="">`
            : '';
          const dupCount = r._allEmails ? r._allEmails.length : 1;
          // Show earliest date across all duplicate emails
          const allDates = (r._allEmails || [r.email]).map(e => e?.date).filter(Boolean).sort();
          const dateStr = allDates.length ? formatDate(allDates[0]) : '—';
          const subject = r.email?.subject || '—';
          const emailId = r.email?.id ? escHtml(r.email.id) : '';
          const subjectTrunc = subject.length > 45 ? subject.slice(0, 45) + '…' : subject;
          // For subject cell: if multiple emails, show count instead of link
          const subjectTitle = dupCount > 1
            ? (r._allEmails || []).map(e => e?.subject || '?').join('\n')
            : subject;
          const subjectDisplay = dupCount > 1
            ? `<span style="color:var(--muted);" title="${escHtml(subjectTitle)}">${dupCount} emails</span>`
            : (emailId
                ? `<a href="#" onclick="selectEmail('${emailId}');return false;" style="color:var(--accent); text-decoration:none;" title="${escHtml(subject)}">${escHtml(subjectTrunc)}</a>`
                : escHtml(subjectTrunc));
          return `
            <tr style="border-bottom:1px solid var(--border); height:38px;"
                onmouseover="this.style.background='var(--surface2)'"
                onmouseout="this.style.background=''">
              <td style="padding:6px 8px; max-width:220px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                <span ${fileAction} title="${escHtml(r.filename)}" style="display:flex; align-items:center; gap:6px;">
                  ${thumbHtml || fileIcon} <span style="overflow:hidden; text-overflow:ellipsis;">${escHtml(r.filename)}</span>
                  ${dupCount > 1 ? `<span style="background:var(--surface2);border:1px solid var(--border2);border-radius:3px;padding:1px 5px;font-size:10px;color:var(--muted);margin-left:4px;white-space:nowrap;" title="${dupCount} emails contain this file">${dupCount}×</span>` : ''}
                </span>
              </td>
              <td style="padding:8px; max-width:240px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                ${subjectDisplay}
              </td>
              <td style="padding:8px; font-family:var(--mono); font-size:11px; color:var(--muted); white-space:nowrap;">
                ${formatSize(r.size)}
              </td>
              <td style="padding:8px; font-family:var(--mono); font-size:11px; color:var(--muted); white-space:nowrap;">
                ${dateStr}
              </td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>
      </div>
    </div>`;

  // Asynchronously load image thumbnails
  _loadSvThumbnails(container);
}

function _csvCell(val) {
  const s = (val == null ? '' : String(val));
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function exportSvAttachmentsCsv() {
  const rows = _svAttachmentRows;
  if (!rows || !rows.length) {
    toast('No attachments to export', 'warn');
    return;
  }

  const header = ['File', 'Subject', 'Sender Domain', 'Size (KB)', 'Date'];
  const lines = [header.map(_csvCell).join(',')];

  for (const r of rows) {
    const emails = r._allEmails || [r.email];
    const subjects = [...new Set(emails.map(e => e?.subject).filter(Boolean))].join(' | ');
    const domains = [...new Set(emails.map(e => ((e?.fromAddr || '').split('@')[1] || '').toLowerCase()).filter(Boolean))].join(' | ');
    const allDates = emails.map(e => e?.date).filter(Boolean).sort();
    const dateStr = allDates.length ? formatDate(allDates[0]) : '';
    const sizeKb = r.size ? (r.size / 1024).toFixed(1) : '';
    lines.push([
      r.filename,
      subjects,
      domains,
      sizeKb,
      dateStr,
    ].map(_csvCell).join(','));
  }

  const csv = '﻿' + lines.join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const svName = (smartViews.find(s => 'sv-' + s.id === currentView)?.name || 'attachments')
    .replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'attachments';
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `transmittal-${svName}-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast(`Exported ${rows.length} attachment${rows.length !== 1 ? 's' : ''} to CSV`, 'ok');
}

async function _loadSvThumbnails(container) {
  const imgs = container.querySelectorAll('img[data-thumb]');
  for (const img of imgs) {
    const file = await getAttachmentFileObject(img.dataset.thumb);
    if (file) {
      const url = URL.createObjectURL(file);
      _svThumbUrls.push(url);
      img.src = url;
    } else {
      img.style.display = 'none';
    }
  }
}

function renderSmartViewsSidebar() {
  const container = document.getElementById('smart-views-nav');
  if (!container) return;
  if (!smartViews.length) {
    container.innerHTML = '<div style="padding:4px 8px 4px 16px; font-size:11px; color:var(--muted); font-style:italic;">No smart views yet</div>';
    return;
  }
  container.innerHTML = [...smartViews].sort((a, b) => a.name.localeCompare(b.name)).map(sv => {
    // Check the cheap unread test first — skips rule evaluation for most emails
    const count   = allEmails.filter(e => e.status === 'unread' && applySmartViewRules(e, sv)).length;
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
