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
// record), so backups stay portable in both directions — see applyBackupStream for
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

  let result;
  try {
    result = await applyBackupStream(file.stream());
  } catch (err) {
    toast(err.message || 'Invalid JSON file', 'err');
    return;
  }
  if (result.totalRecords === 0) return; // toast already shown by applyBackupStream
  toast(result.parts.length ? result.parts.join(', ') : 'Nothing new to import',
        result.anyAdded ? 'ok' : '');
}

// ── Reading a backup back in ──────────────────────────────
// The mirror of streamBackupJson: the file is consumed as a stream and applied
// record by record, so restoring a large backup no longer peaks at its full
// size (the text plus the parsed object graph, twice over).
//
// A full JSON parser isn't needed for this. The document is a flat object whose
// values are arrays of records, so the scanner below only has to find record
// *boundaries*; each record's text is then handed to JSON.parse, which does the
// real parsing. All it must get right is string state — quotes, and escapes
// inside them — so that braces in a subject line don't count as structure.

const _BK_AWAIT_ROOT = 0, _BK_KEY = 1, _BK_IN_KEY = 2, _BK_COLON = 3,
      _BK_VALUE = 4, _BK_ELEMENT = 5, _BK_CAPTURE = 6, _BK_DONE = 7;

const _bkIsSpace = ch => ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t';

// Feed chunks in order, then call end(). onValue(key, value) fires once per
// element of each top-level array, and once for each scalar top-level field.
function makeBackupScanner(onValue) {
  let phase = _BK_AWAIT_ROOT;
  let keyRaw = '', curKey = null;
  let keyInStr = false, keyEsc = false;
  // capture state
  let buf = '', kind = '', depth = 0, inStr = false, esc = false, fromArray = false;

  const startCapture = (ch, inArray) => {
    buf = ch; depth = 0; inStr = false; esc = false; fromArray = inArray;
    if (ch === '{' || ch === '[') { kind = 'struct'; depth = 1; }
    else if (ch === '"')          { kind = 'string'; inStr = true; }
    else                          { kind = 'scalar'; }
    phase = _BK_CAPTURE;
  };

  const emit = () => {
    onValue(curKey, JSON.parse(buf));
    buf = '';
    phase = fromArray ? _BK_ELEMENT : _BK_KEY;
  };

  return {
    feed(chunk) {
      for (let i = 0; i < chunk.length; i++) {
        const ch = chunk[i];

        switch (phase) {
          case _BK_CAPTURE: {
            // A bare scalar ends at the first delimiter, which belongs to the
            // enclosing structure and must be re-read in the next phase.
            if (kind === 'scalar' && !inStr &&
                (_bkIsSpace(ch) || ch === ',' || ch === '}' || ch === ']')) {
              emit();
              i--;
              break;
            }
            buf += ch;
            if (inStr) {
              if (esc)                 esc = false;
              else if (ch === '\\')    esc = true;
              else if (ch === '"') {
                inStr = false;
                if (kind === 'string' && depth === 0) emit();
              }
            } else if (ch === '"')                     inStr = true;
            else if (ch === '{' || ch === '[')         depth++;
            else if (ch === '}' || ch === ']') {
              depth--;
              if (depth === 0) emit();
            }
            break;
          }

          case _BK_AWAIT_ROOT:
            if (_bkIsSpace(ch)) break;
            if (ch !== '{') throw new Error('Not a backup file');
            phase = _BK_KEY;
            break;

          case _BK_KEY:
            if (_bkIsSpace(ch) || ch === ',') break;
            if (ch === '}') { phase = _BK_DONE; break; }
            if (ch !== '"') throw new Error('Malformed backup near "' + ch + '"');
            keyRaw = ''; keyInStr = true; keyEsc = false;
            phase = _BK_IN_KEY;
            break;

          case _BK_IN_KEY:
            if (keyEsc)              { keyRaw += ch; keyEsc = false; }
            else if (ch === '\\')    { keyRaw += ch; keyEsc = true; }
            else if (ch === '"')     { curKey = JSON.parse('"' + keyRaw + '"'); phase = _BK_COLON; }
            else                       keyRaw += ch;
            break;

          case _BK_COLON:
            if (_bkIsSpace(ch)) break;
            if (ch !== ':') throw new Error('Malformed backup: expected ":"');
            phase = _BK_VALUE;
            break;

          case _BK_VALUE:
            if (_bkIsSpace(ch)) break;
            // A top-level array is walked element by element; anything else is a
            // scalar field (schemaVersion, exportedAt) and captured whole.
            if (ch === '[') phase = _BK_ELEMENT;
            else            startCapture(ch, false);
            break;

          case _BK_ELEMENT:
            if (_bkIsSpace(ch) || ch === ',') break;
            if (ch === ']') { phase = _BK_KEY; break; }
            startCapture(ch, true);
            break;

          case _BK_DONE:
            if (!_bkIsSpace(ch)) throw new Error('Trailing data after backup');
            break;
        }
      }
    },

    end() {
      if (phase !== _BK_DONE) throw new Error('Backup file ended unexpectedly');
    },
  };
}

// Drives the scanner over a ReadableStream of bytes. `onChunkEnd` is awaited
// between chunks — that's where the caller writes what it has collected, and
// what keeps the document from piling up in memory.
async function readBackupStream(stream, onValue, onChunkEnd) {
  const reader  = stream.pipeThrough(new TextDecoderStream()).getReader();
  const scanner = makeBackupScanner(onValue);
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    scanner.feed(value);          // may emit many records synchronously
    await onChunkEnd();
  }
  scanner.end();
  await onChunkEnd();
}

