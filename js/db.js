// ═══════════════════════════════════════════════════════
//  DB — IndexedDB via lightweight wrapper
// ═══════════════════════════════════════════════════════
const DB_NAME    = 'EmailTracker';
const DB_VERSION = 9; // v9: removed issues store (legacy already dropped in v8)
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
