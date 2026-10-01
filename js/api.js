// ═══════════════════════════════════════════════════════
//  DATA API — one function per thing the UI does
// ═══════════════════════════════════════════════════════
//
// The same page runs in two modes:
//   v1 — static (GitHub Pages, file://): IndexedDB via the db.js helpers.
//   v2 — served by `python -m email_tracker serve`, which injects
//        window.EMAIL_V2_SERVER = true: the server's email.db via its API.
//
// Each function below has both branches, and the v1 branch is exactly the
// db.js calls the call site made before, so v1 behaviour is unchanged. Every
// function is async in both modes, so call sites only ever `await`.
//
// Elements marked data-v1-only are hidden in v2 (the browser-side import
// pipeline and its archive folder, Google Drive, Clear DB); data-v2-only the
// reverse (server import, the Needs Reply view).

const V2_SERVER = window.EMAIL_V2_SERVER === true;
document.documentElement.classList.toggle('v2-server', V2_SERVER);

// Fields the server lets the UI change on an email (EMAIL_PATCHABLE in store.py).
const _EMAIL_PATCHABLE = ['status', 'tags', 'tagExclusions', 'isSystemEmail', 'manualSystemOverride'];

const _enc = encodeURIComponent;

async function _api(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = typeof body === 'string' || body instanceof Blob ? body : JSON.stringify(body);
  }
  const resp = await fetch(path, opts);
  if (!resp.ok) {
    let detail = '';
    try { const j = await resp.json(); detail = j.detail || j.error || ''; } catch {}
    const msg = `Server ${resp.status} on ${method} ${path.split('?')[0]}${detail ? ': ' + detail : ''}`;
    if (typeof toast === 'function') toast(msg, 'err');
    throw new Error(msg);
  }
  return resp.json();
}

async function apiInit() {
  if (V2_SERVER) return;
  db = await openDB();
}

// ── Emails ───────────────────────────────────────────────

async function apiLoadEmails() {
  if (V2_SERVER) return _api('GET', '/api/emails');
  return dbGetAll('emails');
}

// Persist the user-editable fields of an in-memory email (tags, status, the
// automated flag). v1 writes the whole record, as it always did.
async function apiSaveEmail(email) {
  if (!V2_SERVER) return dbPut('emails', email);
  const fields = {};
  for (const k of _EMAIL_PATCHABLE) if (k in email) fields[k] = email[k];
  return _api('PATCH', `/api/emails/${_enc(email.id)}/fields`, fields);
}

async function apiSaveEmails(emails) {
  if (!V2_SERVER) { for (const e of emails) await dbPut('emails', e); return; }
  const items = emails.map(e => {
    const fields = {};
    for (const k of _EMAIL_PATCHABLE) if (k in e) fields[k] = e[k];
    return { id: e.id, fields };
  });
  for (let i = 0; i < items.length; i += 500) {
    await _api('POST', '/api/emails/patch-many', items.slice(i, i + 500));
  }
}

async function apiDeleteEmail(id) {
  if (V2_SERVER) return _api('DELETE', `/api/emails/${_enc(id)}/record`);
  await dbDelete('emails', id);
  await deleteBody(id);
  const atts = await dbGetByIndex('attachments', 'emailId', id);
  for (const a of atts) await dbDelete('attachments', a.id);
}

// Delete the given automated emails, tombstoning their ids so they're never
// re-imported. v2 decides the set server-side (same rule) and returns the ids.
async function apiDiscardAutomated(emails) {
  if (V2_SERVER) return (await _api('POST', '/api/emails/discard-automated')).discarded;
  for (const email of emails) {
    await dbPut('seenIds', { id: email.id });
    await dbDelete('emails', email.id);
    await deleteBody(email.id);
    await dbDelete('msgIndex', email.messageId);
    const atts = await dbGetByIndex('attachments', 'emailId', email.id);
    for (const att of atts) await dbDelete('attachments', att.id);
  }
  return emails.map(e => e.id);
}

// ── Bodies ───────────────────────────────────────────────

async function apiGetBody(id) {
  if (V2_SERVER) return (await _api('GET', `/api/emails/${_enc(id)}/body`)).text;
  return getBody(id);
}

async function apiPutBody(id, text) {
  if (V2_SERVER) return _api('PUT', `/api/emails/${_enc(id)}/body`, { text: text || '' });
  return putBody(id, text);
}

// Calls fn({id, text}) for each of `ids` that has a body — nothing accumulated.
async function apiForEachBody(ids, fn) {
  if (!V2_SERVER) return dbGetMany('bodies', ids, fn);
  const list = [...ids];
  for (let i = 0; i < list.length; i += 1000) {
    const recs = await _api('POST', '/api/bodies', { ids: list.slice(i, i + 1000) });
    for (const rec of recs) fn(rec);
  }
}

