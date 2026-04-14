// ═══════════════════════════════════════════════════════
//  SMART VIEWS — Settings panel
//  showSettings() and all settings sub-sections:
//  custom automation patterns, email groups, and the
//  maintenance utilities (normalize line breaks, etc.).
// ═══════════════════════════════════════════════════════

// --- Email Groups CRUD ---

async function createEmailGroup(name) {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const group = { id: 'eg-' + Date.now(), name: trimmed, members: [], createdAt: new Date().toISOString() };
  await dbPut('emailGroups', group);
  emailGroups.push(group);
  return group;
}

async function deleteEmailGroup(id) {
  if (!confirm('Delete this group? Smart view rules using it will no longer match.')) return;
  await dbDelete('emailGroups', id);
  emailGroups = emailGroups.filter(g => g.id !== id);
  toast('Group deleted', 'ok');
  showSettings();
}

async function addGroupMember(groupId, email) {
  const addr = email.trim().toLowerCase();
  if (!addr) return;
  const group = emailGroups.find(g => g.id === groupId);
  if (!group) return;
  if (group.members.includes(addr)) { toast('Already in group', 'warn'); return; }
  group.members.push(addr);
  await dbPut('emailGroups', group);
  toast(`Added ${addr}`, 'ok');
  showSettings();
}

async function removeGroupMember(groupId, email) {
  const group = emailGroups.find(g => g.id === groupId);
  if (!group) return;
  group.members = group.members.filter(m => m !== email);
  await dbPut('emailGroups', group);
  toast('Removed', 'ok');
  showSettings();
}

async function renameEmailGroup(groupId) {
  const group = emailGroups.find(g => g.id === groupId);
  if (!group) return;
  const name = prompt('New name for group:', group.name);
  if (!name || !name.trim()) return;
  group.name = name.trim();
  await dbPut('emailGroups', group);
  toast('Group renamed', 'ok');
  showSettings();
}

// --- Document types ---

const DEFAULT_DOCUMENT_TYPES = ['Certificate', 'Drawing', 'Minutes', 'Other', 'Report', 'RFI', 'Specification', 'Submittal'];
let documentTypes = [...DEFAULT_DOCUMENT_TYPES];

async function loadDocumentTypes() {
  const saved = await dbGet('settings', 'documentTypes');
  if (saved && Array.isArray(saved.types)) documentTypes = saved.types;
}

async function saveDocumentTypes() {
  await dbPut('settings', { key: 'documentTypes', types: documentTypes });
}

async function addDocumentType() {
  const input = document.getElementById('new-doc-type-input');
  const val = input.value.trim();
  if (!val) return;
  if (documentTypes.map(t => t.toLowerCase()).includes(val.toLowerCase())) {
    toast('Type already exists', 'warn'); return;
  }
  documentTypes = [...documentTypes, val].sort((a, b) => a.localeCompare(b));
  await saveDocumentTypes();
  input.value = '';
  toast(`Added "${val}"`, 'ok');
  showSettings();
}

async function removeDocumentType(type) {
  documentTypes = documentTypes.filter(t => t !== type);
  await saveDocumentTypes();
  toast(`Removed "${type}"`, 'ok');
  showSettings();
}

// --- Custom automation patterns ---

async function loadCustomPatterns() {
  const saved = await dbGet('settings', 'customAutomationPatterns');
  if (saved) {
    customPatterns.senders  = saved.senders  || [];
    customPatterns.subjects = saved.subjects || [];
    customPatterns.body     = saved.body     || [];
    mergeCustomPatterns();
  }
}

function mergeCustomPatterns() {
  SYSTEM_SENDER_PATTERNS  = [...DEFAULT_SENDER_PATTERNS,  ...customPatterns.senders.map(s  => safeRegex(s)).filter(Boolean)];
  SYSTEM_SUBJECT_PATTERNS = [...DEFAULT_SUBJECT_PATTERNS, ...customPatterns.subjects.map(s => safeRegex(s)).filter(Boolean)];
  SYSTEM_BODY_PATTERNS    = [...DEFAULT_BODY_PATTERNS,    ...customPatterns.body.map(s     => safeRegex(s)).filter(Boolean)];
}

function safeRegex(src) {
  try { return new RegExp(src, 'i'); } catch { return null; }
}

async function saveCustomPatterns() {
  await dbPut('settings', { key: 'customAutomationPatterns', ...customPatterns });
  mergeCustomPatterns();
}

// --- Custom signature patterns ---

let customSignaturePatternSrcs = [];

async function loadCustomSignaturePatterns() {
  const saved = await dbGet('settings', 'customSignaturePatterns');
  customSignaturePatternSrcs = (saved && saved.patterns) ? saved.patterns : [];
  customSignaturePatterns = customSignaturePatternSrcs.map(s => safeRegex(s)).filter(Boolean);
}

