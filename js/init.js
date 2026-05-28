// ═══════════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════════

async function init() {
  db = await openDB();
  setupDropZone();

  // Load settings + emails in parallel — these are independent IndexedDB reads
  const [, , , , , , , , , emails] = await Promise.all([
    loadCustomPatterns(),
    loadCustomQuotePatterns(),
    loadCustomSignaturePatterns(),
    loadSignatureRanges(),
    loadEmailGroups(),
    loadAutoTagRules(),
    loadAiPrompts(),
    loadAttachTextLimit(),
    loadSmartViews(),
    dbGetAll('emails'),
  ]);
  if (emails.length > 0) {
    allEmails = emails;
    buildThreadCache();
    applyFilters();
    updateNavCounts();
    await updateHeaderStats();
    showPanel('list');
  } else {
    showPanel('import');
    // Still update storage indicator even if no emails
    await updateStorageIndicator();
  }
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeDetail(); return; }
  const modalOpen = document.getElementById('email-modal-overlay').classList.contains('open');
  if (!modalOpen) return;
  // Don't intercept if user is typing in an input/select/textarea
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (e.key === 'j' || e.key === 'ArrowRight') { e.preventDefault(); navigateEmail(1); }
  if (e.key === 'k' || e.key === 'ArrowLeft')  { e.preventDefault(); navigateEmail(-1); }
});

init();
