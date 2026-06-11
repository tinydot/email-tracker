// ═══════════════════════════════════════════════════════
//  THREAD COMPUTATION (On-demand via queries)
// ═══════════════════════════════════════════════════════

// Build message ID index for fast lookups
let msgIdIndex = new Map(); // messageId → email
let emailIdIndex = new Map(); // id → email (O(1) lookup)

// Memoized thread resolution — email.id → root email / depth.
// Kept in Maps rather than on the email objects so dbPut never persists them.
let threadRootCache  = new Map();
let threadDepthCache = new Map();

// Maps root email ID → count of non-root members in that thread.
// Rebuilt once per allEmails load via buildThreadCache().
let threadReplyCountCache = new Map();

function rebuildMsgIdIndex() {
  msgIdIndex.clear();
  emailIdIndex.clear();
  // Root/depth caches are derived from msgIdIndex — invalidate together
  threadRootCache.clear();
  threadDepthCache.clear();
  for (const e of allEmails) {
    if (e.messageId) msgIdIndex.set(e.messageId, e);
    emailIdIndex.set(e.id, e);
  }
}

// Walk the inReplyTo chain once, memoizing root + depth for every email
// visited along the way. Subsequent lookups are O(1).
function _resolveThread(email) {
  if (threadRootCache.has(email.id)) {
    return { root: threadRootCache.get(email.id), depth: threadDepthCache.get(email.id) };
  }
  const chain = [];
  let current = email;
  while (current.inReplyTo && chain.length < 20 && !threadRootCache.has(current.id)) {
    const parent = msgIdIndex.get(current.inReplyTo);
    if (!parent) break;
    chain.push(current);
    current = parent;
  }
  let root, depth;
  if (threadRootCache.has(current.id)) {
    root  = threadRootCache.get(current.id);
    depth = threadDepthCache.get(current.id);
  } else {
    root  = current;
    depth = 0;
    threadRootCache.set(current.id, root);
    threadDepthCache.set(current.id, 0);
  }
  for (let i = chain.length - 1; i >= 0; i--) {
    depth++;
    threadRootCache.set(chain[i].id, root);
    threadDepthCache.set(chain[i].id, depth);
  }
  return { root, depth };
}

function getThreadRoot(email) {
  return _resolveThread(email).root;
}

function getThreadDepth(email) {
  return _resolveThread(email).depth;
}

function getThreadEmails(rootEmail) {
  const rootId = getThreadRoot(rootEmail).id;
  return allEmails
    .filter(e => getThreadRoot(e).id === rootId)
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
}

function buildThreadCache() {
  threadRootCache.clear();
  threadDepthCache.clear();
  threadReplyCountCache.clear();
  for (const e of allEmails) {
    const rootId = getThreadRoot(e).id;
    if (e.id !== rootId) {
      threadReplyCountCache.set(rootId, (threadReplyCountCache.get(rootId) || 0) + 1);
    }
  }
}

function hasReplies(email) {
  return (threadReplyCountCache.get(getThreadRoot(email).id) || 0) > 0;
}

function countThreadReplies(email) {
  return threadReplyCountCache.get(getThreadRoot(email).id) || 0;
}
