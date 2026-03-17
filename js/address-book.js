// ═══════════════════════════════════════════════════════
//  ADDRESS BOOK
//  Contact profiles with role, job scope, and projects.
//  Contact context is injected into AI prompts for richer summaries.
// ═══════════════════════════════════════════════════════

// ── Rendering ──────────────────────────────────────────

async function showAddressBook() {
  showPanel('list');
  const container = document.getElementById('email-list');
  const contacts = await dbGetAll('addressBook');
  contacts.sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));

  const toolbar = `
    <div style="padding:16px 20px 0; display:flex; align-items:center; gap:10px;">
      <input id="ab-search" class="search-input" placeholder="Search contacts…"
             oninput="filterAddressBook(this.value)" style="flex:1; max-width:320px;">
      <button class="btn btn-primary" onclick="showAddressBookEditor(null)">+ Add Contact</button>
    </div>`;

  if (!contacts.length) {
    container.innerHTML = toolbar + `
      <div class="empty-state" style="margin-top:32px;">
        <div class="empty-icon">👤</div>
        <div class="empty-text">No contacts yet. Add people to enrich AI summaries with their role and project context.</div>
        <button class="btn btn-primary" onclick="showAddressBookEditor(null)" style="margin-top:16px;">+ Add Contact</button>
      </div>`;
    return;
  }

  container.innerHTML = toolbar + `
    <div id="ab-list" style="padding:16px 20px; display:flex; flex-direction:column; gap:10px;">
      ${contacts.map(c => renderContactCard(c)).join('')}
    </div>`;
}

