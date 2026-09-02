// ═══════════════════════════════════════════════════════
//  DB — IndexedDB via lightweight wrapper
// ═══════════════════════════════════════════════════════
const DB_NAME    = 'EmailTracker';
const DB_VERSION = 10; // v10: textBody moved out of `emails` into the `bodies` store
let db = null;

function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;

      // Emails store
      if (!db.objectStoreNames.contains('emails')) {
        const store = db.createObjectStore('emails', { keyPath: 'id' });
        store.createIndex('messageId',   'messageId',   { unique: false });
        store.createIndex('threadId',    'threadId',    { unique: false });
        store.createIndex('date',        'date',        { unique: false });
        store.createIndex('fromAddr',    'fromAddr',    { unique: false });
        store.createIndex('status',      'status',      { unique: false });
        store.createIndex('isActionable','isActionable',{ unique: false });
        store.createIndex('importedAt',  'importedAt',  { unique: false });
      }

      // Bodies store — one record per email, `{ id, text }`.
      // Bodies are kept out of the `emails` store so loading the corpus into
      // `allEmails` doesn't pull every body into the heap; they're read on
      // demand (detail view) or streamed with a cursor (search, maintenance).
      if (!db.objectStoreNames.contains('bodies')) {
        db.createObjectStore('bodies', { keyPath: 'id' });

        // Migrate inline bodies out of existing email records. Runs inside the
        // versionchange transaction, cursor-based so memory stays bounded
        // regardless of corpus size.
        if (e.oldVersion > 0) {
          const tx         = e.target.transaction;
          const emailStore = tx.objectStore('emails');
          const bodyStore  = tx.objectStore('bodies');
          let moved = 0;
          emailStore.openCursor().onsuccess = ev => {
            const cur = ev.target.result;
            if (!cur) {
              if (moved) console.log(`Migrated ${moved} email bodies to the bodies store`);
              return;
            }
            const rec = cur.value;
            if (typeof rec.textBody === 'string') {
              if (rec.textBody) { bodyStore.put({ id: rec.id, text: rec.textBody }); moved++; }
              delete rec.textBody;
              cur.update(rec);
            }
            cur.continue();
          };
        }
      }

      // Attachments store
      if (!db.objectStoreNames.contains('attachments')) {
        const astore = db.createObjectStore('attachments', { keyPath: 'id' });
        astore.createIndex('emailId', 'emailId', { unique: false });
        astore.createIndex('hash',    'hash',    { unique: false });
      }

      // Tags store (global tag list)
      if (!db.objectStoreNames.contains('tags')) {
        db.createObjectStore('tags', { keyPath: 'name' });
      }

      // MessageID index (for thread linking)
      if (!db.objectStoreNames.contains('msgIndex')) {
        db.createObjectStore('msgIndex', { keyPath: 'messageId' }); // → emailId
      }

      // Drop legacy issues store if present (v8 removal)
      if (db.objectStoreNames.contains('issues')) {
        db.deleteObjectStore('issues');
      }

      // Smart Views store (user-defined filter views)
      if (!db.objectStoreNames.contains('smartViews')) {
        db.createObjectStore('smartViews', { keyPath: 'id' });
      }

      // Settings store (key-value, e.g. custom automation patterns)
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }

      // Email Groups store (named lists of email addresses for smart view rules)
      if (!db.objectStoreNames.contains('emailGroups')) {
        db.createObjectStore('emailGroups', { keyPath: 'id' });
      }

      // Seen IDs store (tombstones for discarded emails — prevents reimport)
      if (!db.objectStoreNames.contains('seenIds')) {
        db.createObjectStore('seenIds', { keyPath: 'id' });
      }

      // Address Book store (contact profiles: role, job scope, projects)
      if (!db.objectStoreNames.contains('addressBook')) {
        const abStore = db.createObjectStore('addressBook', { keyPath: 'email' });
        abStore.createIndex('name', 'name', { unique: false });
      }

      // Drop legacy local-AI stores if present
      if (db.objectStoreNames.contains('insights')) {
        db.deleteObjectStore('insights');
      }
      if (db.objectStoreNames.contains('embeddings')) {
        db.deleteObjectStore('embeddings');
      }
    };
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
}

function dbPut(storeName, record) {
  return new Promise((res, rej) => {
    const tx    = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const req   = store.put(record);
    req.onsuccess = () => res(req.result);
    req.onerror   = () => rej(req.error);
  });
}

function dbGet(storeName, key) {
  return new Promise((res, rej) => {
    const tx    = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const req   = store.get(key);
    req.onsuccess = () => res(req.result);
    req.onerror   = () => rej(req.error);
  });
}

