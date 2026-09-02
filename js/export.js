// ═══════════════════════════════════════════════════════
//  EXPORT / CLEAR
// ═══════════════════════════════════════════════════════

// The backup payload is written as a JSON *stream* rather than assembled as one
// object and stringified: the corpus no longer has to fit in the JS heap twice
// (once as records, once as a pretty-printed string). Records are serialized one
// at a time and flushed into Blob chunks, which live in browser-managed storage
// instead of the heap.
//
// The output shape is unchanged (schemaVersion 3, bodies re-inlined on each email
// record), so backups stay portable in both directions — see applyBackupData for
// the reverse split. Only the pretty-printing is gone, which also shrinks the file.

const BACKUP_CHUNK_CHARS = 1 << 20; // flush to a Blob roughly every 1M chars

// Collects written text into Blob chunks, keeping at most one chunk's worth of
// string in the heap at a time. `write` is synchronous so it is safe to call
// from inside an IndexedDB cursor callback.
function makeBackupSink() {
  const parts = [];
  let buf = '';
  return {
    write(str) {
      buf += str;
      if (buf.length >= BACKUP_CHUNK_CHARS) { parts.push(new Blob([buf])); buf = ''; }
    },
    // Concatenates the chunks by reference — no heap copy of the whole file
    finish() {
      if (buf) { parts.push(new Blob([buf])); buf = ''; }
      return new Blob(parts, { type: 'application/json' });
    },
  };
}

// Writes the whole backup document to `write`, store by store. Returns the number
// of emails written, for the caller's progress reporting.
async function streamBackupJson(write) {
  write('{"schemaVersion":3,"exportedAt":' + JSON.stringify(new Date().toISOString()));

  // Emails carry their body inline; the two stores are merge-joined on id so
  // neither is ever fully resident.
  write(',"emails":[');
  let emailCount = 0;
  await dbIterateEmailsWithBodies((email, text) => {
    write((emailCount ? ',' : '') + JSON.stringify(text ? { ...email, textBody: text } : email));
    emailCount++;
  });
  write(']');

  // Every remaining store is streamed the same way. Attachments carry extracted
  // text, so that one is no smaller a concern than the emails.
  // Folder handles are machine-local and not JSON-serializable.
  const stores = [
    ['attachments', 'attachments', null],
    ['tags',        'tags',        null],
    ['msgIndex',    'msgIndex',    null],
    ['smartViews',  'smartViews',  null],
    ['settings',    'settings',    rec => !rec.handle],
    ['emailGroups', 'emailGroups', null],
    ['seenIds',     'seenIds',     null],
    ['addressBook', 'addressBook', null],
  ];
  for (const [key, storeName, keep] of stores) {
    write(',"' + key + '":[');
    let n = 0;
    await dbIterate(storeName, rec => {
      if (keep && !keep(rec)) return;
      write((n ? ',' : '') + JSON.stringify(rec));
      n++;
    });
    write(']');
  }

  write('}');
  return emailCount;
}

// Builds the backup as a Blob without ever holding the whole document in the heap.
async function buildBackupBlob() {
  const sink  = makeBackupSink();
  const count = await streamBackupJson(sink.write);
  return { blob: sink.finish(), emailCount: count };
}

async function exportData() {
  const { blob } = await buildBackupBlob();

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
    // Split the inlined body back out into the bodies store
    let body = typeof email.textBody === 'string' ? email.textBody : '';
    if (body) body = body.replace(/(\n[ \t]*){2,}/g, '\n');
    delete email.textBody;
    await dbPut('emails', email);
    if (body) await putBody(email.id, body);
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
  await dbClear('bodies');
  await dbClear('attachments');
  await dbClear('msgIndex');
  await dbClear('tags');
  await dbClear('seenIds');
  allEmails = [];
  filteredEmails = [];
  selectedEmail = null;
  searchBodyMatches = null;
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
    await deleteBody(email.id);
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
