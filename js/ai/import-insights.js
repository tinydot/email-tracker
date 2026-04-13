// ═══════════════════════════════════════════════════════
//  AI — import-insights.js
//  Reads an insights.json produced by tools/analyze.py,
//  validates its shape, and writes each entry to the
//  `insights` and `embeddings` IndexedDB stores.
// ═══════════════════════════════════════════════════════

async function importInsightsFile(file) {
  let raw;
  try {
    raw = await file.text();
  } catch (e) {
    toast('Could not read file: ' + e.message, 'warn');
    return;
  }

  let top;
  try {
    top = JSON.parse(raw);
  } catch (e) {
    toast('Invalid JSON in insights file', 'warn');
    return;
  }

  // Validate top-level shape
  if (!top || typeof top !== 'object' || typeof top.insights !== 'object') {
    toast('insights.json is missing the "insights" object', 'warn');
    return;
  }

  const embedModel = top.embedModel || 'unknown';
  const embedDim   = top.embedDim   || 0;
  const entries    = Object.entries(top.insights);

  if (!entries.length) {
    toast('insights.json contains no entries', 'warn');
    return;
  }

  toast(`Importing ${entries.length} insight(s)…`);

  let count = 0;
  for (const [emailId, entry] of entries) {
    if (!emailId || typeof entry !== 'object') continue;

    // Separate embedding from the rest of the fields
    const { embedding, ...fields } = entry;

    // Store insight record (no embedding — keeps it lean)
    await dbPut('insights', {
      emailId,
      ...fields,
    });

    // Store embedding separately as Float32Array
    if (Array.isArray(embedding) && embedding.length > 0) {
      await dbPut('embeddings', {
        emailId,
        vector: new Float32Array(embedding),
        dim:    embedding.length,
        model:  embedModel,
      });
    }

    count++;
    if (count % 50 === 0) {
      toast(`Imported ${count} / ${entries.length}…`);
    }
  }

  toast(`Imported ${count} insight(s) from ${top.modelVersion || 'local AI'}`, 'ok');
  applyFilters();
  renderEmailList();
}

async function clearAllInsights() {
  if (!confirm('Clear all local AI insights and embeddings? This cannot be undone.')) return;
  await dbClear('insights');
  await dbClear('embeddings');
  toast('All local AI insights cleared', 'ok');
  if (selectedEmail) openDetail(selectedEmail);
}
