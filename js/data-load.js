// ═══════════════════════════════════════════════════════
//  DATA LOAD
// ═══════════════════════════════════════════════════════

async function backfillSystemEmailFlag() {
  let flagged = 0;
  for (const e of allEmails) {
    // Respect manual unmark — never re-flag what the user overrode
    if (e.isSystemEmail === true || e.manualSystemOverride) continue;
    // rawHeaders not persisted — use available stored fields only
    const detected = detectSystemEmail({}, e.fromAddr, e.subject, e.textBody);
    if (detected) flagged++;
    if (e.isSystemEmail !== detected) {
      e.isSystemEmail = detected;
      await dbPut('emails', e);
    }
  }
  return flagged;
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
  await backfillSystemEmailFlag();
  rebuildMsgIdIndex();   // must precede buildThreadCache (thread walks use msgIdIndex)
  buildThreadCache();
  applyFilters();
  updateNavCounts();
}

// Refreshes header stats, nav counts, and the storage indicator from the
// in-memory allEmails array. Callers must update allEmails first; indexes
// and the thread cache are rebuilt here (in-memory, no email re-read).
async function updateHeaderStats() {
  rebuildMsgIdIndex();
  buildThreadCache();
  const atts = await dbGetAll('attachments');

  document.getElementById('h-total').textContent      = allEmails.length;
  document.getElementById('h-unread').textContent     = allEmails.filter(e => e.status === 'unread').length;
  document.getElementById('h-attachments').textContent = atts.length;

  updateNavCounts();
  await updateStorageIndicator(atts); // Pass attachments to avoid re-querying
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

async function updateStorageIndicator(atts = null) {
  const indicator = document.getElementById('storage-indicator');
  const label = document.getElementById('h-storage');
  
  if (attachmentDirHandle) {
    indicator.style.display = '';
    indicator.style.color = 'var(--accent)';
    indicator.title = 'Attachment folder connected. Click to change.';
    label.textContent = attachmentDirHandle.name;
  } else {
    // Check if we have any stored attachments
    if (!atts) atts = await dbGetAll('attachments');
    const hasStoredFiles = atts.some(a => a.storedPath);
    
    if (hasStoredFiles) {
      indicator.style.display = '';
      indicator.style.color = 'var(--warn)';
      indicator.title = 'Attachment folder disconnected. Click to reconnect.';
      label.textContent = 'Disconnected';
    } else {
      indicator.style.display = 'none';
    }
  }
}

async function changeAttachmentFolder() {
  if (attachmentDirHandle) {
    const proceed = confirm('Change attachment storage folder?\n\nThis will not move existing files.');
    if (!proceed) return;
  }
  
  await setupAttachmentStorage();
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
