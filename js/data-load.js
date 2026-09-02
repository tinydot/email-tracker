// ═══════════════════════════════════════════════════════
//  DATA LOAD
// ═══════════════════════════════════════════════════════

// Requires emailIdIndex to be current — call rebuildMsgIdIndex() first.
async function backfillSystemEmailFlag() {
  // Candidates first: anything already flagged or manually overridden is skipped,
  // so a settled corpus only needs a handful of bodies looked at.
  const candidates = new Set();
  for (const e of allEmails) {
    if (e.isSystemEmail === true || e.manualSystemOverride) continue;
    candidates.add(e.id);
  }
  if (!candidates.size) return 0;

  // Stream the candidate bodies rather than holding them — detection reads only
  // the first 1000 chars (see detectSystemEmail) and we keep just the ids that flip.
  const withBody = new Set();
  const flagged  = new Set();
  await dbGetMany('bodies', candidates, rec => {
    withBody.add(rec.id);
    const e = emailIdIndex.get(rec.id);
    // rawHeaders not persisted — use available stored fields only
    if (e && detectSystemEmail({}, e.fromAddr, e.subject, rec.text)) flagged.add(rec.id);
  });
  // Candidates with no stored body still get a sender/subject pass
  for (const id of candidates) {
    if (withBody.has(id)) continue;
    const e = emailIdIndex.get(id);
    if (e && detectSystemEmail({}, e.fromAddr, e.subject, '')) flagged.add(id);
  }

  for (const id of flagged) {
    const e = emailIdIndex.get(id);
    e.isSystemEmail = true;
    await dbPut('emails', e);
  }
  return flagged.size;
}

async function rerunAutomatedDetection() {
  const btn = document.getElementById('btn-rerun-detection');
  if (btn) { btn.disabled = true; btn.textContent = 'Running…'; }
  const flagged = await backfillSystemEmailFlag();
  updateNavCounts();
  applyFilters();
  if (btn) { btn.disabled = false; btn.textContent = 'Re-run detection'; }
  toast(`Detection complete — ${flagged} email${flagged === 1 ? '' : 's'} flagged as automated`, 'ok');
}

async function loadEmailList() {
  allEmails = await dbGetAll('emails');
  rebuildMsgIdIndex();   // must precede buildThreadCache (thread walks use msgIdIndex)
  await backfillSystemEmailFlag(); // resolves ids through emailIdIndex
  buildThreadCache();
  await buildAttachmentNameIndex();
  // Bodies may have changed underneath us (import, restore, maintenance):
  // drop the cached detail body and redo any active body search.
  _loadedBodyId = null;
  if (searchTerm) searchBodyMatches = await scanBodiesFor(searchTerm);
  applyFilters();
  updateNavCounts();
}

// Build emailId → lowercase attachment filenames map so applyFilters() can
// match the search term against attachment names without a per-email DB read.
// Accepts a preloaded attachments array to avoid re-querying when the caller
// already has one.
async function buildAttachmentNameIndex(atts = null) {
  if (!atts) atts = await dbGetAll('attachments');
  attachmentNameIndex.clear();
  for (const a of atts) {
    if (!a.emailId || !a.filename || a.isBlacklisted) continue;
    const prev = attachmentNameIndex.get(a.emailId);
    const name = a.filename.toLowerCase();
    attachmentNameIndex.set(a.emailId, prev ? prev + '\n' + name : name);
  }
}

// Refreshes header stats, nav counts, and the storage indicator from the
// in-memory allEmails array. Callers must update allEmails first; indexes
// and the thread cache are rebuilt here (in-memory, no email re-read).
async function updateHeaderStats() {
  rebuildMsgIdIndex();
  buildThreadCache();
  const atts = await dbGetAll('attachments');
  await buildAttachmentNameIndex(atts);

  document.getElementById('h-total').textContent      = allEmails.length;
  document.getElementById('h-unread').textContent     = allEmails.filter(e => e.status === 'unread').length;
  document.getElementById('h-attachments').textContent = atts.length;

  updateNavCounts();
  await updateStorageIndicator();
}

// Fast in-memory stats update — no IndexedDB reads, used after single-email changes
let _navCountsDebounceTimer = null;
function updateHeaderStatsFast() {
  document.getElementById('h-total').textContent      = allEmails.length;
  document.getElementById('h-unread').textContent     = allEmails.filter(e => e.status === 'unread').length;
  // Debounce nav count + smart-view sidebar refresh — batches rapid actions
  // (mark-read, tag, etc.) into a single O(n) update instead of one per action
  clearTimeout(_navCountsDebounceTimer);
  _navCountsDebounceTimer = setTimeout(updateNavCounts, 300);
}

async function updateStorageIndicator() {
  const indicator = document.getElementById('storage-indicator');
  const label = document.getElementById('h-storage');

  if (emlArchiveDirHandle) {
    indicator.style.display = '';
    indicator.style.color = 'var(--accent)';
    indicator.title = 'EML archive folder connected. Click to change.';
    label.textContent = emlArchiveDirHandle.name;
  } else if (allEmails.some(e => e.emlArchivePath)) {
    // Emails reference archived .eml files but the folder isn't connected
    indicator.style.display = '';
    indicator.style.color = 'var(--warn)';
    indicator.title = 'EML archive folder disconnected. Click to reconnect.';
    label.textContent = 'Disconnected';
  } else {
    indicator.style.display = 'none';
  }
}

async function changeEmlArchiveFolder() {
  if (emlArchiveDirHandle) {
    const proceed = confirm('Change EML archive folder?\n\nThis will not move existing files.');
    if (!proceed) return;
  }

  await setupEmlArchiveFolder();
  updateStorageIndicator();
}

function updateNavCounts() {
  let unread = 0, threadRoots = 0, attach = 0, automated = 0;
  for (const e of allEmails) {
    if (e.status === 'unread') unread++;
    if (!e.inReplyTo && hasReplies(e)) threadRoots++;
    if (e.hasAttachments) attach++;
    if (e.isSystemEmail) automated++;
  }
  document.getElementById('n-all').textContent       = allEmails.length;
  document.getElementById('n-unread').textContent    = unread;
  document.getElementById('n-threads').textContent   = threadRoots;
  document.getElementById('n-attach').textContent    = attach;
  document.getElementById('n-automated').textContent = automated;

  // Refresh smart view counts in sidebar
  renderSmartViewsSidebar();
}
