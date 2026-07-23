// ═══════════════════════════════════════════════════════
//  EXPORT / CLEAR
// ═══════════════════════════════════════════════════════

// Assemble the full-corpus backup payload used by both the JSON export and the
// Google Drive backup. Folder handles are machine-local and not JSON-serializable,
// so settings records carrying a `handle` are dropped.
async function buildBackupPayload() {
  const [
    emails, attachments, tags, msgIndex,
    smartViews, settings, emailGroups, seenIds,
    addressBook,
  ] = await Promise.all([
    dbGetAll('emails'),
    dbGetAll('attachments'),
    dbGetAll('tags'),
    dbGetAll('msgIndex'),
    dbGetAll('smartViews'),
    dbGetAll('settings'),
    dbGetAll('emailGroups'),
    dbGetAll('seenIds'),
    dbGetAll('addressBook'),
  ]);

  return {
    schemaVersion: 3,
    exportedAt:    new Date().toISOString(),
    emails,
    attachments,
    tags,
    msgIndex,
    smartViews,
    settings: settings.filter(s => !s.handle),
    emailGroups,
    seenIds,
    addressBook,
  };
}

async function exportData() {
  const payload = await buildBackupPayload();

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `email-tracker-${new Date().toISOString().split('T')[0]}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function importData(input) {
  const file = input.files[0];
  if (!file) return;
  input.value = '';

  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    toast('Invalid JSON file', 'err');
    return;
  }

  const { parts, anyAdded, totalRecords } = await applyBackupData(data);
  if (totalRecords === 0) return; // toast already shown by applyBackupData
  toast(parts.length ? parts.join(', ') : 'Nothing new to import', anyAdded ? 'ok' : '');
}

// Merge a parsed backup payload into the local database. Shared by JSON import
// and Google Drive restore. Uses skip-if-existing upserts so a restore never
// clobbers the user's current state. Returns a summary for the caller to report.
async function applyBackupData(data) {
  const arr = k => (Array.isArray(data[k]) ? data[k] : []);
  const emails        = arr('emails');
  const attachments   = arr('attachments');
  const tagsReg       = arr('tags');
  const msgIndex      = arr('msgIndex');
  const smartViewsIn  = arr('smartViews');
  const settings      = arr('settings');
  const emailGroupsIn = arr('emailGroups');
  const seenIds       = arr('seenIds');
  const addressBook   = arr('addressBook');

  const totalRecords =
    emails.length + attachments.length + tagsReg.length + msgIndex.length +
    smartViewsIn.length + settings.length + emailGroupsIn.length +
    seenIds.length + addressBook.length;

  if (totalRecords === 0) {
    toast('Nothing to import', 'err');
    return { parts: [], anyAdded: false, totalRecords: 0 };
  }

  // Restore settings (don't overwrite existing values)
  for (const s of settings) {
    if (!s.key || s.handle) continue; // handle records are machine-local
    const existing = await dbGet('settings', s.key);
    if (!existing) await dbPut('settings', s);
  }

  let emailsAdded = 0, emailsSkipped = 0;
  let attsAdded   = 0, attsSkipped   = 0;

  for (const email of emails) {
    if (!email.id) continue;
    const existing = await dbGet('emails', email.id);
    if (existing) { emailsSkipped++; continue; }
    if (email.textBody) email.textBody = email.textBody.replace(/(\n[ \t]*){2,}/g, '\n');
    await dbPut('emails', email);
    if (email.messageId) {
      await dbPut('msgIndex', { messageId: email.messageId, emailId: email.id });
    }
    emailsAdded++;
  }

  for (const att of attachments) {
    if (!att.id) continue;
    const existing = await dbGet('attachments', att.id);
    if (existing) { attsSkipped++; continue; }
    await dbPut('attachments', att);
    attsAdded++;
  }

  // Skip-if-existing upserts for the remaining config/AI stores so a restore
  // never silently clobbers the user's current state.
  const upsertSkip = async (store, key, records) => {
    let added = 0;
    for (const r of records) {
      const k = r?.[key];
      if (k == null) continue;
      const existing = await dbGet(store, k);
      if (existing) continue;
      await dbPut(store, r);
      added++;
    }
    return added;
  };

  const tagsAdded   = await upsertSkip('tags',        'name',      tagsReg);
  const msgAdded    = await upsertSkip('msgIndex',    'messageId', msgIndex);
  const svAdded     = await upsertSkip('smartViews',  'id',        smartViewsIn);
  const groupsAdded = await upsertSkip('emailGroups', 'id',        emailGroupsIn);
  const seenAdded   = await upsertSkip('seenIds',     'id',        seenIds);
  const abAdded     = await upsertSkip('addressBook', 'email',     addressBook);

  // Reload in-memory caches and redraw affected UI.
  if (settings.length) {
    await loadCustomPatterns();
    await loadCustomQuotePatterns();
    await loadCustomSignaturePatterns();
    await loadSignatureRanges();
    await loadAttachTextLimit();
    if (typeof loadGDriveSettings === 'function') await loadGDriveSettings();
  }
  if (emailGroupsIn.length) await loadEmailGroups();
  if (smartViewsIn.length || settings.length || emailGroupsIn.length) await loadSmartViews();

  await loadEmailList();
  await updateHeaderStats();
  showPanel('list');

  const parts = [];
  if (emailsAdded)   parts.push(`${emailsAdded} email${emailsAdded !== 1 ? 's' : ''}`);
  if (emailsSkipped) parts.push(`${emailsSkipped} skipped`);
  if (attsAdded)     parts.push(`${attsAdded} attachment${attsAdded !== 1 ? 's' : ''}`);
  if (svAdded)       parts.push(`${svAdded} smart view${svAdded !== 1 ? 's' : ''}`);
  if (groupsAdded)   parts.push(`${groupsAdded} email group${groupsAdded !== 1 ? 's' : ''}`);
  if (abAdded)       parts.push(`${abAdded} contact${abAdded !== 1 ? 's' : ''}`);
  if (tagsAdded)     parts.push(`${tagsAdded} tag${tagsAdded !== 1 ? 's' : ''}`);
  if (seenAdded)     parts.push(`${seenAdded} tombstone${seenAdded !== 1 ? 's' : ''}`);
  if (msgAdded)      parts.push(`${msgAdded} msgId`);

  const anyAdded = emailsAdded || attsAdded || svAdded || groupsAdded ||
                   abAdded || tagsAdded || seenAdded || msgAdded;
  return { parts, anyAdded, totalRecords };
}

async function clearDB() {
  if (!confirm('Clear all data? This cannot be undone.')) return;
  await dbClear('emails');
  await dbClear('attachments');
  await dbClear('msgIndex');
  await dbClear('tags');
  await dbClear('seenIds');
  allEmails = [];
  filteredEmails = [];
  selectedEmail = null;
  closeDetail();
  await updateHeaderStats();
  showPanel('import');
  toast('Database cleared', 'ok');
}

async function discardAutomatedEmails() {
  const automated = allEmails.filter(e => e.isSystemEmail && !e.manualSystemOverride);
  if (!automated.length) {
    toast('No automated emails to discard', 'warn');
    return;
  }
  if (!confirm(`Discard ${automated.length} automated email(s)?\n\nTheir IDs will be remembered to prevent reimporting, but all content will be deleted. This cannot be undone.`)) return;

  for (const email of automated) {
    await dbPut('seenIds', { id: email.id });
    await dbDelete('emails', email.id);
    await dbDelete('msgIndex', email.messageId);
    // Remove associated attachments
    const atts = await dbGetByIndex('attachments', 'emailId', email.id);
    for (const att of atts) await dbDelete('attachments', att.id);
  }

  allEmails = allEmails.filter(e => !e.isSystemEmail);
  if (selectedEmail?.isSystemEmail) closeDetail();
  await updateHeaderStats(); // rebuilds indexes + thread cache, updates nav counts
  applyFilters();
  toast(`Discarded ${automated.length} automated email(s)`, 'ok');
}