async function saveCustomSignaturePatterns() {
  await dbPut('settings', { key: 'customSignaturePatterns', patterns: customSignaturePatternSrcs });
  customSignaturePatterns = customSignaturePatternSrcs.map(s => safeRegex(s)).filter(Boolean);
}

async function addCustomSignaturePattern() {
  const input = document.getElementById('new-sig-pattern');
  if (!input) return;
  const val = input.value.trim();
  if (!val) return;
  const src = val.startsWith('/') && val.lastIndexOf('/') > 0
    ? val.slice(1, val.lastIndexOf('/'))
    : val.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!safeRegex(src)) { toast('Invalid pattern', 'warn'); return; }
  customSignaturePatternSrcs.push(src);
  await saveCustomSignaturePatterns();
  input.value = '';
  toast('Pattern added', 'ok');
  showSettings();
}

async function removeCustomSignaturePattern(idx) {
  customSignaturePatternSrcs.splice(idx, 1);
  await saveCustomSignaturePatterns();
  toast('Pattern removed', 'ok');
  showSettings();
}

function renderSignaturePatternSection() {
  const defaultChips = DEFAULT_SIGNATURE_PATTERNS.map(re =>
    `<span class="pattern-chip" title="Built-in (read-only)">${escHtml(re.source)}</span>`
  ).join('');
  const customChips = customSignaturePatternSrcs.map((p, i) =>
    `<span class="pattern-chip custom">
       ${escHtml(p)}
       <button class="del-pat" onclick="removeCustomSignaturePattern(${i})" title="Remove">×</button>
     </span>`
  ).join('');
  return `
    <div style="margin-bottom:6px;">${defaultChips}${customChips}</div>
    <div style="display:flex; gap:6px;">
      <input type="text" id="new-sig-pattern" class="search-input"
             placeholder="Add pattern (text or /regex/)…" style="flex:1;"
             onkeydown="if(event.key==='Enter') addCustomSignaturePattern()">
      <button class="btn" onclick="addCustomSignaturePattern()">+ Add</button>
    </div>`;
}

async function rerunSignatureStripping() {
  const btn = document.getElementById('btn-rerun-signatures');
  if (btn) { btn.disabled = true; btn.textContent = 'Running…'; }

  const emails = await dbGetAll('emails');
  let fixed = 0;

  for (const email of emails) {
    if (!email.textBody) continue;
    const stripped = cleanSignatures(email.textBody);
    if (stripped && stripped !== email.textBody) {
      email.textBody = stripped;
      await dbPut('emails', email);
      fixed++;
    }
  }

  if (btn) { btn.disabled = false; btn.textContent = 'Re-run signature stripping'; }
  toast(fixed ? `Stripped signatures from ${fixed} email${fixed !== 1 ? 's' : ''}` : 'No emails needed stripping', fixed ? 'ok' : '');
  if (fixed) { await loadEmailList(); applyFilters(); }
}

// --- Signature ranges (explicit start/end keyword pairs) ---

async function loadSignatureRanges() {
  const saved = await dbGet('settings', 'signatureRanges');
  signatureRanges = (saved && saved.ranges) ? saved.ranges : [];
}

async function saveSignatureRanges() {
  await dbPut('settings', { key: 'signatureRanges', ranges: signatureRanges });
}

async function addSignatureRange() {
  const startEl = document.getElementById('new-sig-range-start');
  const endEl   = document.getElementById('new-sig-range-end');
  if (!startEl) return;
  const start = startEl.value.trim();
  const end   = endEl ? endEl.value.trim() : '';
  if (!start) { toast('Start keyword is required', 'warn'); return; }
  signatureRanges.push({ start, end });
  await saveSignatureRanges();
  startEl.value = '';
  if (endEl) endEl.value = '';
  toast('Range added', 'ok');
  showSettings();
}

async function removeSignatureRange(idx) {
  signatureRanges.splice(idx, 1);
  await saveSignatureRanges();
  toast('Range removed', 'ok');
  showSettings();
}

function renderSignatureRangesSection() {
  const rows = signatureRanges.map((r, i) => `
    <div style="display:flex; align-items:center; gap:6px; margin-bottom:6px; background:var(--surface); border:1px solid var(--border2); border-radius:4px; padding:6px 8px;">
      <span style="font-family:var(--mono); font-size:12px; flex:1; color:var(--accent);">${escHtml(r.start)}</span>
      <span style="color:var(--muted); font-size:11px;">→</span>
      <span style="font-family:var(--mono); font-size:12px; flex:1; color:var(--muted);">${r.end ? escHtml(r.end) : '<em>end of text</em>'}</span>
      <button class="del-pat" onclick="removeSignatureRange(${i})" title="Remove">×</button>
    </div>`).join('');
  return `
    ${rows || '<div style="color:var(--muted);font-size:12px;font-style:italic;margin-bottom:8px;">No ranges defined yet</div>'}
    <div style="display:grid; grid-template-columns:1fr 1fr auto; gap:6px; align-items:center;">
      <input type="text" id="new-sig-range-start" class="search-input" placeholder="Start keyword…"
             onkeydown="if(event.key==='Enter') addSignatureRange()">
      <input type="text" id="new-sig-range-end" class="search-input" placeholder="End keyword (optional)…"
             onkeydown="if(event.key==='Enter') addSignatureRange()">
      <button class="btn" onclick="addSignatureRange()">+ Add</button>
    </div>
    <div style="color:var(--muted); font-size:11px; margin-top:6px;">
      Everything from <em>Start keyword</em> up to (not including) <em>End keyword</em> is removed.
      Leave End blank to remove from Start to end of text.
    </div>`;
}

