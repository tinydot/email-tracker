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
    <button class="sv-tab-btn${svSubView === 'links' ? ' active' : ''}" onclick="setSvSubView('links')">Links</button>
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
  } else if (sub === 'links') {
    if (header) header.style.display = 'none';
    showSvLinks();
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

// ── Download / file-transfer links sub-view ──────────────
// Known external file-transfer / cloud-storage services. A link matching one of
// these is almost certainly a file exchange that won't show up in attachments.
const FILE_TRANSFER_HOSTS = [
  { re: /(^|\.)wetransfer\.com$|(^|\.)we\.tl$/i,            name: 'WeTransfer' },
  { re: /(^|\.)dropbox\.com$|(^|\.)db\.tt$/i,              name: 'Dropbox' },
  { re: /(^|\.)drive\.google\.com$|(^|\.)docs\.google\.com$/i, name: 'Google Drive' },
  { re: /(^|\.)onedrive\.live\.com$|(^|\.)1drv\.ms$/i,     name: 'OneDrive' },
  { re: /(^|\.)sharepoint\.com$/i,                          name: 'SharePoint' },
  { re: /(^|\.)box\.com$/i,                                 name: 'Box' },
  { re: /(^|\.)mega\.nz$|(^|\.)mega\.io$/i,                name: 'MEGA' },
  { re: /(^|\.)mediafire\.com$/i,                           name: 'MediaFire' },
  { re: /(^|\.)hightail\.com$/i,                            name: 'Hightail' },
  { re: /(^|\.)sharefile\.com$/i,                           name: 'ShareFile' },
  { re: /(^|\.)fromsmash\.com$|(^|\.)smash\.io$/i,         name: 'Smash' },
  { re: /(^|\.)filemail\.com$/i,                            name: 'Filemail' },
  { re: /(^|\.)swisstransfer\.com$/i,                       name: 'SwissTransfer' },
  { re: /(^|\.)sendgb\.com$/i,                              name: 'SendGB' },
  { re: /(^|\.)jumbomail\.me$/i,                            name: 'JumboMail' },
  { re: /(^|\.)pcloud\.com$|(^|\.)pc\.cd$/i,               name: 'pCloud' },
  { re: /(^|\.)transfernow\.net$/i,                         name: 'TransferNow' },
  { re: /(^|\.)icloud\.com$/i,                              name: 'iCloud' },
  { re: /(^|\.)4shared\.com$/i,                             name: '4shared' },
  { re: /(^|\.)egnyte\.com$/i,                              name: 'Egnyte' },
  { re: /(^|\.)tresorit\.com$/i,                            name: 'Tresorit' },
  { re: /(^|\.)sync\.com$/i,                                name: 'Sync.com' },
  { re: /faspex|(^|\.)asperasoft\.com$/i,                   name: 'Aspera' },
  { re: /(^|\.)citrixfiles\.com$/i,                         name: 'Citrix Files' },
];

// Generic hints that a link is a download even if the host isn't a known service.
const DOWNLOAD_HINT_RE = /\/(download|share|shared|files?|folder|d|s|get)\/|\.(zip|rar|7z|tar|gz|pdf|dwg|rvt|ifc|xlsx?|docx?|pptx?)(\?|$)/i;

const _URL_RE = /\bhttps?:\/\/[^\s<>"'()\[\]]+/gi;

// Extract clean http(s) URLs from a body of text.
function extractLinksFromText(text) {
  if (!text) return [];
  const out = [];
  const matches = text.match(_URL_RE);
  if (!matches) return out;
  for (let url of matches) {
    // Strip trailing punctuation that commonly clings to a URL in prose.
    url = url.replace(/[.,;:!?'"»>)\]}]+$/, '');
    if (url.length > 4) out.push(url);
  }
  return out;
}

// Classify a URL → { host, service, isFileTransfer }
function classifyLink(url) {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch (e) { host = ''; }
  for (const h of FILE_TRANSFER_HOSTS) {
    if (h.re.test(host)) return { host, service: h.name, isFileTransfer: true };
  }
  if (DOWNLOAD_HINT_RE.test(url)) return { host, service: 'Download?', isFileTransfer: true };
  return { host, service: '', isFileTransfer: false };
}

let _svLinkRows = [];
let _svLinksTransfersOnly = true;

function setSvLinksFilter(transfersOnly) {
  _svLinksTransfersOnly = transfersOnly;
  showSvLinks();
}

async function showSvLinks() {
  const container = document.getElementById('email-list');

  // Build link rows from the filtered emails' (truncated) bodies, deduped by URL.
  const byUrl = new Map();
  for (const email of filteredEmails) {
    const urls = extractLinksFromText(email.textBody);
    const seenInEmail = new Set();
    for (const url of urls) {
      const key = url.toLowerCase();
      if (seenInEmail.has(key)) continue; // count an email once per distinct URL
      seenInEmail.add(key);
      if (!byUrl.has(key)) {
        byUrl.set(key, { url, ...classifyLink(url), _emails: [email] });
      } else {
        byUrl.get(key)._emails.push(email);
      }
    }
  }

  let rows = [...byUrl.values()];
  if (_svLinksTransfersOnly) rows = rows.filter(r => r.isFileTransfer);
  // File-transfer links first, then by most-recent email date.
  rows.sort((a, b) => {
    if (a.isFileTransfer !== b.isFileTransfer) return a.isFileTransfer ? -1 : 1;
    const da = a._emails.map(e => e?.date || '').sort().pop() || '';
    const db = b._emails.map(e => e?.date || '').sort().pop() || '';
    return db.localeCompare(da);
  });
  _svLinkRows = rows;

  const toolbar = `
    <div style="padding:8px 12px; border-bottom:1px solid var(--border); display:flex; gap:8px; align-items:center; background:var(--surface); flex-shrink:0;">
      <span style="font-size:12px; color:var(--muted);">${rows.length} link${rows.length !== 1 ? 's' : ''}</span>
      <label style="font-size:11px; color:var(--muted); display:flex; align-items:center; gap:5px; cursor:pointer; margin-left:12px;">
        <input type="checkbox" ${_svLinksTransfersOnly ? 'checked' : ''} onchange="setSvLinksFilter(this.checked)" style="cursor:pointer;">
        File transfers only
      </label>
      <button onclick="exportSvLinksCsv()" style="margin-left:auto; font-size:11px; padding:4px 10px; cursor:pointer; background:var(--surface2); border:1px solid var(--border2); border-radius:4px; color:var(--text);" title="Export this table to CSV">⬇ Export CSV</button>
    </div>`;

  if (!rows.length) {
    container.innerHTML = `
      <div style="display:flex; flex-direction:column; height:100%;">
        ${toolbar}
        <div class="empty-state">
          <div class="empty-icon">🔗</div>
          <div class="empty-text">${_svLinksTransfersOnly ? 'No file-transfer links found in the filtered emails.' : 'No links found in the filtered emails.'}</div>
        </div>
      </div>`;
    return;
  }

  container.innerHTML = `
    <div style="display:flex; flex-direction:column; height:100%;">
      ${toolbar}
      <div style="overflow:auto; flex:1;">
    <table style="width:100%; border-collapse:collapse; font-size:12px;">
      <thead style="position:sticky; top:0; background:var(--surface); border-bottom:1px solid var(--border2); z-index:1;">
        <tr style="height:34px;">
          <th style="text-align:left; padding:8px; font-family:var(--mono); font-size:10px; letter-spacing:0.08em; color:var(--muted); text-transform:uppercase;">Link</th>
          <th style="text-align:left; padding:8px; font-family:var(--mono); font-size:10px; letter-spacing:0.08em; color:var(--muted); text-transform:uppercase;">Service</th>
          <th style="text-align:left; padding:8px; font-family:var(--mono); font-size:10px; letter-spacing:0.08em; color:var(--muted); text-transform:uppercase;">Subject</th>
          <th style="text-align:left; padding:8px; font-family:var(--mono); font-size:10px; letter-spacing:0.08em; color:var(--muted); text-transform:uppercase;">Date</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(r => {
          const dupCount = r._emails.length;
          const allDates = r._emails.map(e => e?.date).filter(Boolean).sort();
          const dateStr = allDates.length ? formatDate(allDates[allDates.length - 1]) : '—';
          const firstEmail = r._emails[0];
          const subject = firstEmail?.subject || '—';
          const subjectTrunc = subject.length > 45 ? subject.slice(0, 45) + '…' : subject;
          const emailId = firstEmail?.id ? escHtml(firstEmail.id) : '';
          const subjectTitle = dupCount > 1
            ? r._emails.map(e => e?.subject || '?').join('\n')
            : subject;
          const subjectDisplay = dupCount > 1
            ? `<span style="color:var(--muted);" title="${escHtml(subjectTitle)}">${dupCount} emails</span>`
            : (emailId
                ? `<a href="#" onclick="selectEmail('${emailId}');return false;" style="color:var(--accent); text-decoration:none;" title="${escHtml(subject)}">${escHtml(subjectTrunc)}</a>`
                : escHtml(subjectTrunc));
          const urlTrunc = r.url.length > 60 ? r.url.slice(0, 60) + '…' : r.url;
          const serviceBadge = r.service
            ? `<span style="background:${r.isFileTransfer && r.service !== 'Download?' ? 'var(--accent)' : 'var(--surface2)'}; color:${r.isFileTransfer && r.service !== 'Download?' ? '#fff' : 'var(--muted)'}; border:1px solid var(--border2); border-radius:3px; padding:1px 6px; font-size:10px; white-space:nowrap;">${escHtml(r.service)}</span>`
            : `<span style="color:var(--muted); font-size:11px;">${escHtml(r.host || '—')}</span>`;
          return `
            <tr style="border-bottom:1px solid var(--border); height:38px;"
                onmouseover="this.style.background='var(--surface2)'"
                onmouseout="this.style.background=''">
              <td style="padding:6px 8px; max-width:340px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                <a href="${escHtml(r.url)}" target="_blank" rel="noopener noreferrer" title="${escHtml(r.url)}" style="display:flex; align-items:center; gap:6px; color:var(--accent); text-decoration:none;">
                  🔗 <span style="overflow:hidden; text-overflow:ellipsis;">${escHtml(urlTrunc)}</span>
                  ${dupCount > 1 ? `<span style="background:var(--surface2);border:1px solid var(--border2);border-radius:3px;padding:1px 5px;font-size:10px;color:var(--muted);margin-left:4px;white-space:nowrap;" title="${dupCount} emails contain this link">${dupCount}×</span>` : ''}
                </a>
              </td>
              <td style="padding:8px; white-space:nowrap;">
                ${serviceBadge}
              </td>
              <td style="padding:8px; max-width:240px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                ${subjectDisplay}
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
}

function exportSvLinksCsv() {
  const rows = _svLinkRows;
  if (!rows || !rows.length) {
    toast('No links to export', 'warn');
    return;
  }

  const header = ['Link', 'Service', 'Host', 'Subject', 'Sender Domain', 'Date'];
  const lines = [header.map(_csvCell).join(',')];

  for (const r of rows) {
    const subjects = [...new Set(r._emails.map(e => e?.subject).filter(Boolean))].join(' | ');
    const domains = [...new Set(r._emails.map(e => ((e?.fromAddr || '').split('@')[1] || '').toLowerCase()).filter(Boolean))].join(' | ');
    const allDates = r._emails.map(e => e?.date).filter(Boolean).sort();
    const dateStr = allDates.length ? formatDate(allDates[allDates.length - 1]) : '';
    lines.push([
      r.url,
      r.service || '',
      r.host || '',
      subjects,
      domains,
      dateStr,
    ].map(_csvCell).join(','));
  }

  const csv = '﻿' + lines.join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const svName = (smartViews.find(s => 'sv-' + s.id === currentView)?.name || 'links')
    .replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'links';
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `links-${svName}-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast(`Exported ${rows.length} link${rows.length !== 1 ? 's' : ''} to CSV`, 'ok');
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