function dbGetAll(storeName) {
  return new Promise((res, rej) => {
    const tx    = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const req   = store.getAll();
    req.onsuccess = () => res(req.result);
    req.onerror   = () => rej(req.error);
  });
}

function dbGetByIndex(storeName, indexName, value) {
  return new Promise((res, rej) => {
    const tx    = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const idx   = store.index(indexName);
    const req   = idx.getAll(value);
    req.onsuccess = () => res(req.result);
    req.onerror   = () => rej(req.error);
  });
}

function dbDelete(storeName, key) {
  return new Promise((res, rej) => {
    const tx    = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const req   = store.delete(key);
    req.onsuccess = () => res();
    req.onerror   = () => rej(req.error);
  });
}

function dbClear(storeName) {
  return new Promise((res, rej) => {
    const tx    = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const req   = store.clear();
    req.onsuccess = () => res();
    req.onerror   = () => rej(req.error);
  });
}

// Streams every record in a store to `fn`, one at a time, so the whole store is
// never materialized in memory. `fn` must be synchronous — an await inside the
// callback would let the IndexedDB transaction auto-close mid-iteration. In
// 'readwrite' mode a record returned by `fn` is written back in place, which is
// also cheaper than a dbPut per record (one transaction instead of N).
// Resolves with the number of records written back.
function dbIterate(storeName, fn, mode = 'readonly') {
  return new Promise((res, rej) => {
    const tx    = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const req   = store.openCursor();
    let updated = 0;
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return;
      const out = fn(cur.value);
      if (out !== undefined && mode === 'readwrite') { cur.update(out); updated++; }
      cur.continue();
    };
    req.onerror   = () => rej(req.error);
    tx.oncomplete = () => res(updated);
    tx.onerror    = () => rej(tx.error);
  });
}

// Reads a specific set of keys in a single readonly transaction, handing each
// found record to `fn`. Bounded memory (nothing is accumulated here) and one
// transaction rather than one per key.
function dbGetMany(storeName, keys, fn) {
  return new Promise((res, rej) => {
    const tx    = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    for (const key of keys) {
      const req = store.get(key);
      req.onsuccess = () => { if (req.result !== undefined) fn(req.result); };
    }
    tx.oncomplete = () => res();
    tx.onerror    = () => rej(tx.error);
  });
}

// Streams every email paired with its body text, in key order, from a single
// readonly transaction. Both stores are keyed by the email id, so the body
// cursor is walked forward to each email's key rather than issuing a get per
// record — one pass over each store, one email and one body live at a time.
// `fn(email, bodyText)` must be synchronous; bodyless emails get ''.
function dbIterateEmailsWithBodies(fn) {
  return new Promise((res, rej) => {
    const tx       = db.transaction(['emails', 'bodies'], 'readonly');
    const emailReq = tx.objectStore('emails').openCursor();
    const bodyReq  = tx.objectStore('bodies').openCursor();

    let emailCur = null, bodyCur = null;
    let emailReady = false, bodyReady = false, bodyDone = false;

    // Runs once both cursors have settled; issues exactly one continue() per
    // call, so it is re-entered by whichever cursor it advanced.
    const step = () => {
      if (!emailReady || !bodyReady) return; // still waiting on the other cursor
      if (!emailCur) return;                 // emails exhausted — tx will complete
      const id = emailCur.value.id;
      if (!bodyDone && indexedDB.cmp(bodyCur.key, id) < 0) {
        bodyReady = false;
        bodyCur.continue(id); // skip bodies of emails that are gone
        return;
      }
      const text = (!bodyDone && indexedDB.cmp(bodyCur.key, id) === 0) ? bodyCur.value.text : '';
      fn(emailCur.value, text);
      emailReady = false;
      emailCur.continue();
    };

    emailReq.onsuccess = () => { emailCur = emailReq.result; emailReady = true; step(); };
    bodyReq.onsuccess  = () => {
      bodyCur = bodyReq.result;
      if (!bodyCur) bodyDone = true;
      bodyReady = true;
      step();
    };
    emailReq.onerror = () => rej(emailReq.error);
    bodyReq.onerror  = () => rej(bodyReq.error);
    tx.oncomplete    = () => res();
    tx.onerror       = () => rej(tx.error);
  });
}

// ── Email bodies ─────────────────────────────────────────
// Bodies live in their own store; these are the only accessors. Callers hold a
// body for as long as they need it and then let it go — never park one on an
// email object in `allEmails`, which is what this split exists to avoid.

async function getBody(id) {
  const rec = await dbGet('bodies', id);
  return rec ? rec.text : '';
}

function putBody(id, text) {
  return text
    ? dbPut('bodies', { id, text })
    : dbDelete('bodies', id); // empty body — no record rather than an empty one
}

function deleteBody(id) {
  return dbDelete('bodies', id);
}
