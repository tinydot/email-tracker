// ═══════════════════════════════════════════════════════
//  EMAIL ACTIONS
// ═══════════════════════════════════════════════════════

let bulkTagBarExpanded = false;

async function setStatus(id, status) {
  const email = emailIdIndex.get(id) || allEmails.find(e => e.id === id);
  if (!email) return;
  email.status = status;
  
  // Track awaiting timestamp
  if (status === 'awaiting') {
    email.awaitingSince = new Date().toISOString();
  } else if (email.awaitingSince && status !== 'awaiting') {
    email.awaitingSince = null;
  }
  
  // Update UI immediately (optimistic — DB write happens in background)
  openDetail(email);
  updateEmailRow(email);
  updateHeaderStatsFast();
  toast(`Marked as ${status}`, 'ok');
  await dbPut('emails', email);
}

async function toggleActionable(id) {
  const email = emailIdIndex.get(id) || allEmails.find(e => e.id === id);
  if (!email) return;
  email.isActionable = !email.isActionable;
  // Update UI immediately (optimistic)
  openDetail(email);
  updateEmailRow(email);
  toast(email.isActionable ? 'Marked actionable' : 'Removed action flag', 'ok');
  await dbPut('emails', email);
}

async function toggleAutomated(id) {
  const email = emailIdIndex.get(id) || allEmails.find(e => e.id === id);
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

async function toggleLowValue(id) {
  const email = emailIdIndex.get(id) || allEmails.find(e => e.id === id);
  if (!email) return;
  email.isLowValue = !email.isLowValue;
  // Update UI immediately (optimistic); low value not shown in list rows so no row re-render
  openDetail(email);
  updateHeaderStatsFast();
  toast(email.isLowValue ? 'Marked as low value' : 'Removed low value flag', 'ok');
  await dbPut('emails', email);
}

async function bulkUnmarkActionable() {
  const flagged = allEmails.filter(e => e.isActionable);
  if (flagged.length === 0) {
    toast('No actionable emails to unmark', 'ok');
    return;
  }
  if (!confirm(`Remove the ⚡ actionable flag from ${flagged.length} email${flagged.length !== 1 ? 's' : ''}? This cannot be undone.`)) return;
  for (const email of flagged) {
    email.isActionable = false;
    await dbPut('emails', email);
  }
  await updateHeaderStats();
  renderEmailList();
  toast(`Unmarked ${flagged.length} email${flagged.length !== 1 ? 's' : ''}`, 'ok');
}

// ═══════════════════════════════════════════════════════
//  BULK TAGGING
// ═══════════════════════════════════════════════════════

function refreshBulkTagBar() {
  const bar = document.getElementById('bulk-tag-bar');
  if (!bar) return;

  // Hide in non-email-list views
  if (currentView === 'transmittals' || currentView === 'issues') {
    bar.style.display = 'none';
    return;
  }

  bar.style.display = 'flex';
  const count = filteredEmails.length;

  // Gather unique tags across all currently filtered emails
  const tagSet = new Set();
  for (const email of filteredEmails) {
    for (const t of (email.tags || [])) tagSet.add(t);
  }
  const uniqueTags = [...tagSet].sort();

  const TAGS_LIMIT = 5;
  const visibleTags = bulkTagBarExpanded ? uniqueTags : uniqueTags.slice(0, TAGS_LIMIT);
  const hiddenCount = uniqueTags.length - TAGS_LIMIT;

  let tagsHTML;
  if (uniqueTags.length === 0) {
    tagsHTML = `<span style="color:var(--muted);font-size:11px;font-style:italic;">none</span>`;
  } else {
    tagsHTML = visibleTags.map(t => `
        <span class="bulk-view-tag-chip">
          #${escHtml(t)}
          <button class="chip-remove" onclick="bulkRemoveTagFromView('${escHtml(t)}')" title="Remove tag from all ${count} filtered email${count !== 1 ? 's' : ''}">×</button>
        </span>`).join('');
    if (!bulkTagBarExpanded && hiddenCount > 0) {
      tagsHTML += `<button class="tags-show-more" onclick="toggleBulkTagExpand()">+${hiddenCount} more</button>`;
    } else if (bulkTagBarExpanded && uniqueTags.length > TAGS_LIMIT) {
      tagsHTML += `<button class="tags-show-more" onclick="toggleBulkTagExpand()">show less</button>`;
    }
  }

  bar.innerHTML = `
    <span class="bulk-tag-label">Bulk tag ${count} email${count !== 1 ? 's' : ''}:</span>
    <input type="text" id="bulk-tag-input" placeholder="tag name…"
           onkeydown="if(event.key==='Enter')bulkAddTagToView()">
    <button class="btn btn-primary" style="height:26px;padding:0 10px;font-size:11px;"
            onclick="bulkAddTagToView()">+ Add to all</button>
    <div class="bulk-tag-sep"></div>
    <button class="btn" onclick="bulkAiTagView()" style="height:26px;padding:0 10px;font-size:11px;" title="AI-tag all emails in current view with Claude">✨ AI Tag All</button>
    <div class="bulk-tag-sep"></div>
    <span class="bulk-tag-label">Tags in view:</span>
    ${tagsHTML}
  `;
}

function toggleBulkTagExpand() {
  bulkTagBarExpanded = !bulkTagBarExpanded;
  refreshBulkTagBar();
}

async function bulkAddTagToView() {
  const input = document.getElementById('bulk-tag-input');
  if (!input) return;
  const tag = input.value.trim().toLowerCase();
  if (!tag) { toast('Enter a tag name', 'err'); return; }

  // Skip emails that already have the tag OR have it excluded
  const targets = filteredEmails.filter(e =>
    !(e.tags || []).includes(tag) && !(e.tagExclusions || []).includes(tag)
  );
  const skipped = filteredEmails.filter(e => (e.tagExclusions || []).includes(tag)).length;
  if (targets.length === 0) {
    const msg = skipped
      ? `Tag "${tag}" skipped on all — ${skipped} email${skipped !== 1 ? 's' : ''} have it excluded`
      : `Tag "${tag}" already on all ${filteredEmails.length} email${filteredEmails.length !== 1 ? 's' : ''}`;
    toast(msg, 'ok');
    return;
  }

  for (const email of targets) {
    if (!email.tags) email.tags = [];
    email.tags.push(tag);
    await dbPut('emails', email);
  }

  input.value = '';
  refreshBulkTagBar();
  const skipNote = skipped ? ` (${skipped} excluded)` : '';
  toast(`Added tag "${tag}" to ${targets.length} email${targets.length !== 1 ? 's' : ''}${skipNote}`, 'ok');
}

async function bulkRemoveTagFromView(tag) {
  const targets = filteredEmails.filter(e => (e.tags || []).includes(tag));
  if (targets.length === 0) {
    toast(`Tag "${tag}" not found in current view`, 'ok');
    return;
  }
  if (!confirm(`Remove tag "${tag}" from ${targets.length} email${targets.length !== 1 ? 's' : ''}?`)) return;

  for (const email of targets) {
    email.tags = email.tags.filter(t => t !== tag);
    await dbPut('emails', email);
  }

  refreshBulkTagBar();
  // Re-filter in case the active smart view rules depend on this tag
  if (currentView.startsWith('sv-')) applyFilters();
  toast(`Removed tag "${tag}" from ${targets.length} email${targets.length !== 1 ? 's' : ''}`, 'ok');
}

async function addTag(id, tagName) {
  const tag = tagName || prompt('Enter tag:');
  if (!tag) return;
  const clean = tag.trim().toLowerCase();
  const email = allEmails.find(e => e.id === id);
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
  const email = allEmails.find(e => e.id === id);
  if (!email) return;
  email.tags = (email.tags || []).filter(t => t !== tag);
  renderDetailTags(email); // update UI immediately
  await dbPut('emails', email);
}

// Exclude a tag: removes it AND marks it so auto-tag/bulk won't reapply
async function excludeTag(id, tag) {
  const email = allEmails.find(e => e.id === id);
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
  const email = allEmails.find(e => e.id === id);
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
  rebuildMsgIdIndex();   // allEmails changed
  closeDetail();
  applyFilters();
  await updateHeaderStats();
  toast('Email deleted', 'ok');
}