// --- Custom quote / thread-marker patterns ---

// Source strings for the UI (raw regex source, same format as customPatterns)
let customQuotePatternSrcs = [];

const DEFAULT_QUOTE_PATTERNS = [
  /^On .+ wrote:$/i,
  /^-{3,}\s*Original Message\s*-{3,}/i,
  /^_{3,}\s*Original Message\s*_{3,}/i,
  /^From:.*Sent:.*To:/i,
  /^={3,}$/,
  /^-{5,}$/,
  /^Begin forwarded message:/i,
  /^-{3,}\s*Forwarded message\s*-{3,}/i,
  /^发件人:|^寄件者:/i,
];

async function loadCustomQuotePatterns() {
  const saved = await dbGet('settings', 'customQuotePatterns');
  customQuotePatternSrcs = (saved && saved.patterns) ? saved.patterns : [];
  customQuotePatterns = customQuotePatternSrcs.map(s => safeRegex(s)).filter(Boolean);
}

async function saveCustomQuotePatterns() {
  await dbPut('settings', { key: 'customQuotePatterns', patterns: customQuotePatternSrcs });
  customQuotePatterns = customQuotePatternSrcs.map(s => safeRegex(s)).filter(Boolean);
}

async function addCustomQuotePattern() {
  const input = document.getElementById('new-quote-pattern');
  if (!input) return;
  const val = input.value.trim();
  if (!val) return;
  const src = val.startsWith('/') && val.lastIndexOf('/') > 0
    ? val.slice(1, val.lastIndexOf('/'))
    : val.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!safeRegex(src)) { toast('Invalid pattern', 'warn'); return; }
  customQuotePatternSrcs.push(src);
  await saveCustomQuotePatterns();
  input.value = '';
  toast('Pattern added', 'ok');
  showSettings();
}

async function removeCustomQuotePattern(idx) {
  customQuotePatternSrcs.splice(idx, 1);
  await saveCustomQuotePatterns();
  toast('Pattern removed', 'ok');
  showSettings();
}

function renderQuotePatternSection() {
  const defaultChips = DEFAULT_QUOTE_PATTERNS.map(re =>
    `<span class="pattern-chip" title="Built-in (read-only)">${escHtml(re.source)}</span>`
  ).join('');
  const customChips = customQuotePatternSrcs.map((p, i) =>
    `<span class="pattern-chip custom">
       ${escHtml(p)}
       <button class="del-pat" onclick="removeCustomQuotePattern(${i})" title="Remove">×</button>
     </span>`
  ).join('');
  return `
    <div style="margin-bottom:6px;">${defaultChips}${customChips}</div>
    <div style="display:flex; gap:6px;">
      <input type="text" id="new-quote-pattern" class="search-input"
             placeholder="Add pattern (text or /regex/)…" style="flex:1;"
             onkeydown="if(event.key==='Enter') addCustomQuotePattern()">
      <button class="btn" onclick="addCustomQuotePattern()">+ Add</button>
    </div>`;
}

function renderEmailGroupsSection() {
  const groupsHTML = emailGroups.map(g => {
    const memberChips = g.members.map(m =>
      `<span class="pattern-chip custom">
         ${escHtml(m)}
         <button class="del-pat" onclick="removeGroupMember('${escHtml(g.id)}', '${escHtml(m)}')" title="Remove">×</button>
       </span>`
    ).join('');
    return `
      <div style="padding:12px; background:var(--surface); border:1px solid var(--border2); border-radius:5px; margin-bottom:10px;">
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
          <span style="font-weight:500; flex:1;">${escHtml(g.name)}</span>
          <button class="btn" style="padding:2px 8px; font-size:11px;" onclick="renameEmailGroup('${escHtml(g.id)}')">Rename</button>
          <button class="btn btn-danger" style="padding:2px 8px; font-size:11px;" onclick="deleteEmailGroup('${escHtml(g.id)}')">Delete</button>
        </div>
        <div style="margin-bottom:8px; min-height:24px;">
          ${memberChips || '<span style="color:var(--muted);font-size:12px;font-style:italic;">No members yet</span>'}
        </div>
        <div style="display:flex; gap:6px;">
          <input type="text" id="new-member-${escHtml(g.id)}" class="search-input"
                 placeholder="Add email address…" style="flex:1;"
                 onkeydown="if(event.key==='Enter') addGroupMember('${escHtml(g.id)}', this.value)">
          <button class="btn" onclick="addGroupMember('${escHtml(g.id)}', document.getElementById('new-member-${escHtml(g.id)}').value)">+ Add</button>
        </div>
      </div>`;
  }).join('');

  return `
    ${groupsHTML}
    <div style="display:flex; gap:6px; margin-top:${emailGroups.length ? '4px' : '0'};">
      <input type="text" id="new-group-name" class="search-input" placeholder="New group name…" style="flex:1;"
             onkeydown="if(event.key==='Enter') createGroupFromSettings()">
      <button class="btn" onclick="createGroupFromSettings()">+ New Group</button>
    </div>`;
}

