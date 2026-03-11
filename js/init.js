// ═══════════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════════

async function init() {
  db = await openDB();
  setupDropZone();

  // Load custom patterns, smart views, email groups, auto-tag rules, and AI prompts before processing emails
  await loadCustomPatterns();
  await loadEmailGroups();
  await loadAutoTagRules();
  await loadAiPrompts();
  await loadAttachTextLimit();
  await loadSmartViews();

  const emails = await dbGetAll('emails');
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
