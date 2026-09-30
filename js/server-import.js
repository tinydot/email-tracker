// ═══════════════════════════════════════════════════════
//  SERVER IMPORT (v2)
//  In v2 the server parses and stores mail (email_tracker/ingest.py); the
//  page only hands it raw .eml files, one per request, or asks it to scan
//  the Thunderbird profile. The v1 pipeline in import.js is not used.
// ═══════════════════════════════════════════════════════

// Shows the bottom progress bar (shared with the v1 import) and returns
// helpers for it.
function _serverImportBar(titleText) {
  showPanel('list');
  const bar = document.getElementById('import-progress-bar');
  const log = document.getElementById('ipb-log');
  bar.querySelector('.ipb-title').textContent = titleText;
  log.innerHTML = '';
  bar.style.display = '';
  document.getElementById('email-list-panel').classList.add('import-running');
  const MAX_LOG_LINES = 400;
  return {
    progress(done, total, pctOverride) {
      const pct = pctOverride ?? (total ? Math.round((done / total) * 100) : 0);
      document.getElementById('ipb-fill').style.width = pct + '%';
      document.getElementById('ipb-counts').textContent = total ? `${done} / ${total}` : `${done}`;
      document.getElementById('ipb-pct').textContent = pct + '%';
    },
    log(msg, cls = '') {
      const d = document.createElement('div');
      d.className = 'log-line ' + cls;
      d.textContent = msg;
      log.appendChild(d);
      while (log.childElementCount > MAX_LOG_LINES) log.removeChild(log.firstElementChild);
      log.scrollTop = log.scrollHeight;
    },
    done() {
      bar.style.display = 'none';
      document.getElementById('email-list-panel').classList.remove('import-running');
    },
  };
}

// Upload .eml files to the server. Files are sent sequentially — the server
// is local, so this is disk-bound, and one request per file keeps a huge
// selection from ever being held in memory at once.
async function serverIngestFiles(fileList) {
  const files = Array.from(fileList || []).filter(f => /\.eml$/i.test(f.name));
  if (!files.length) { toast('No .eml files selected', 'warn'); return; }
  const ui = _serverImportBar('Importing emails…');
  ui.log(`Uploading ${files.length} file(s) to the server…`);
  const counts = { added: 0, existing: 0, archived: 0, tombstoned: 0, failed: 0 };
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    ui.progress(i, files.length);
    try {
      const r = await apiIngestEml(f);
      counts[r.status] = (counts[r.status] || 0) + 1;
      if (r.status === 'failed')          ui.log(`⚠ ${f.name}: ${r.error || 'parse failed'}`, 'warn');
      else if (r.status === 'tombstoned') ui.log(`⊘ ${f.name}: previously discarded (skipped)`, 'warn');
      else if (r.status === 'added')      ui.log(`✓ ${f.name}`, 'ok');
    } catch (err) {
      counts.failed++;
      ui.log(`⚠ ${f.name}: ${err.message}`, 'warn');
    }
  }
  ui.progress(files.length, files.length);
  await apiIngestFinish();   // threads + needs-reply, once for the whole batch
  await loadEmailList();
  await updateHeaderStats();
  ui.done();
  toast(_ingestSummary(counts), counts.added ? 'ok' : '');
}

function _ingestSummary(c) {
  const parts = [`${c.added} added`];
  if (c.existing)   parts.push(`${c.existing} already imported`);
  if (c.archived)   parts.push(`${c.archived} originals archived`);
  if (c.tombstoned) parts.push(`${c.tombstoned} discarded before`);
  if (c.failed)     parts.push(`${c.failed} failed`);
  return parts.join(', ');
}

async function serverScanThunderbird() {
  let job;
  try {
    job = await apiThunderbirdScan();
  } catch { return; } // _api has shown the error
  const ui = _serverImportBar('Scanning Thunderbird…');
  ui.log('Reading the Thunderbird profile on the server — already-imported messages are skipped.');
  let lastFolder = '';
  while (job.status === 'running') {
    const p = job.progress || {};
    ui.progress(p.messages || 0, 0, p.percent || 0);
    if (p.folder && p.folder !== lastFolder) { ui.log(`📁 ${p.folder}`); lastFolder = p.folder; }
    await new Promise(r => setTimeout(r, 1000));
    job = await apiJob('thunderbird');
  }
  ui.done();
  if (job.status === 'failed') { toast('Thunderbird scan failed: ' + job.error, 'err'); return; }
  const r = job.result || {};
  await loadEmailList();
  await updateHeaderStats();
  let msg = `${r.messages || 0} messages in ${r.folders || 0} folder(s): ` + _ingestSummary(r);
  if (r.expunged) msg += `, ${r.expunged} deleted`;
  toast(msg, r.added ? 'ok' : '');
  refreshThunderbirdRow();
}

// Fill in the import panel's Thunderbird row with the detected profile.
async function refreshThunderbirdRow() {
  const detail = document.getElementById('srv-tb-detail');
  if (!detail || !V2_SERVER) return;
  try {
    const info = await apiThunderbirdInfo();
    detail.textContent = info.profile
      ? `Profile: ${info.profile}`
      : 'No Thunderbird profile found — set thunderbird_profile in the server config';
    document.getElementById('srv-tb-btn').disabled = !info.profile;
    if (info.job?.status === 'running') serverScanThunderbird();  // resume the progress display
  } catch { /* _api has shown the error */ }
}
