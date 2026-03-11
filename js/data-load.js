// ═══════════════════════════════════════════════════════
//  DATA LOAD
// ═══════════════════════════════════════════════════════

async function backfillSystemEmailFlag() {
  const toUpdate = allEmails.filter(e => e.isSystemEmail !== true);
  if (!toUpdate.length) return 0;
  let flagged = 0;
  for (const e of toUpdate) {
    // rawHeaders not persisted — use available stored fields only
    e.isSystemEmail = detectSystemEmail({}, e.fromAddr, e.subject, e.textBody);
    if (e.isSystemEmail) flagged++;
    await dbPut('emails', e);
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

async function updateHeaderStats() {
  allEmails = await dbGetAll('emails');
  rebuildMsgIdIndex();
  buildThreadCache();
  const atts = await dbGetAll('attachments');

  document.getElementById('h-total').textContent      = allEmails.length;
  document.getElementById('h-unread').textContent     = allEmails.filter(e => e.status === 'unread').length;
  document.getElementById('h-awaiting').textContent   = allEmails.filter(e => e.status === 'awaiting').length;
  document.getElementById('h-actionable').textContent = allEmails.filter(e => e.isActionable).length;
  document.getElementById('h-attachments').textContent = atts.length;

  updateNavCounts();
  await updateStorageIndicator(atts); // Pass attachments to avoid re-querying
}

// Fast in-memory stats update — no IndexedDB reads, used after single-email changes
let _navCountsDebounceTimer = null;
function updateHeaderStatsFast() {
  document.getElementById('h-total').textContent      = allEmails.length;
  document.getElementById('h-unread').textContent     = allEmails.filter(e => e.status === 'unread').length;
  document.getElementById('h-awaiting').textContent   = allEmails.filter(e => e.status === 'awaiting').length;
  document.getElementById('h-actionable').textContent = allEmails.filter(e => e.isActionable).length;
  // Debounce nav count + smart-view sidebar refresh — batches rapid actions
  // (mark-read, tag, bulk-tag, etc.) into a single O(n) update instead of one per action
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
  const threadRoots = allEmails.filter(e => !e.inReplyTo && hasReplies(e)).length;
  document.getElementById('n-all').textContent        = allEmails.length;
  document.getElementById('n-unread').textContent     = allEmails.filter(e => e.status === 'unread').length;
  document.getElementById('n-actionable').textContent = allEmails.filter(e => e.isActionable).length;
  document.getElementById('n-awaiting').textContent   = allEmails.filter(e => e.status === 'awaiting').length;
  document.getElementById('n-threads').textContent    = threadRoots;
  document.getElementById('n-attach').textContent     = allEmails.filter(e => e.hasAttachments).length;
  document.getElementById('n-automated').textContent  = allEmails.filter(e => e.isSystemEmail).length;
  document.getElementById('n-lowvalue').textContent   = allEmails.filter(e => e.isLowValue).length;

  // Update issues and transmittals count asynchronously
  dbGetAll('issues').then(issues => {
    document.getElementById('n-issues').textContent = issues.filter(i => i.status !== 'resolved').length;
  });
  dbGetAll('attachments').then(atts => {
    document.getElementById('n-transmittals').textContent = atts.length;
  });

  // Refresh smart view counts in sidebar
  renderSmartViewsSidebar();
}