async function createGroupFromSettings() {
  const input = document.getElementById('new-group-name');
  if (!input || !input.value.trim()) return;
  await createEmailGroup(input.value.trim());
  toast('Group created', 'ok');
  showSettings();
}

function renderPatternSection(title, category, defaults, customs) {
  const defaultChips = defaults.map(re =>
    `<span class="pattern-chip" title="Built-in (read-only)">${escHtml(re.source)}</span>`
  ).join('');
  const customChips = customs.map((p, i) =>
    `<span class="pattern-chip custom">
       ${escHtml(p)}
       <button class="del-pat" onclick="removeCustomPattern('${category}', ${i})" title="Remove">×</button>
     </span>`
  ).join('');
  return `
    <div style="margin-bottom:12px;">
      <div style="font-size:11px; font-family:var(--mono); letter-spacing:0.06em; text-transform:uppercase; color:var(--muted); margin-bottom:6px;">${title}</div>
      <div style="margin-bottom:6px;">${defaultChips}${customChips}</div>
      <div style="display:flex; gap:6px;">
        <input type="text" id="new-pat-${category}" class="search-input" placeholder="Add pattern (text or /regex/)…" style="flex:1;">
        <button class="btn" onclick="addCustomPattern('${category}')">+ Add</button>
      </div>
    </div>`;
}

async function addCustomPattern(category) {
  const input = document.getElementById(`new-pat-${category}`);
  if (!input) return;
  const val = input.value.trim();
  if (!val) return;

  // Strip leading/trailing slashes if user typed /regex/
  const src = val.startsWith('/') && val.lastIndexOf('/') > 0
    ? val.slice(1, val.lastIndexOf('/'))
    : val.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // escape if plain text

  if (!customPatterns[category]) customPatterns[category] = [];
  customPatterns[category].push(src);
  await saveCustomPatterns();
  input.value = '';
  toast('Pattern added', 'ok');
  showSettings(); // re-render
}

async function removeCustomPattern(category, idx) {
  if (!customPatterns[category]) return;
  customPatterns[category].splice(idx, 1);
  await saveCustomPatterns();
  toast('Pattern removed', 'ok');
  showSettings(); // re-render
}

// --- Settings panel renderer ---