// Which field each store is keyed by — records missing it can't be inserted.
const BACKUP_STORE_KEYS = {
  emails: 'id', attachments: 'id', tags: 'name', msgIndex: 'messageId',
  smartViews: 'id', settings: 'key', emailGroups: 'id', seenIds: 'id',
  addressBook: 'email',
};

// Merge a backup into the local database, reading it as a stream. Shared by JSON
// import and Google Drive restore. Skip-if-existing throughout, so a restore
// never clobbers the user's current state.
//
// Records are buffered only between chunks and written in batched transactions,
// so memory stays flat regardless of backup size. The trade-off against the old
// parse-it-all-first approach is that a file which turns out to be malformed
// partway through leaves the records before that point already restored; the
// caller reports how many. Re-running a fixed file is safe — it skips them.
async function applyBackupStream(stream) {
  const pending = {};
  for (const k of Object.keys(BACKUP_STORE_KEYS)) pending[k] = [];

  const added = { emails: 0, attachments: 0, tags: 0, msgIndex: 0, smartViews: 0,
                  settings: 0, emailGroups: 0, seenIds: 0, addressBook: 0 };
  let emailsSkipped = 0, total = 0;
  const seenStores = new Set();

  // Emails need their inlined body split back out, and a msgIndex entry, but
  // only for the ones that were actually new.
  const flushEmails = async () => {
    const batch = pending.emails;
    if (!batch.length) return;
    pending.emails = [];
    const metas = [];
    const extras = new Map(); // id → { body, messageId }
    for (const email of batch) {
      if (!email.id) continue;
      let body = typeof email.textBody === 'string' ? email.textBody : '';
      if (body) body = body.replace(/(\n[ \t]*){2,}/g, '\n');
      delete email.textBody;
      metas.push(email);
      extras.set(email.id, { body, messageId: email.messageId });
    }
    const { addedKeys, skipped } = await dbAddMissing('emails', metas);
    emailsSkipped += skipped;
    added.emails  += addedKeys.length;

    const bodies = [], msgIds = [];
    for (const id of addedKeys) {
      const x = extras.get(id);
      if (!x) continue;
      if (x.body)      bodies.push({ id, text: x.body });
      if (x.messageId) msgIds.push({ messageId: x.messageId, emailId: id });
    }
    await dbPutMany('bodies', bodies);
    await dbPutMany('msgIndex', msgIds);   // overwrites, as the old code did
  };

  const flushStore = async name => {
    const batch = pending[name];
    if (!batch.length) return;
    pending[name] = [];
    const keyField = BACKUP_STORE_KEYS[name];
    const valid = batch.filter(r => r && r[keyField] != null &&
                                    !(name === 'settings' && r.handle)); // machine-local
    const { addedKeys } = await dbAddMissing(name, valid);
    added[name] += addedKeys.length;
  };

  // Settings before emails so a restored config is in place; emails before
  // msgIndex so an email's own index entry wins over a stale one in the file.
  const flush = async () => {
    await flushStore('settings');
    await flushEmails();
    for (const name of ['attachments', 'tags', 'msgIndex', 'smartViews',
                        'emailGroups', 'seenIds', 'addressBook']) {
      await flushStore(name);
    }
  };

  const onValue = (key, value) => {
    if (!pending[key]) return; // schemaVersion, exportedAt, unknown keys
    pending[key].push(value);
    seenStores.add(key);
    total++;
  };

  try {
    await readBackupStream(stream, onValue, flush);
  } catch (err) {
    await flush(); // keep whatever was already parsed
    const done = Object.values(added).reduce((a, b) => a + b, 0);
    if (done) await loadEmailList();
    throw new Error(err.message + (done ? ` — ${done} record${done !== 1 ? 's' : ''} were restored before the error` : ''));
  }

  if (total === 0) {
    toast('Nothing to import', 'err');
    return { parts: [], anyAdded: false, totalRecords: 0 };
  }

  // Reload in-memory caches and redraw affected UI.
  if (seenStores.has('settings')) {
    await loadCustomPatterns();
    await loadCustomQuotePatterns();
    await loadCustomSignaturePatterns();
    await loadSignatureRanges();
    await loadAttachTextLimit();
    if (typeof loadGDriveSettings === 'function') await loadGDriveSettings();
  }
  if (seenStores.has('emailGroups')) await loadEmailGroups();
  if (seenStores.has('smartViews') || seenStores.has('settings') || seenStores.has('emailGroups')) {
    await loadSmartViews();
  }

  await loadEmailList();
  await updateHeaderStats();
  showPanel('list');

  const parts = [];
  const plural = (n, word) => `${n} ${word}${n !== 1 ? 's' : ''}`;
  if (added.emails)      parts.push(plural(added.emails, 'email'));
  if (emailsSkipped)     parts.push(`${emailsSkipped} skipped`);
  if (added.attachments) parts.push(plural(added.attachments, 'attachment'));
  if (added.smartViews)  parts.push(plural(added.smartViews, 'smart view'));
  if (added.emailGroups) parts.push(plural(added.emailGroups, 'email group'));
  if (added.addressBook) parts.push(plural(added.addressBook, 'contact'));
  if (added.tags)        parts.push(plural(added.tags, 'tag'));
  if (added.seenIds)     parts.push(plural(added.seenIds, 'tombstone'));
  if (added.msgIndex)    parts.push(`${added.msgIndex} msgId`);

  const anyAdded = Object.values(added).some(Boolean);
  return { parts, anyAdded, totalRecords: total };
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