function renderContactCard(c) {
  const projectsText = (c.projects || []).length
    ? c.projects.map(p => `<span class="tag-chip" style="font-size:11px;">${escHtml(p)}</span>`).join('')
    : '';
  const hasMeta = c.role || c.jobScope || projectsText;
  return `
    <div class="ab-card" data-email="${escHtml(c.email)}" style="
      padding:14px 16px;
      background:var(--surface2);
      border:1px solid var(--border);
      border-radius:6px;
      display:flex;
      align-items:start;
      gap:14px;
    ">
      <div style="width:38px;height:38px;border-radius:50%;background:var(--accent);color:#fff;
                  display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0;">
        ${escHtml((c.name || c.email).charAt(0).toUpperCase())}
      </div>
      <div style="flex:1;min-width:0;">
        <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;">
          <span style="font-weight:500;font-size:14px;">${escHtml(c.name || '—')}</span>
          <span style="font-size:12px;color:var(--muted);">${escHtml(c.email)}</span>
          ${c.role ? `<span style="font-size:12px;color:var(--accent);">${escHtml(c.role)}</span>` : ''}
        </div>
        ${c.jobScope ? `<div style="font-size:12px;color:var(--muted);margin-top:4px;">${escHtml(c.jobScope)}</div>` : ''}
        ${projectsText ? `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;">${projectsText}</div>` : ''}
        ${c.notes ? `<div style="font-size:12px;color:var(--muted);margin-top:4px;font-style:italic;">${escHtml(c.notes)}</div>` : ''}
        ${!hasMeta ? `<div style="font-size:11px;color:var(--muted);margin-top:4px;">No details yet — <a href="#" onclick="showAddressBookEditor('${escHtml(c.email)}');return false;" style="color:var(--accent);">add role/scope</a></div>` : ''}
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0;">
        <button class="btn" style="font-size:12px;padding:4px 10px;"
                onclick="showAddressBookEditor('${escHtml(c.email)}')">Edit</button>
        <button class="btn" style="font-size:12px;padding:4px 10px;color:var(--danger);"
                onclick="deleteContact('${escHtml(c.email)}')">Delete</button>
      </div>
    </div>`;
}

function filterAddressBook(term) {
  const t = term.toLowerCase();
  document.querySelectorAll('#ab-list .ab-card').forEach(card => {
    const email = card.dataset.email || '';
    const text  = card.textContent.toLowerCase();
    card.style.display = (!t || text.includes(t) || email.includes(t)) ? '' : 'none';
  });
}

// ── Editor modal ────────────────────────────────────────

async function showAddressBookEditor(emailKey) {
  let contact = null;
  if (emailKey) {
    contact = await dbGet('addressBook', emailKey);
  }
  const isNew  = !contact;
  const c      = contact || { email: '', name: '', role: '', jobScope: '', projects: [], notes: '' };
  const projVal = (c.projects || []).join(', ');

  const overlay = document.getElementById('sv-modal-overlay');
  const modal   = document.getElementById('sv-modal');
  overlay.style.display = 'flex';

  modal.innerHTML = `
    <div style="padding:24px;max-width:480px;width:100%;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
        <h2 style="margin:0;font-size:16px;">${isNew ? 'Add Contact' : 'Edit Contact'}</h2>
        <button class="modal-close" onclick="closeAddressBookEditor()">×</button>
      </div>

      <div style="display:flex;flex-direction:column;gap:14px;">
        <label style="font-size:12px;color:var(--muted);font-weight:500;">
          EMAIL ADDRESS *
          <input id="ab-edit-email" type="email" class="search-input"
                 value="${escHtml(c.email)}" placeholder="contact@example.com"
                 style="width:100%;margin-top:4px;" ${!isNew ? 'readonly style="width:100%;margin-top:4px;opacity:0.7;"' : ''}>
        </label>

        <label style="font-size:12px;color:var(--muted);font-weight:500;">
          FULL NAME
          <input id="ab-edit-name" type="text" class="search-input"
                 value="${escHtml(c.name)}" placeholder="Jane Smith"
                 style="width:100%;margin-top:4px;">
        </label>

        <label style="font-size:12px;color:var(--muted);font-weight:500;">
          ROLE / JOB TITLE
          <input id="ab-edit-role" type="text" class="search-input"
                 value="${escHtml(c.role || '')}" placeholder="e.g. Project Manager, Site Engineer"
                 style="width:100%;margin-top:4px;">
        </label>

        <label style="font-size:12px;color:var(--muted);font-weight:500;">
          JOB SCOPE
          <textarea id="ab-edit-scope" class="search-input" rows="3"
                    placeholder="Brief description of their responsibilities…"
                    style="width:100%;margin-top:4px;resize:vertical;font-family:inherit;font-size:13px;padding:8px 10px;">${escHtml(c.jobScope || '')}</textarea>
        </label>

        <label style="font-size:12px;color:var(--muted);font-weight:500;">
          PROJECTS INVOLVED
          <input id="ab-edit-projects" type="text" class="search-input"
                 value="${escHtml(projVal)}" placeholder="Project Alpha, Building B Fit-out, M&E Works"
                 style="width:100%;margin-top:4px;">
          <span style="font-size:11px;color:var(--muted);margin-top:3px;display:block;">Comma-separated list</span>
        </label>

        <label style="font-size:12px;color:var(--muted);font-weight:500;">
          NOTES
          <textarea id="ab-edit-notes" class="search-input" rows="2"
                    placeholder="Any additional context…"
                    style="width:100%;margin-top:4px;resize:vertical;font-family:inherit;font-size:13px;padding:8px 10px;">${escHtml(c.notes || '')}</textarea>
        </label>
      </div>

      <div style="display:flex;gap:8px;margin-top:20px;">
        <button class="btn btn-primary" onclick="saveContact(${!isNew})">
          ${isNew ? 'Add Contact' : 'Save Changes'}
        </button>
        <button class="btn" onclick="closeAddressBookEditor()">Cancel</button>
      </div>
    </div>`;
}

function closeAddressBookEditor() {
  const overlay = document.getElementById('sv-modal-overlay');
  overlay.style.display = 'none';
  document.getElementById('sv-modal').innerHTML = '';
}

async function saveContact(isEdit) {
  const email    = (document.getElementById('ab-edit-email')?.value || '').trim().toLowerCase();
  const name     = (document.getElementById('ab-edit-name')?.value || '').trim();
  const role     = (document.getElementById('ab-edit-role')?.value || '').trim();
  const jobScope = (document.getElementById('ab-edit-scope')?.value || '').trim();
  const projRaw  = (document.getElementById('ab-edit-projects')?.value || '');
  const notes    = (document.getElementById('ab-edit-notes')?.value || '').trim();

  if (!email) { toast('Email address is required', 'warn'); return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { toast('Enter a valid email address', 'warn'); return; }

  const projects = projRaw.split(',').map(p => p.trim()).filter(Boolean);

  const contact = { email, name, role, jobScope, projects, notes, updatedAt: Date.now() };
  await dbPut('addressBook', contact);

  closeAddressBookEditor();
  toast(isEdit ? 'Contact updated' : 'Contact added', 'ok');
  if (currentView === 'addressbook') showAddressBook();
}

async function deleteContact(email) {
  if (!confirm(`Delete contact ${email}?`)) return;
  await dbDelete('addressBook', email);
  toast('Contact deleted', 'ok');
  if (currentView === 'addressbook') showAddressBook();
}

// ── Quick-add from email detail ─────────────────────────

// Called from the email detail panel to add/edit sender as a contact
async function quickAddContact(emailAddr, displayName) {
  const existing = await dbGet('addressBook', emailAddr.toLowerCase());
  await showAddressBookEditor(existing ? emailAddr.toLowerCase() : null);
  if (!existing) {
    // Pre-fill email and name from the email header
    const emailInput = document.getElementById('ab-edit-email');
    const nameInput  = document.getElementById('ab-edit-name');
    if (emailInput) emailInput.value = emailAddr.toLowerCase();
    if (nameInput && displayName) nameInput.value = displayName;
  }
}

// ── AI context helper ───────────────────────────────────

// Returns a formatted contact context block for a list of email addresses.
// Used by ai.js to inject into prompts.
async function getContactContextForAddresses(addresses) {
  if (!addresses || !addresses.length) return '';
  const lines = [];
  for (const addr of addresses) {
    const clean = addr.replace(/^.*<|>.*$/g, '').trim().toLowerCase();
    if (!clean) continue;
    const c = await dbGet('addressBook', clean);
    if (!c) continue;
    const parts = [];
    if (c.name) parts.push(c.name);
    if (c.role) parts.push(c.role);
    if (c.jobScope) parts.push(c.jobScope);
    if (c.projects && c.projects.length) parts.push('Projects: ' + c.projects.join(', '));
    if (c.notes) parts.push(c.notes);
    if (parts.length) lines.push(`${clean}: ${parts.join(' | ')}`);
  }
  return lines.join('\n');
}
