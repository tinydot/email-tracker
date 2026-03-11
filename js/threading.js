// ═══════════════════════════════════════════════════════
//  THREAD LINKING (Lightweight - Reply Detection Only)
// ═══════════════════════════════════════════════════════

async function linkThreads() {
  const all = await dbGetAll('emails');

  // Build messageId → email map
  const msgMap = new Map();
  for (const e of all) {
    if (e.messageId) msgMap.set(e.messageId, e);
  }

  // Mark parents as replied when we find their responses
  for (const email of all) {
    if (email.inReplyTo && msgMap.has(email.inReplyTo)) {
      const parent = msgMap.get(email.inReplyTo);
      if (parent.status === 'awaiting') {
        parent.status = 'replied';
        await dbPut('emails', parent);
      }
    }
  }
}

// ═══════════════════════════════════════════════════════
//  THREAD COMPUTATION (On-demand via queries)
// ═══════════════════════════════════════════════════════

// Build message ID index for fast lookups
let msgIdIndex = new Map(); // messageId → email
let emailIdIndex = new Map(); // id → email (O(1) lookup)

function rebuildMsgIdIndex() {
  msgIdIndex.clear();
  emailIdIndex.clear();
  for (const e of allEmails) {
    if (e.messageId) msgIdIndex.set(e.messageId, e);
    emailIdIndex.set(e.id, e);
  }
}

function getThreadRoot(email) {
  if (!email.inReplyTo) return email;
  let current = email;
  let depth = 0;
  while (current.inReplyTo && depth < 20) {
    const parent = msgIdIndex.get(current.inReplyTo);
    if (!parent) break;
    current = parent;
    depth++;
  }
  return current;
}

function getThreadDepth(email) {
  if (!email.inReplyTo) return 0;
  let current = email;
  let depth = 0;
  while (current.inReplyTo && depth < 20) {
    const parent = msgIdIndex.get(current.inReplyTo);
    if (!parent) break;
    current = parent;
    depth++;
  }
  return depth;
}

function getThreadEmails(rootEmail) {
  const threadId = rootEmail.id;
  const root = getThreadRoot(rootEmail);
  const results = [root];
  
  // Find all emails that reply to this thread
  for (const e of allEmails) {
    if (e.id === root.id) continue;
    const eRoot = getThreadRoot(e);
    if (eRoot.id === root.id) {
      results.push(e);
    }
  }
  
  return results.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
}

// Maps root email ID → count of non-root members in that thread.
// Rebuilt once per allEmails load via buildThreadCache().
let threadReplyCountCache = new Map();

function buildThreadCache() {
  threadReplyCountCache = new Map();
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
