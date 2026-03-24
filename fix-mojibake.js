// ─────────────────────────────────────────────────────────────────────────────
//  fix-mojibake.js
//
//  Repairs garbled UTF-8 text (e.g. "yesterdayâs" → "yesterday's") in the
//  EmailTracker IndexedDB caused by bodies being stored as raw Latin-1 binary
//  strings instead of being decoded through TextDecoder.
//
//  HOW TO USE
//  ──────────
//  1. Open index.html in your browser (the app must be fully loaded).
//  2. Open the browser DevTools console (F12 → Console).
//  3. Paste the entire contents of this file and press Enter.
//  4. Wait for the "Done" summary to appear.
//
//  The script is safe to run multiple times — it skips emails that are
//  already correctly encoded.
// ─────────────────────────────────────────────────────────────────────────────

(async () => {
  // ── Helpers ────────────────────────────────────────────────────────────────

  /**
   * Attempt to fix a single mojibake string.
   *
   * Mojibake here means: UTF-8 bytes were stored verbatim as Latin-1
   * characters (each char code == the byte value).  We reverse this by
   * re-encoding each character back to its byte value and then running
   * TextDecoder over the resulting bytes.
   *
   * Returns the fixed string if the bytes form valid UTF-8 AND the result
   * differs from the input; otherwise returns the original unchanged.
   */
  function fixMojibake(str) {
    if (!str || typeof str !== 'string') return str;
    // Skip pure ASCII — nothing to fix.
    if (!/[\x80-\xFF]/.test(str)) return str;
    try {
      const bytes = Uint8Array.from(str, c => c.charCodeAt(0));
      // fatal:true throws on invalid UTF-8 sequences so we never corrupt
      // strings that are already valid Unicode (but not Latin-1 mojibake).
      const fixed = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return fixed !== str ? fixed : str;
    } catch {
      // Not valid UTF-8 when re-interpreted — leave untouched.
      return str;
    }
  }

  /**
   * Apply fixMojibake to every string field that passes through decodeBody
   * during import (textBody) plus display fields that may be affected.
   * Returns { record, changed } where changed is true if any field was fixed.
   */
  function fixEmail(email) {
    let changed = false;
    const fields = ['textBody', 'subject', 'fromName'];
    for (const f of fields) {
      if (typeof email[f] === 'string') {
        const fixed = fixMojibake(email[f]);
        if (fixed !== email[f]) {
          email[f] = fixed;
          changed = true;
        }
      }
    }
    return changed;
  }

  // ── Main ───────────────────────────────────────────────────────────────────

  // The app exposes `db` as a global once openDB() resolves.
  if (!window.db) {
    console.error('[fix-mojibake] db is not available. Make sure the app is fully loaded first.');
    return;
  }

  console.log('[fix-mojibake] Scanning emails…');

  const all = await dbGetAll('emails');
  console.log(`[fix-mojibake] ${all.length} emails found.`);

  let fixed = 0;
  let skipped = 0;
  let errors = 0;

  for (const email of all) {
    const changed = fixEmail(email);
    if (!changed) {
      skipped++;
      continue;
    }
    try {
      await dbPut('emails', email);
      fixed++;
      console.log(`[fix-mojibake] Fixed: ${email.id} — "${email.subject}"`);
    } catch (err) {
      errors++;
      console.error(`[fix-mojibake] Error saving ${email.id}:`, err);
    }
  }

  console.log(
    `[fix-mojibake] Done. Fixed: ${fixed} | Already correct: ${skipped} | Errors: ${errors}`
  );

  // Reload the email list so the UI reflects the corrections.
  if (fixed > 0 && typeof loadEmailList === 'function') {
    console.log('[fix-mojibake] Reloading email list…');
    await loadEmailList();
    console.log('[fix-mojibake] Reload complete.');
  }
})();
