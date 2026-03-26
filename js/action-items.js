// ═══════════════════════════════════════════════════════
//  ACTION ITEMS VIEW
//  Flat list of all structured action items across all
//  emails, filterable by status (open / resolved / deferred).
// ═══════════════════════════════════════════════════════

let _aiViewFilter = 'open'; // 'all' | 'open' | 'resolved' | 'deferred'

function showActionItemsList(filter) {
  if (filter !== undefined) _aiViewFilter = filter;

  // Collect all action items from non-system emails that have been analyzed
  const rows = [];
  for (const email of allEmails) {
    if (email.isSystemEmail) continue;
    for (const item of (email.actionItems || [])) {
      rows.push({ item, email });
    }
  }

  // Counts per status for tab badges
  const counts = { all: rows.length, open: 0, resolved: 0, deferred: 0 };
  for (const { item } of rows) counts[item.status] = (counts[item.status] || 0) + 1;

  // Apply filter
  const visible = _aiViewFilter === 'all'
    ? rows
    : rows.filter(r => r.item.status === _aiViewFilter);

  // Sort: open first, then resolved, then deferred; within status by email date desc
  const ORDER = { open: 0, deferred: 1, resolved: 2 };
  visible.sort((a, b) => {
    const od = (ORDER[a.item.status] ?? 9) - (ORDER[b.item.status] ?? 9);
    if (od !== 0) return od;
    return (b.email.date || '').localeCompare(a.email.date || '');
  });

  const container = document.getElementById('email-list');

  if (rows.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">⚡</div>
        <div class="empty-text">No action items yet.<br>Open an email and click <b>✨ AI Analyze</b> to extract action items.</div>
      </div>`;
    return;
  }

  const tabBtn = (f, label, count) => {
    const active = _aiViewFilter === f ? 'style="background:var(--accent);color:#fff;border-color:var(--accent);"' : '';
    return `<button class="btn" onclick="showActionItemsList('${f}')" ${active}>${label} <span style="opacity:.75">${count}</span></button>`;
  };

  const itemsHtml = visible.length === 0
    ? `<div style="padding:24px; text-align:center; color:var(--muted); font-size:13px;">No ${_aiViewFilter} action items.</div>`
    : visible.map(({ item, email }) => {
        const statusClass = `ai-status-${item.status}`;
        const statusLabel = item.status === 'open' ? '● open' : item.status === 'resolved' ? '✓ resolved' : '⏸ deferred';
        const intentBadge = email.aiIntent
          ? `<span class="intent-badge intent-${email.aiIntent}">${email.aiIntent}</span>`
          : '';
        const dateStr = email.date ? formatDate(email.date) : '—';
        const from    = escHtml(email.fromName || email.fromAddr || '—');
        const subject = escHtml(email.subject || '(no subject)');
        return `
          <div class="ai-view-row" onclick="selectEmail('${email.id}')">
            <div class="ai-view-row-status">
              <span class="${statusClass}">${statusLabel}</span>
            </div>
            <div class="ai-view-row-body">
              <div class="ai-view-row-desc">${escHtml(item.description)}</div>
              <div class="ai-view-row-meta">${intentBadge}${subject} &mdash; ${from} &mdash; ${dateStr}</div>
            </div>
          </div>`;
      }).join('');

  container.innerHTML = `
    <div style="padding:16px 20px 0;">
      <div style="display:flex; gap:6px; flex-wrap:wrap; margin-bottom:16px;">
        ${tabBtn('open',     '● Open',     counts.open)}
        ${tabBtn('deferred', '⏸ Deferred', counts.deferred)}
        ${tabBtn('resolved', '✓ Resolved', counts.resolved)}
        ${tabBtn('all',      'All',         counts.all)}
      </div>
    </div>
    <div class="ai-view-list">${itemsHtml}</div>`;
}

function countOpenActionItems() {
  let n = 0;
  for (const email of allEmails) {
    if (email.isSystemEmail) continue;
    for (const item of (email.actionItems || [])) {
      if (item.status === 'open') n++;
    }
  }
  return n;
}
