// ═══════════════════════════════════════════════════════
//  EMAIL ACTIONS
// ═══════════════════════════════════════════════════════

async function toggleAutomated(id) {
  const email = emailIdIndex.get(id);
  if (!email) return;
  if (email.isSystemEmail) {
    email.isSystemEmail = false;
    email.manualSystemOverride = true;  // prevent re-detection
  } else {
    email.isSystemEmail = true;
    email.manualSystemOverride = false;
  }
  await dbPut('emails', email);
  openDetail(email);
  applyFilters();
  updateNavCounts();
  toast(email.isSystemEmail ? 'Marked as automated' : 'Unmarked from automated — protected from bulk discard', 'ok');
}

async function addTag(id, tagName) {
  const tag = tagName || prompt('Enter tag:');
  if (!tag) return;
  const clean = tag.trim().toLowerCase();
  const email = emailIdIndex.get(id);
  if (!email) return;
  if ((email.tagExclusions || []).includes(clean)) {
    toast(`"${clean}" is excluded on this email — click ⊘ chip to un-exclude first`, 'warn');
    return;
  }
  if (!email.tags) email.tags = [];
  if (!email.tags.includes(clean)) {
    email.tags.push(clean);
    renderDetailTags(email); // update UI immediately; tags not shown in list rows
    await dbPut('emails', email);
  }
}

async function removeTag(id, tag) {
  const email = emailIdIndex.get(id);
  if (!email) return;
  email.tags = (email.tags || []).filter(t => t !== tag);
  renderDetailTags(email); // update UI immediately
  await dbPut('emails', email);
}

// Exclude a tag: removes it AND marks it so auto-tag/bulk won't reapply
async function excludeTag(id, tag) {
  const email = emailIdIndex.get(id);
  if (!email) return;
  email.tags = (email.tags || []).filter(t => t !== tag);
  if (!email.tagExclusions) email.tagExclusions = [];
  if (!email.tagExclusions.includes(tag)) email.tagExclusions.push(tag);
  await dbPut('emails', email);
  renderDetailTags(email);
  renderEmailList();
}

// Remove exclusion — allows the tag to be applied again
async function unexcludeTag(id, tag) {
  const email = emailIdIndex.get(id);
  if (!email) return;
  email.tagExclusions = (email.tagExclusions || []).filter(t => t !== tag);
  await dbPut('emails', email);
  renderDetailTags(email);
}

async function deleteEmail(id) {
  if (!confirm('Delete this email?')) return;
  await dbDelete('emails', id);
  const atts = await dbGetByIndex('attachments', 'emailId', id);
  for (const a of atts) await dbDelete('attachments', a.id);
  allEmails = allEmails.filter(e => e.id !== id);
  closeDetail();
  await updateHeaderStats(); // rebuilds msgId index + thread cache from updated allEmails
  applyFilters();
  toast('Email deleted', 'ok');
}
