// ═══════════════════════════════════════════════════════
//  DASHBOARD
//  Email volume over time — bar chart of counts per day/week/
//  month across the full date range, including empty buckets
//  so gaps (potential missed imports) stand out.
// ═══════════════════════════════════════════════════════

let dashboardGranularity = 'day'; // 'day' | 'week' | 'month'

// ── Date bucketing helpers ─────────────────────────────

// Local-time date key for a given granularity.
function bucketKey(d, gran) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  if (gran === 'month') return `${y}-${m}`;
  if (gran === 'week') {
    // Snap to Monday of the email's week
    const wd = (d.getDay() + 6) % 7; // 0 = Monday
    const mon = new Date(d.getFullYear(), d.getMonth(), d.getDate() - wd);
    return bucketKey(mon, 'day');
  }
  return `${y}-${m}-${String(d.getDate()).padStart(2, '0')}`;
}

// Step a Date forward by one bucket of the given granularity (mutates a copy).
function bucketNext(d, gran) {
  const n = new Date(d);
  if (gran === 'month') n.setMonth(n.getMonth() + 1);
  else if (gran === 'week') n.setDate(n.getDate() + 7);
  else n.setDate(n.getDate() + 1);
  return n;
}

function bucketStartDate(key, gran) {
  if (gran === 'month') {
    const [y, m] = key.split('-').map(Number);
    return new Date(y, m - 1, 1);
  }
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function bucketLabel(key, gran) {
  const d = bucketStartDate(key, gran);
  if (gran === 'month') {
    return d.toLocaleDateString('en-SG', { month: 'short', year: '2-digit' });
  }
  return d.toLocaleDateString('en-SG', { day: '2-digit', month: 'short', year: '2-digit' });
}

function setDashboardGranularity(gran) {
  dashboardGranularity = gran;
  showDashboard();
}

// ── Rendering ──────────────────────────────────────────

function showDashboard() {
  showPanel('list');
  document.querySelector('.email-list-header').style.display = 'none';
  const container = document.getElementById('email-list');

  const gran = dashboardGranularity;
  const granBtn = (g, label) => `
    <button class="btn ${g === gran ? 'btn-primary' : ''}"
            onclick="setDashboardGranularity('${g}')">${label}</button>`;

  const toolbar = `
    <div style="padding:16px 20px 0; display:flex; align-items:center; gap:8px;">
      <span style="font-size:12px; color:var(--muted); margin-right:4px;">Bucket by</span>
      ${granBtn('day', 'Day')}${granBtn('week', 'Week')}${granBtn('month', 'Month')}
    </div>`;

  const dated = allEmails.filter(e => e.date && !isNaN(new Date(e.date)));

  if (!dated.length) {
    container.innerHTML = toolbar + `
      <div class="empty-state" style="margin-top:32px;">
        <div class="empty-icon">📊</div>
        <div class="empty-text">No dated emails yet. Import some EMLs to see your volume timeline.</div>
      </div>`;
    return;
  }

  // Tally counts per bucket
  const counts = new Map();
  let minD = null, maxD = null;
  for (const e of dated) {
    const d = new Date(e.date);
    const k = bucketKey(d, gran);
    counts.set(k, (counts.get(k) || 0) + 1);
    if (!minD || d < minD) minD = d;
    if (!maxD || d > maxD) maxD = d;
  }

  // Build a continuous list of buckets from min → max (fills empty ones)
  const buckets = [];
  let cur = bucketStartDate(bucketKey(minD, gran), gran);
  const end = bucketStartDate(bucketKey(maxD, gran), gran);
  let guard = 0;
  while (cur <= end && guard++ < 100000) {
    const k = bucketKey(cur, gran);
    buckets.push({ key: k, count: counts.get(k) || 0 });
    cur = bucketNext(cur, gran);
  }

  const maxCount = Math.max(...buckets.map(b => b.count), 1);
  const emptyBuckets = buckets.filter(b => b.count === 0).length;
  const activeBuckets = buckets.length - emptyBuckets;
  const unit = gran === 'month' ? 'month' : gran === 'week' ? 'week' : 'day';

  // Summary cards
  const card = (label, value, hint, color) => `
    <div style="flex:1; min-width:120px; padding:12px 14px; background:var(--surface2);
                border:1px solid var(--border); border-radius:6px;">
      <div style="font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:.5px;">${label}</div>
      <div style="font-size:22px; font-weight:600; margin-top:2px; ${color ? `color:${color};` : ''}">${value}</div>
      ${hint ? `<div style="font-size:11px; color:var(--muted); margin-top:2px;">${hint}</div>` : ''}
    </div>`;

  const summary = `
    <div style="padding:16px 20px 0; display:flex; gap:12px; flex-wrap:wrap;">
      ${card('Total Emails', dated.length, '')}
      ${card('Date Range', `${formatDate(minD.toISOString())}`, `→ ${formatDate(maxD.toISOString())}`)}
      ${card('Span', `${buckets.length}`, `${unit}s covered`)}
      ${card(`Empty ${unit}s`, emptyBuckets, emptyBuckets ? 'possible import gaps' : 'no gaps 🎉',
             emptyBuckets ? 'var(--warn)' : 'var(--accent)')}
    </div>`;

  // Bar chart (horizontally scrollable). Empty buckets render as a faint baseline tick.
  const barW = gran === 'day' ? 12 : gran === 'week' ? 16 : 28;
  const bars = buckets.map(b => {
    const h = b.count ? Math.max(2, Math.round((b.count / maxCount) * 150)) : 0;
    const empty = b.count === 0;
    const title = `${bucketLabel(b.key, gran)} — ${b.count} email${b.count === 1 ? '' : 's'}`;
    return `
      <div title="${title}" style="width:${barW}px; flex:0 0 ${barW}px; height:170px;
                  display:flex; flex-direction:column; justify-content:flex-end; align-items:center;
                  border-left:1px solid var(--border);">
        <div style="width:${barW - 4}px; height:${h}px;
                    background:${empty ? 'transparent' : 'var(--accent)'};
                    border-bottom:${empty ? '2px solid var(--warn)' : 'none'};
                    border-radius:2px 2px 0 0;"></div>
      </div>`;
  }).join('');

  const chart = `
    <div style="padding:20px;">
      <div style="font-size:12px; color:var(--muted); margin-bottom:6px;">
        Emails per ${unit} — hover a bar for the count. Amber ticks mark empty ${unit}s.
      </div>
      <div style="overflow-x:auto; border:1px solid var(--border); border-radius:6px;
                  background:var(--surface); padding:10px 6px;">
        <div style="display:flex; align-items:flex-end; min-width:min-content;">
          ${bars}
        </div>
      </div>
    </div>`;

  // Gap detail — runs of consecutive empty buckets, longest first
  let gapSection = '';
  if (emptyBuckets) {
    const runs = [];
    let runStart = null, runLen = 0;
    for (let i = 0; i < buckets.length; i++) {
      if (buckets[i].count === 0) {
        if (runStart === null) runStart = buckets[i].key;
        runLen++;
      } else if (runStart !== null) {
        runs.push({ start: runStart, end: buckets[i - 1].key, len: runLen });
        runStart = null; runLen = 0;
      }
    }
    if (runStart !== null) runs.push({ start: runStart, end: buckets[buckets.length - 1].key, len: runLen });
    runs.sort((a, b) => b.len - a.len);

    const rows = runs.slice(0, 20).map(r => {
      const range = r.len === 1
        ? bucketLabel(r.start, gran)
        : `${bucketLabel(r.start, gran)} → ${bucketLabel(r.end, gran)}`;
      return `
        <div style="display:flex; justify-content:space-between; gap:12px; padding:6px 10px;
                    border-bottom:1px solid var(--border);">
          <span>${range}</span>
          <span style="color:var(--warn); white-space:nowrap;">${r.len} ${unit}${r.len === 1 ? '' : 's'} empty</span>
        </div>`;
    }).join('');

    gapSection = `
      <div style="padding:0 20px 24px;">
        <div style="font-size:13px; font-weight:600; margin-bottom:6px;">
          ⚠ Empty ${unit} runs <span style="color:var(--muted); font-weight:400;">(${runs.length} total${runs.length > 20 ? ', showing 20 longest' : ''})</span>
        </div>
        <div style="font-size:12px; color:var(--muted); margin-bottom:8px;">
          Stretches with no emails. Expected for weekends/holidays at the day level — long runs may signal a missed import.
        </div>
        <div style="border:1px solid var(--border); border-radius:6px; background:var(--surface); font-size:13px;">
          ${rows}
        </div>
      </div>`;
  }

  container.innerHTML = toolbar + summary + chart + gapSection;
}
