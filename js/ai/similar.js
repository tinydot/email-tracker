// ═══════════════════════════════════════════════════════
//  AI — similar.js
//  Cosine-similarity search over local embeddings.
//  No ANN index, no workers — straightforward O(n) scan.
// ═══════════════════════════════════════════════════════

function cosineSimilarity(a, b) {
  // Both a and b are Float32Array of the same length.
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot  += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

// Returns top-k most similar emails by cosine similarity.
// Result: [{emailId, score, email}] sorted descending.
async function findSimilarEmails(emailId, k = 10) {
  // Load the query vector
  const queryRec = await dbGet('embeddings', emailId);
  if (!queryRec || !queryRec.vector || queryRec.vector.length === 0) {
    return [];
  }
  const queryVec = queryRec.vector instanceof Float32Array
    ? queryRec.vector
    : new Float32Array(queryRec.vector);

  // Load all embedding records
  const allEmbs = await dbGetAll('embeddings');

  const scored = [];
  for (const rec of allEmbs) {
    if (rec.emailId === emailId) continue; // skip self
    if (!rec.vector || rec.vector.length !== queryVec.length) continue;
    const vec = rec.vector instanceof Float32Array
      ? rec.vector
      : new Float32Array(rec.vector);
    const score = cosineSimilarity(queryVec, vec);
    scored.push({ emailId: rec.emailId, score });
  }

  // Sort descending by score
  scored.sort((a, b) => b.score - a.score);
  const topK = scored.slice(0, k);

  // Attach email objects for display (from allEmails cache)
  return topK.map(r => ({
    ...r,
    email: emailIdIndex.get(r.emailId) || null,
  }));
}