function showSettings() {
  showPanel('list'); // Show the list panel
  document.querySelector('.toolbar').style.display = 'none';
  document.getElementById('bulk-tag-bar').style.display = 'none';
  document.querySelector('.email-list-header').style.display = 'none';
  const container = document.getElementById('email-list');
  container.innerHTML = `
    <div style="padding:20px;">
      <h2 style="margin:0 0 20px 0; font-size:18px;">⚙ Settings</h2>

      <div style="padding:16px; background:var(--surface2); border:1px solid var(--border); border-radius:6px; margin-bottom:16px;">
        <div style="display:flex; align-items:center; gap:12px; margin-bottom:8px;">
          <input type="checkbox" id="setting-nested" ${extractNestedAttachments ? 'checked' : ''}
                 onchange="toggleNestedAttachments(this.checked)"
                 style="width:18px; height:18px; cursor:pointer;">
          <label for="setting-nested" style="cursor:pointer; font-weight:500;">Extract nested attachments from forwarded emails</label>
        </div>
        <div style="color:var(--muted); font-size:12px; margin-left:30px;">
          When enabled, attachments inside forwarded .eml files will be extracted and saved separately.
          <br>Nested files will be marked with ↳ in the transmittal register.
        </div>
      </div>

      <div style="padding:16px; background:var(--surface2); border:1px solid var(--border); border-radius:6px; margin-bottom:16px;">
        <div style="display:flex; align-items:center; gap:12px; margin-bottom:8px;">
          <input type="checkbox" id="setting-organize-eml" ${organizeEmlFiles ? 'checked' : ''}
                 onchange="toggleOrganizeEml(this.checked)"
                 style="width:18px; height:18px; cursor:pointer;">
          <label for="setting-organize-eml" style="cursor:pointer; font-weight:500;">Organize imported EML files by sender domain</label>
        </div>
        <div style="color:var(--muted); font-size:12px; margin-left:30px;">
          When enabled, imported .eml files will be copied to domain-based folders for archiving.
          <br>Files organized as: archive/rcy.com.sg/email.eml, archive/changiairport.com/email.eml, etc.
        </div>
      </div>

      <div style="padding:16px; background:var(--surface2); border:1px solid var(--border); border-radius:6px; margin-bottom:16px;">
        <div style="font-weight:500; margin-bottom:8px;">Automated email detection</div>
        <div style="color:var(--muted); font-size:12px; margin-bottom:12px;">
          Re-runs the automated email filter across all emails in the library.
          Useful if emails imported before this feature was enabled aren't showing up under Automated.
        </div>
        <button id="btn-rerun-detection" class="btn" onclick="rerunAutomatedDetection()">Re-run detection</button>
      </div>

      <div style="padding:16px; background:var(--surface2); border:1px solid var(--border); border-radius:6px; margin-bottom:16px;">
        <div style="font-weight:500; margin-bottom:4px;">Automated detection patterns</div>
        <div style="color:var(--muted); font-size:12px; margin-bottom:14px;">
          Patterns used to classify emails as automated. Built-in patterns are shown in gray.
          Add custom patterns as plain text (substring match) or regular expressions.
        </div>

        ${renderPatternSection('Sender Email Patterns', 'senders', DEFAULT_SENDER_PATTERNS, customPatterns.senders)}
        ${renderPatternSection('Subject Patterns', 'subjects', DEFAULT_SUBJECT_PATTERNS, customPatterns.subjects)}
        ${renderPatternSection('Body Patterns (first 1000 chars)', 'body', DEFAULT_BODY_PATTERNS, customPatterns.body)}
      </div>

      <div style="padding:16px; background:var(--surface2); border:1px solid var(--border); border-radius:6px; margin-bottom:16px;">
        <div style="font-weight:500; margin-bottom:4px;">Quote / reply truncation patterns</div>
        <div style="color:var(--muted); font-size:12px; margin-bottom:14px;">
          When importing, the email body is truncated at the first line matching one of these patterns —
          keeping only the top-most reply and discarding the quoted thread below.
          Built-in patterns are shown in gray. Add custom patterns as plain text (substring match) or <code>/regex/</code>.
        </div>
        ${renderQuotePatternSection()}
        <div style="margin-top:12px; padding-top:12px; border-top:1px solid var(--border);">
          <div style="color:var(--muted); font-size:12px; margin-bottom:8px;">
            Re-run truncation on all existing emails in the library using the current patterns above.
            Only emails whose body contains a matching pattern will be updated.
          </div>
          <button id="btn-rerun-truncation" class="btn" onclick="rerunTruncation()">Re-run truncation</button>
        </div>
      </div>

      <div style="padding:16px; background:var(--surface2); border:1px solid var(--border); border-radius:6px; margin-bottom:16px;">
        <div style="font-weight:500; margin-bottom:4px;">Signature stripping patterns</div>
        <div style="color:var(--muted); font-size:12px; margin-bottom:14px;">
          When importing, corporate signature blocks (disclaimers, confidentiality notices, etc.) are removed from the bottom of
          each email body when a line matches one of these patterns. Built-in patterns are shown in gray.
          Add custom patterns as plain text (substring match) or <code>/regex/</code>.
        </div>
        ${renderSignaturePatternSection()}
        <div style="margin-top:14px; padding-top:14px; border-top:1px solid var(--border);">
          <div style="font-size:12px; font-weight:500; margin-bottom:6px;">Explicit start/end keyword ranges</div>
          <div style="color:var(--muted); font-size:12px; margin-bottom:10px;">
            Remove a specific block of text by defining where it starts and ends.
            Useful for company taglines or boilerplate that doesn't match a line-based pattern.
          </div>
          ${renderSignatureRangesSection()}
        </div>
        <div style="margin-top:12px; padding-top:12px; border-top:1px solid var(--border);">
          <div style="color:var(--muted); font-size:12px; margin-bottom:8px;">
            Re-run signature stripping on all existing emails using the current patterns and ranges above.
          </div>
          <button id="btn-rerun-signatures" class="btn" onclick="rerunSignatureStripping()">Re-run signature stripping</button>
        </div>
      </div>

      <div style="padding:16px; background:var(--surface2); border:1px solid var(--border); border-radius:6px; margin-bottom:16px;">
        <div style="font-weight:500; margin-bottom:8px;">Normalize email body line breaks</div>
        <div style="color:var(--muted); font-size:12px; margin-bottom:12px;">
          Scans all emails and collapses repeated blank lines (including <code>\r\n\r\n&nbsp;\r\n\r\n</code> patterns) into a single line break.
          New imports are cleaned automatically. Run this once on existing emails if you notice excessive spacing.
        </div>
        <button id="btn-normalize-linebreaks" class="btn" onclick="normalizeLineBreaks()">Normalize line breaks</button>
      </div>

      <div style="padding:16px; background:var(--surface2); border:1px solid var(--border); border-radius:6px; margin-bottom:16px;">
        <div style="font-weight:500; margin-bottom:8px;">Fix garbled characters (UTF-8 encoding repair)</div>
        <div style="color:var(--muted); font-size:12px; margin-bottom:12px;">
          Repairs text corrupted by an earlier import bug where UTF-8 characters were stored as raw bytes,
          producing garbled output like <code>yesterdayâs</code> instead of <code>yesterday's</code>.
          Safe to run multiple times — already-correct emails are skipped automatically.
        </div>
        <button id="btn-fix-mojibake" class="btn" onclick="fixMojibakeEmails()">Fix garbled characters</button>
      </div>

      <div style="padding:16px; background:var(--surface2); border:1px solid var(--border); border-radius:6px; margin-bottom:16px;">
        <div style="font-weight:500; margin-bottom:4px;">📄 Attachment text extraction limit</div>
        <div style="color:var(--muted); font-size:12px; margin-bottom:12px;">
          Maximum amount of text extracted from each attachment (PDF, DOCX, XLSX, PPTX).
          Larger limits give more context for review but use more storage.
          ~5 KB ≈ 2 pages · ~50 KB ≈ 15–20 pages · ~200 KB ≈ full report.
        </div>
        <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
          <input type="number" id="setting-attach-text-limit" class="search-input"
                 value="${attachTextLimitKb}" min="1" max="10000" step="1"
                 style="width:90px;" placeholder="KB">
          <span style="font-size:12px; color:var(--muted);">KB</span>
          <span style="font-size:11px; color:var(--muted);">(≈ ${(attachTextLimitKb * 1000).toLocaleString()} chars)</span>
          <div style="display:flex; gap:4px; margin-left:8px;">
            ${[5, 50, 100, 200, 300, 500].map(kb =>
              `<button class="btn${attachTextLimitKb === kb ? ' btn-primary' : ''}" style="padding:3px 8px; font-size:11px;"
                 onclick="document.getElementById('setting-attach-text-limit').value=${kb}">${kb} KB</button>`
            ).join('')}
          </div>
          <button class="btn btn-primary" style="margin-left:auto;" onclick="saveAttachTextLimitFromUI()">Save</button>
        </div>
      </div>

      <div style="padding:16px; background:var(--surface2); border:1px solid var(--border); border-radius:6px; margin-bottom:16px;">
        <div style="font-weight:500; margin-bottom:4px;">Document Types</div>
        <div style="color:var(--muted); font-size:12px; margin-bottom:14px;">
          The list of document types available when classifying attachments in the transmittal register.
        </div>
        <div style="display:flex; flex-wrap:wrap; gap:6px; margin-bottom:12px;">
          ${documentTypes.map(t => `
            <span style="display:inline-flex; align-items:center; gap:4px; padding:3px 8px; background:var(--surface3); border:1px solid var(--border); border-radius:4px; font-size:12px;">
              ${escHtml(t)}
              <button onclick="removeDocumentType('${escHtml(t)}')" style="background:none; border:none; cursor:pointer; color:var(--muted); font-size:14px; line-height:1; padding:0 2px;" title="Remove">&times;</button>
            </span>
          `).join('')}
        </div>
        <div style="display:flex; gap:6px;">
          <input id="new-doc-type-input" type="text" class="search-input" placeholder="New type name…" style="flex:1;"
                 onkeydown="if(event.key==='Enter') addDocumentType()">
          <button class="btn btn-primary" onclick="addDocumentType()">Add</button>
        </div>
      </div>

      <div style="padding:16px; background:var(--surface2); border:1px solid var(--border); border-radius:6px; margin-bottom:16px;">
        <div style="font-weight:500; margin-bottom:4px;">Email Groups</div>
        <div style="color:var(--muted); font-size:12px; margin-bottom:14px;">
          Create named groups of email addresses to use in smart view rules.
          For example, add your interface team members to a group, then filter by "Sender in Group" or "Any Participant in Group".
        </div>
        ${renderEmailGroupsSection()}
      </div>

      <div style="padding:16px; background:var(--surface2); border:1px solid var(--border); border-radius:6px; margin-bottom:16px;">
        <div style="font-weight:500; margin-bottom:4px;">🤖 Claude API Key</div>
        <div style="color:var(--muted); font-size:12px; margin-bottom:10px;">
          Used for AI tagging and summarization (✨ AI Tag button in the email detail panel).
          Your key is stored <strong>locally in IndexedDB only</strong> — it never leaves your browser.
        </div>
        <div style="display:flex; gap:8px; align-items:center;">
          <input type="password" id="setting-claude-key" class="search-input"
                 placeholder="sk-ant-api03-…" style="flex:1; font-family:var(--mono);"
                 value="" autocomplete="off">
          <button class="btn btn-primary" onclick="saveClaudeApiKey()">Save</button>
          <button class="btn" onclick="clearClaudeApiKey()">Clear</button>
        </div>
        <div id="claude-key-status" style="margin-top:6px; font-size:11px; color:var(--muted);"></div>
      </div>

      <div style="padding:16px; background:var(--surface2); border:1px solid var(--border); border-radius:6px; margin-bottom:16px;">
        <div style="font-weight:500; margin-bottom:4px;">✨ AI Prompt Configuration</div>
        <div style="color:var(--muted); font-size:12px; margin-bottom:14px;">
          Customize the prompts sent to Claude when AI tagging emails.
          Available template variables: <code>{{subject}}</code> <code>{{from}}</code> <code>{{to}}</code> <code>{{cc}}</code> (expands to "CC: …" or empty) <code>{{body}}</code>.
        </div>

        <div style="margin-bottom:12px;">
          <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
            <label style="font-size:12px; font-weight:500; flex:1;">System Prompt</label>
            <button class="btn" style="font-size:11px; padding:2px 8px;" onclick="resetAiSystemPrompt()">Reset to default</button>
          </div>
          <textarea id="ai-system-prompt" class="search-input"
                    style="width:100%; height:90px; resize:vertical; font-size:12px; font-family:inherit; box-sizing:border-box;"
                    placeholder="System instructions for Claude…">${escHtml(aiSystemPrompt)}</textarea>
        </div>

        <div style="margin-bottom:12px;">
          <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
            <label style="font-size:12px; font-weight:500; flex:1;">User Message Template</label>
            <button class="btn" style="font-size:11px; padding:2px 8px;" onclick="resetAiUserTemplate()">Reset to default</button>
          </div>
          <textarea id="ai-user-template" class="search-input"
                    style="width:100%; height:110px; resize:vertical; font-size:12px; font-family:var(--mono); box-sizing:border-box;"
                    placeholder="User message template…">${escHtml(aiUserTemplate)}</textarea>
        </div>

        <div style="margin-bottom:12px;">
          <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
            <label style="font-size:12px; font-weight:500; flex:1;">Thread Analysis Prompt</label>
            <button class="btn" style="font-size:11px; padding:2px 8px;" onclick="resetAiThreadPrompt()">Reset to default</button>
          </div>
          <div style="color:var(--muted); font-size:11px; margin-bottom:6px;">Used by <b>AI Thread</b> — receives condensed thread JSON (no body text). Must instruct Claude to return <code>{"updates":[{emailId,actionItemId,status}]}</code>.</div>
          <textarea id="ai-thread-prompt" class="search-input"
                    style="width:100%; height:90px; resize:vertical; font-size:12px; font-family:inherit; box-sizing:border-box;"
                    placeholder="Thread analysis instructions for Claude…">${escHtml(aiThreadPrompt)}</textarea>
        </div>

        <div style="display:flex; align-items:center; gap:10px; margin-bottom:12px;">
          <label style="font-size:12px; font-weight:500; white-space:nowrap;">Body character limit:</label>
          <input type="number" id="ai-body-limit" class="search-input" value="${aiBodyLimit}" min="100" max="10000" step="100"
                 style="width:90px;">
        </div>

        <button class="btn btn-primary" onclick="saveAiPromptsFromUI()">Save prompt settings</button>
      </div>

      <div style="padding:16px; background:var(--surface2); border:1px solid var(--border); border-radius:6px; margin-bottom:16px;">
        <div style="font-weight:500; margin-bottom:4px;">🏷 Auto-Tag Rules</div>
        <div style="color:var(--muted); font-size:12px; margin-bottom:12px;">
          Rules applied automatically when importing emails. Use the same field conditions as smart views.
          Exclusions (⊘) on individual emails are always respected.
        </div>
        ${renderAutoTagRulesSection()}
      </div>

      <div style="padding:16px; background:var(--surface2); border:1px solid var(--border); border-radius:6px; margin-bottom:16px;">
        <div style="font-weight:500; margin-bottom:4px;">🤖 Local AI (Ollama)</div>
        <div style="color:var(--muted); font-size:12px; margin-bottom:12px;">
          Workflow: filter the email list to the scope you want analyzed, click <b>Export current view for AI</b>,
          run <code>tools/analyze.py</code> against that file, then import the resulting <code>insights.json</code>
          below. The export excludes system/low-value emails and uses the signature-stripped body.
          See <code>tools/README.md</code> for setup (requires a local Ollama instance).
        </div>
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
          <button class="btn" onclick="exportForAI()">Export current view for AI</button>
          <label class="btn btn-primary" style="cursor:pointer;">
            Import insights.json
            <input type="file" accept=".json" style="display:none;"
                   onchange="if(this.files[0]) importInsightsFile(this.files[0])">
          </label>
          <button class="btn btn-danger" onclick="clearAllInsights()">Clear all insights</button>
        </div>
      </div>

      <div style="margin-top:32px; padding:16px; background:rgba(220,53,69,0.06); border:1px solid var(--danger); border-radius:6px;">
        <div style="font-weight:600; color:var(--danger); margin-bottom:4px;">⚠ Danger Zone</div>
        <div style="color:var(--muted); font-size:12px; margin-bottom:16px;">These actions are irreversible. Use with caution.</div>

        <div style="margin-bottom:16px;">
          <div style="font-weight:500; margin-bottom:4px;">Unmark all actionable emails</div>
          <div style="color:var(--muted); font-size:12px; margin-bottom:10px;">
            Removes the ⚡ actionable flag from every email in the library. This cannot be undone.
          </div>
          <button class="btn btn-danger" onclick="bulkUnmarkActionable()">⚡ Unmark All Actionable</button>
        </div>

        <div style="margin-bottom:16px;">
          <div style="font-weight:500; margin-bottom:4px;">Discard automated emails</div>
          <div style="color:var(--muted); font-size:12px; margin-bottom:10px;">
            Deletes all automated/system emails and their attachments, but remembers their IDs to prevent reimporting them. This cannot be undone.
          </div>
          <button class="btn btn-danger" onclick="discardAutomatedEmails()">✕ Discard Automated Emails</button>
        </div>

        <div>
          <div style="font-weight:500; margin-bottom:4px;">Clear database</div>
          <div style="color:var(--muted); font-size:12px; margin-bottom:10px;">
            Permanently deletes all emails, attachments, tags, and issues from the local database.
          </div>
          <button class="btn btn-danger" onclick="clearDB()">✕ Clear Database</button>
        </div>
      </div>

      <button class="btn" onclick="switchView('all')" style="margin-top:20px;">← Back</button>
    </div>
  `;
  closeDetail(); // Close detail panel if open
  _loadClaudeKeyStatus(); // Async — updates #claude-key-status after render
}