// Ids whose body contains `term` (already lowercased by the caller).
async function apiSearchBodies(term) {
  if (V2_SERVER) return new Set(await _api('GET', '/api/search/bodies?q=' + _enc(term)));
  const ids = new Set();
  await dbIterate('bodies', rec => {
    if (rec.text && rec.text.toLowerCase().includes(term)) ids.add(rec.id);
  });
  return ids;
}

// ── Attachments ──────────────────────────────────────────

// Every attachment's metadata. v2 leaves out extractedText, which nothing that
// lists attachments reads; the detail panel's apiEmailAttachments includes it.
async function apiListAttachments() {
  if (V2_SERVER) return _api('GET', '/api/attachments');
  return dbGetAll('attachments');
}

async function apiEmailAttachments(emailId) {
  if (V2_SERVER) return _api('GET', `/api/emails/${_enc(emailId)}/attachments`);
  return dbGetByIndex('attachments', 'emailId', emailId);
}

async function apiToggleAttachmentBlacklist(attId) {
  if (V2_SERVER) return _api('POST', `/api/attachments/${_enc(attId)}/toggle-blacklist`);
  const att = await dbGet('attachments', attId);
  if (!att) return null;
  att.isBlacklisted = !att.isBlacklisted;
  await dbPut('attachments', att);
  return att;
}

// ── Smart views, email groups, settings, address book ────

const _DOC_ROUTES = { smartViews: 'smart-views', emailGroups: 'email-groups' };
const _DOC_KEYS   = { smartViews: 'id', emailGroups: 'id' };

async function apiListDocs(store) {
  if (V2_SERVER) return _api('GET', `/api/${_DOC_ROUTES[store]}`);
  return dbGetAll(store);
}

async function apiPutDoc(store, record) {
  if (V2_SERVER) return _api('PUT', `/api/${_DOC_ROUTES[store]}/${_enc(record[_DOC_KEYS[store]])}`, record);
  return dbPut(store, record);
}

async function apiDeleteDoc(store, key) {
  if (V2_SERVER) return _api('DELETE', `/api/${_DOC_ROUTES[store]}/${_enc(key)}`);
  return dbDelete(store, key);
}

// Resolves to the settings record or undefined, like dbGet.
async function apiGetSetting(key) {
  if (V2_SERVER) return (await _api('GET', `/api/settings/${_enc(key)}`)) ?? undefined;
  return dbGet('settings', key);
}

async function apiPutSetting(record) {
  if (V2_SERVER) return _api('PUT', `/api/settings/${_enc(record.key)}`, record);
  return dbPut('settings', record);
}

async function apiListContacts() {
  if (V2_SERVER) return _api('GET', '/api/address-book');
  return dbGetAll('addressBook');
}

async function apiGetContact(email) {
  if (V2_SERVER) return (await _api('GET', `/api/address-book/${_enc(email)}`)) ?? undefined;
  return dbGet('addressBook', email);
}

async function apiPutContact(contact) {
  if (V2_SERVER) return _api('PUT', `/api/address-book/${_enc(contact.email)}`, contact);
  return dbPut('addressBook', contact);
}

async function apiDeleteContact(email) {
  if (V2_SERVER) return _api('DELETE', `/api/address-book/${_enc(email)}`);
  return dbDelete('addressBook', email);
}

// ── Maintenance (v2 only: v1 runs these as cursor passes in settings.js) ──

async function apiMaintenance(job) {
  return (await _api('POST', `/api/maintenance/${job}`)).fixed;
}

// ── Server ingest and archived originals (v2 only) ──────────
// v1 imports in the browser (import.js); these are what v2 does instead.

async function apiIngestEml(file) {
  const resp = await fetch('/api/ingest/eml?name=' + _enc(file.name), {
    method: 'POST', headers: { 'Content-Type': 'message/rfc822' }, body: file,
  });
  if (!resp.ok) {
    let detail = '';
    try { detail = (await resp.json()).detail || ''; } catch {}
    throw new Error(`Server ${resp.status}${detail ? ': ' + detail : ''}`);
  }
  return resp.json();
}

async function apiIngestFinish()      { return _api('POST', '/api/ingest/finish'); }
async function apiThunderbirdInfo()   { return _api('GET', '/api/ingest/thunderbird'); }
async function apiThunderbirdScan()   { return _api('POST', '/api/ingest/thunderbird'); }
async function apiJob(name)           { return _api('GET', `/api/ingest/job/${_enc(name)}`); }

// Re-read an email's archived original: { rawTextBody, attachmentsAdded, email }.
async function apiReparse(id)         { return _api('POST', `/api/emails/${_enc(id)}/reparse`); }

function apiOriginalUrl(id)           { return `/api/emails/${_enc(id)}/eml`; }
