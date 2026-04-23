// ═══════════════════════════════════════════════════════
//  EXPORT / CLEAR
// ═══════════════════════════════════════════════════════

async function exportData() {
  const emails   = await dbGetAll('emails');
  const atts     = await dbGetAll('attachments');
  const allSettings = await dbGetAll('settings');
  // Exclude sensitive keys from the JSON export
  const settings = allSettings.filter(s => s.key !== 'claudeApiKey');
  const blob = new Blob([JSON.stringify({ emails, attachments: atts, settings }, null, 2)],
                         { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `email-tracker-${new Date().toISOString().split('T')[0]}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// Slim export for the local AI pipeline (tools/analyze.py).
// Exports the *current filtered view*, excludes system/low-value emails,
// and keeps only the fields the analysis script needs. Uses the textBody
// as already processed at import time (signature-stripped).
async function exportForAI() {
  const src = (filteredEmails || []).filter(e => !e.isSystemEmail && !e.isLowValue);
  if (!src.length) {
    toast('No emails in current view after excluding system/low-value', 'warn');
    return;
  }

  const existingInsights = await dbGetAll('insights');
  const analyzedIds = new Set(existingInsights.map(r => r.emailId));
  const unanalyzed = src.filter(e => !analyzedIds.has(e.id));
  const skipped = src.length - unanalyzed.length;

  if (!unanalyzed.length) {
    toast(`All ${src.length} email(s) already have insights — nothing to export`, 'warn');
    return;
  }
  if (skipped) toast(`Skipping ${skipped} already-analyzed email(s)`, 'ok');

  const slim = unanalyzed.map(e => ({
    id:              e.id,
    subject:         e.subject || '',
    fromAddr:        e.fromAddr || '',
    fromName:        e.fromName || '',
    toAddrs:         e.toAddrs || [],
    ccAddrs:         e.ccAddrs || [],
    date:            e.date || null,
    textBody:        e.textBody || '',
    tags:            e.tags || [],
    threadId:        e.threadId || null,
    status:          e.status || null,
    existingSummary: e.aiSummary || null,
    existingIntent:  e.aiIntent  || null,
  }));

  const payload = {
    schemaVersion: 1,
    exportedAt:    new Date().toISOString(),
    view:          currentView,
    count:         slim.length,
    skippedAlreadyAnalyzed: skipped,
    emails:        slim,
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `emails-for-ai-${new Date().toISOString().split('T')[0]}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast(`Exported ${slim.length} email(s) for AI analysis${skipped ? ` (${skipped} skipped — already analyzed)` : ''}`, 'ok');
}

async function exportSQLite() {
  toast('Building SQLite export…', '');

  // Lazy-load sql.js from CDN
  if (!window.SQL) {
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2/sql-wasm.js';
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
    window.SQL = await initSqlJs({
      locateFile: f => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2/${f}`
    });
  }

  const db = new window.SQL.Database();

  // ── Schema ─────────────────────────────────────────────────────────────────
  // Each table mirrors its IndexedDB store exactly. Array fields are stored
  // both as JSON text (for fidelity) and as normalized rows (for querying).
  db.run(`
    CREATE TABLE emails (
      id                   TEXT PRIMARY KEY,
      message_id           TEXT,
      in_reply_to          TEXT,
      subject              TEXT,
      from_addr            TEXT,
      from_name            TEXT,
      date                 TEXT,
      text_body            TEXT,
      status               TEXT,
      is_actionable        INTEGER,
      is_system_email      INTEGER,
      manual_system_override INTEGER,
      is_low_value         INTEGER,
      has_attachments      INTEGER,
      attachment_count     INTEGER,
      awaiting_since       TEXT,
      thread_id            TEXT,
      file_name            TEXT,
      ai_summary           TEXT,
      imported_at          INTEGER,
      -- array fields stored as JSON for full fidelity
      to_addrs_json        TEXT,
      cc_addrs_json        TEXT,
      references_json      TEXT,
      tags_json            TEXT,
      linked_issues_json   TEXT
    );

    -- Normalized email arrays (convenient for querying)
    CREATE TABLE email_tags (
      email_id  TEXT,
      tag       TEXT
    );
    CREATE TABLE email_addresses (
      email_id  TEXT,
      role      TEXT,   -- 'to' | 'cc' | 'ref'
      address   TEXT
    );
    CREATE TABLE email_issue_links (
      email_id  TEXT,
      issue_id  TEXT
    );

    CREATE TABLE attachments (
      id               TEXT PRIMARY KEY,
      email_id         TEXT,
      filename         TEXT,
      size             INTEGER,
      mime_type        TEXT,
      hash             TEXT,
      stored_path      TEXT,
      transmittal_ref  TEXT,
      source_party     TEXT,
      document_type    TEXT,
      is_nested        INTEGER,
      parent_filename  TEXT
    );

    CREATE TABLE tags (
      name  TEXT PRIMARY KEY
    );

    CREATE TABLE msg_index (
      message_id  TEXT PRIMARY KEY,
      email_id    TEXT
    );

    CREATE TABLE issues (
      id            TEXT PRIMARY KEY,
      title         TEXT,
      description   TEXT,
      status        TEXT,
      created_date  TEXT,
      updated_date  TEXT,
      linked_emails_json TEXT
    );
    CREATE TABLE issue_email_links (
      issue_id  TEXT,
      email_id  TEXT
    );

    CREATE TABLE smart_views (
      id             TEXT PRIMARY KEY,
      name           TEXT,
      icon           TEXT,
      rule_operator  TEXT,
      rules_json     TEXT,
      -- full object stored for complete fidelity
      raw_json       TEXT
    );

    CREATE TABLE settings (
      key    TEXT PRIMARY KEY,
      value  TEXT   -- JSON-serialized value
    );

    CREATE TABLE email_groups (
      id             TEXT PRIMARY KEY,
      name           TEXT,
      addresses_json TEXT,
      raw_json       TEXT
    );

    CREATE TABLE seen_ids (
      id  TEXT PRIMARY KEY
    );

    -- Indexes
    CREATE INDEX idx_emails_message_id  ON emails(message_id);
    CREATE INDEX idx_emails_thread_id   ON emails(thread_id);
    CREATE INDEX idx_emails_date        ON emails(date);
    CREATE INDEX idx_emails_from_addr   ON emails(from_addr);
    CREATE INDEX idx_emails_status      ON emails(status);
    CREATE INDEX idx_email_tags_email   ON email_tags(email_id);
    CREATE INDEX idx_email_tags_tag     ON email_tags(tag);
    CREATE INDEX idx_email_addr_email   ON email_addresses(email_id);
    CREATE INDEX idx_att_email          ON attachments(email_id);
    CREATE INDEX idx_issues_status      ON issues(status);
    CREATE INDEX idx_issues_email       ON issue_email_links(email_id);
  `);

  // ── Load all stores in parallel ────────────────────────────────────────────
  const [emails, atts, tags, msgIdx, issues, smartViews, settings, emailGroups, seenIds] =
    await Promise.all([
      dbGetAll('emails'),
      dbGetAll('attachments'),
      dbGetAll('tags'),
      dbGetAll('msgIndex'),
      dbGetAll('issues'),
      dbGetAll('smartViews'),
      dbGetAll('settings'),
      dbGetAll('emailGroups'),
      dbGetAll('seenIds'),
    ]);

  // ── emails ─────────────────────────────────────────────────────────────────
  const insertEmail = db.prepare(`INSERT INTO emails VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insertTag   = db.prepare(`INSERT INTO email_tags VALUES (?,?)`);
  const insertAddr  = db.prepare(`INSERT INTO email_addresses VALUES (?,?,?)`);
  const insertEIL   = db.prepare(`INSERT INTO email_issue_links VALUES (?,?)`);

  db.run('BEGIN');
  for (const e of emails) {
    insertEmail.run([
      e.id ?? null,
      e.messageId ?? null,
      e.inReplyTo ?? null,
      e.subject ?? null,
      e.fromAddr ?? null,
      e.fromName ?? null,
      e.date ?? null,
      e.textBody ?? null,
      e.status ?? null,
      e.isActionable ? 1 : 0,
      e.isSystemEmail ? 1 : 0,
      e.manualSystemOverride ? 1 : 0,
      e.isLowValue ? 1 : 0,
      e.hasAttachments ? 1 : 0,
      e.attachmentCount ?? 0,
      e.awaitingSince ?? null,
      e.threadId ?? null,
      e.fileName ?? null,
      e.aiSummary ?? null,
      e.importedAt ?? null,
      JSON.stringify(e.toAddrs ?? []),
      JSON.stringify(e.ccAddrs ?? []),
      JSON.stringify(e.references ?? []),
      JSON.stringify(e.tags ?? []),
      JSON.stringify(e.linkedIssues ?? []),
    ]);
    for (const tag     of (e.tags         || [])) insertTag.run([e.id, tag]);
    for (const addr    of (e.toAddrs      || [])) insertAddr.run([e.id, 'to',  addr]);
    for (const addr    of (e.ccAddrs      || [])) insertAddr.run([e.id, 'cc',  addr]);
    for (const ref     of (e.references   || [])) insertAddr.run([e.id, 'ref', ref]);
    for (const issueId of (e.linkedIssues || [])) insertEIL.run([e.id, issueId]);
  }
  db.run('COMMIT');
  insertEmail.free(); insertTag.free(); insertAddr.free(); insertEIL.free();

  // ── attachments ────────────────────────────────────────────────────────────
  const insertAtt = db.prepare(`INSERT INTO attachments VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  db.run('BEGIN');
  for (const a of atts) {
    insertAtt.run([
      a.id ?? null, a.emailId ?? null, a.filename ?? null,
      a.size ?? null, a.mimeType ?? null, a.hash ?? null,
      a.storedPath ?? null, a.transmittalRef ?? null,
      a.sourceParty ?? null, a.documentType ?? null,
      a.isNested ? 1 : 0, a.parentFilename ?? null,
    ]);
  }
  db.run('COMMIT');
  insertAtt.free();

  // ── tags ───────────────────────────────────────────────────────────────────
  const insertTagReg = db.prepare(`INSERT OR IGNORE INTO tags VALUES (?)`);
  db.run('BEGIN');
  for (const t of tags) insertTagReg.run([t.name ?? null]);
  db.run('COMMIT');
  insertTagReg.free();

  // ── msgIndex ───────────────────────────────────────────────────────────────
  const insertMsg = db.prepare(`INSERT OR IGNORE INTO msg_index VALUES (?,?)`);
  db.run('BEGIN');
  for (const m of msgIdx) insertMsg.run([m.messageId ?? null, m.emailId ?? null]);
  db.run('COMMIT');
  insertMsg.free();

  // ── issues ─────────────────────────────────────────────────────────────────
  const insertIssue = db.prepare(`INSERT INTO issues VALUES (?,?,?,?,?,?,?)`);
  const insertIEL   = db.prepare(`INSERT INTO issue_email_links VALUES (?,?)`);
  db.run('BEGIN');
  for (const i of issues) {
    insertIssue.run([
      i.id ?? null, i.title ?? null, i.description ?? null,
      i.status ?? null, i.createdDate ?? null, i.updatedDate ?? null,
      JSON.stringify(i.linkedEmails ?? []),
    ]);
    for (const emailId of (i.linkedEmails || [])) insertIEL.run([i.id, emailId]);
  }
  db.run('COMMIT');
  insertIssue.free(); insertIEL.free();

  // ── smartViews ─────────────────────────────────────────────────────────────
  const insertSV = db.prepare(`INSERT INTO smart_views VALUES (?,?,?,?,?,?)`);
  db.run('BEGIN');
  for (const sv of smartViews) {
    insertSV.run([
      sv.id ?? null, sv.name ?? null, sv.icon ?? null,
      sv.ruleOperator ?? null,
      JSON.stringify(sv.rules ?? []),
      JSON.stringify(sv),
    ]);
  }
  db.run('COMMIT');
  insertSV.free();

  // ── settings ───────────────────────────────────────────────────────────────
  const insertSetting = db.prepare(`INSERT INTO settings VALUES (?,?)`);
  db.run('BEGIN');
  for (const s of settings) insertSetting.run([s.key ?? null, JSON.stringify(s)]);
  db.run('COMMIT');
  insertSetting.free();

  // ── emailGroups ────────────────────────────────────────────────────────────
  const insertGroup = db.prepare(`INSERT INTO email_groups VALUES (?,?,?,?)`);
  db.run('BEGIN');
  for (const g of emailGroups) {
    insertGroup.run([
      g.id ?? null, g.name ?? null,
      JSON.stringify(g.addresses ?? g.addressList ?? []),
      JSON.stringify(g),
    ]);
  }
  db.run('COMMIT');
  insertGroup.free();

  // ── seenIds ────────────────────────────────────────────────────────────────
  const insertSeen = db.prepare(`INSERT OR IGNORE INTO seen_ids VALUES (?)`);
  db.run('BEGIN');
  for (const s of seenIds) insertSeen.run([s.id ?? null]);
  db.run('COMMIT');
  insertSeen.free();

  // ── Export ─────────────────────────────────────────────────────────────────
  const bytes = db.export();
  db.close();

  const blob = new Blob([bytes], { type: 'application/x-sqlite3' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `email-tracker-${new Date().toISOString().split('T')[0]}.sqlite`;
  a.click();
  URL.revokeObjectURL(url);
  toast(`SQLite exported — ${emails.length} emails, ${issues.length} issues, ${atts.length} attachments`, 'ok');
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

  const emails      = Array.isArray(data.emails)      ? data.emails      : [];
  const attachments = Array.isArray(data.attachments) ? data.attachments : [];
  const settings    = Array.isArray(data.settings)    ? data.settings    : [];

  if (emails.length === 0 && attachments.length === 0 && settings.length === 0) {
    toast('Nothing to import', 'err');
    return;
  }

  // Restore settings (skip sensitive keys; don't overwrite existing values)
  for (const s of settings) {
    if (!s.key || s.key === 'claudeApiKey') continue;
    const existing = await dbGet('settings', s.key);
    if (!existing) await dbPut('settings', s);
  }
  if (settings.length) {
    await loadCustomPatterns();
    await loadCustomQuotePatterns();
    await loadCustomSignaturePatterns();
    await loadSignatureRanges();
    await loadAiPrompts();
    await loadAttachTextLimit();
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

  await loadEmailList();
  await updateHeaderStats();
  showPanel('list');

  const parts = [];
  if (emailsAdded)   parts.push(`${emailsAdded} email${emailsAdded !== 1 ? 's' : ''} imported`);
  if (emailsSkipped) parts.push(`${emailsSkipped} skipped`);
  if (attsAdded)     parts.push(`${attsAdded} attachment${attsAdded !== 1 ? 's' : ''} imported`);
  toast(parts.length ? parts.join(', ') : 'Nothing new to import', emailsAdded || attsAdded ? 'ok' : '');
}

async function clearDB() {
  if (!confirm('Clear all data? This cannot be undone.')) return;
  await dbClear('emails');
  await dbClear('attachments');
  await dbClear('msgIndex');
  await dbClear('tags');
  await dbClear('issues');
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
  applyFilters();
  await updateHeaderStats();
  await updateNavCounts();
  toast(`Discarded ${automated.length} automated email(s)`, 'ok');
}