function toggleNestedAttachments(enabled) {
  extractNestedAttachments = enabled;
  toast(enabled ? 'Nested attachment extraction enabled' : 'Nested attachment extraction disabled', 'ok');
}

function toggleOrganizeEml(enabled) {
  organizeEmlFiles = enabled;
  toast(enabled ? 'EML organization enabled' : 'EML organization disabled', 'ok');
}

async function fixMojibakeEmails() {
  const btn = document.getElementById('btn-fix-mojibake');
  if (btn) { btn.disabled = true; btn.textContent = 'Scanning…'; }

  const emails = await dbGetAll('emails');
  let fixed = 0;

  for (const email of emails) {
    let changed = false;
    for (const field of ['textBody', 'subject', 'fromName']) {
      const orig = email[field];
      if (typeof orig !== 'string' || !/[\x80-\xFF]/.test(orig)) continue;
      try {
        const bytes = Uint8Array.from(orig, c => c.charCodeAt(0));
        const repaired = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        if (repaired !== orig) { email[field] = repaired; changed = true; }
      } catch { /* not mojibake — leave untouched */ }
    }
    if (changed) { await dbPut('emails', email); fixed++; }
  }

  if (btn) { btn.disabled = false; btn.textContent = 'Fix garbled characters'; }
  toast(fixed ? `Repaired ${fixed} email${fixed !== 1 ? 's' : ''}` : 'No garbled emails found', fixed ? 'ok' : '');
  if (fixed) { await loadEmailList(); applyFilters(); }
}

