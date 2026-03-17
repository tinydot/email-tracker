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
