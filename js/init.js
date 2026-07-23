// ═══════════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════════

async function init() {
  db = await openDB();
  setupDropZone();

  // Load settings + emails in parallel — these are independent IndexedDB reads
  const [, , , , , , , emails] = await Promise.all([
    loadCustomPatterns(),
    loadCustomQuotePatterns(),
    loadCustomSignaturePatterns(),
    loadSignatureRanges(),
    loadEmailGroups(),
    loadAttachTextLimit(),
    loadSmartViews(),
    dbGetAll('emails'),
    restoreDirHandles(), // reconnect persisted storage folder handles
    loadGDriveSettings(), // Google Drive backup config
  ]);
  if (emails.length > 0) {
    allEmails = emails;
    await updateHeaderStats(); // rebuilds msgId index + thread cache, updates nav counts
    applyFilters();
    showPanel('list');
  } else {
    showPanel('import');
    // Still update storage indicator even if no emails
    await updateStorageIndicator();
  }
}

document.addEventListener('keydown', e => {
  const tag = document.activeElement?.tagName;
  const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

  // Escape closes whichever overlay is open
  if (e.key === 'Escape') {
    if (document.getElementById('sv-modal-overlay').classList.contains('open')) {
      closeSmartViewEditor();
    } else if (document.getElementById('email-modal-overlay').classList.contains('open')) {
      closeDetail();
    }
    return;
  }

  const modalOpen = document.getElementById('email-modal-overlay').classList.contains('open');

  // "/" focuses the search box when no modal is open and not already typing
  if (e.key === '/' && !modalOpen && !typing) {
    const search = document.getElementById('search-input');
    if (search) { e.preventDefault(); search.focus(); }
    return;
  }

  if (!modalOpen) return;
  // Don't intercept if user is typing in an input/select/textarea
  if (typing) return;
  if (e.key === 'j' || e.key === 'ArrowRight') { e.preventDefault(); navigateEmail(1); }
  if (e.key === 'k' || e.key === 'ArrowLeft')  { e.preventDefault(); navigateEmail(-1); }
});

init();