async function normalizeLineBreaks() {
  const btn = document.getElementById('btn-normalize-linebreaks');
  if (btn) { btn.disabled = true; btn.textContent = 'Scanning…'; }

  const emails = await dbGetAll('emails');
  let fixed = 0;

  for (const email of emails) {
    if (email.textBody) {
      const orig = email.textBody;
      email.textBody = email.textBody
        .replace(/\r\n/g, '\n')
        .replace(/\n([ \t]*\n)+/g, '\n');
      if (email.textBody !== orig) {
        await dbPut('emails', email);
        fixed++;
      }
    }
  }

  if (btn) { btn.disabled = false; btn.textContent = 'Normalize line breaks'; }
  toast(fixed ? `Fixed ${fixed} email${fixed !== 1 ? 's' : ''}` : 'No emails needed fixing', fixed ? 'ok' : '');
  if (fixed) { await loadEmailList(); applyFilters(); }
}

async function rerunTruncation() {
  const btn = document.getElementById('btn-rerun-truncation');
  if (btn) { btn.disabled = true; btn.textContent = 'Running…'; }

  const emails = await dbGetAll('emails');
  let fixed = 0;

  for (const email of emails) {
    if (!email.textBody) continue;
    const matches = findTruncationMatches(email.textBody);
    if (matches.length) {
      email.textBody = truncateAtLine(email.textBody, matches[0].lineIndex);
      await dbPut('emails', email);
      fixed++;
    }
  }

  if (btn) { btn.disabled = false; btn.textContent = 'Re-run truncation'; }
  toast(fixed ? `Truncated ${fixed} email${fixed !== 1 ? 's' : ''}` : 'No emails needed truncation', fixed ? 'ok' : '');
  if (fixed) { await loadEmailList(); applyFilters(); }
}
