// ═══════════════════════════════════════════════════════
//  SMART VIEWS
// ═══════════════════════════════════════════════════════

// --- Rule field definitions ---
const RULE_FIELDS = [
  { value: 'fromAddr',          label: 'Sender Email' },
  { value: 'fromName',          label: 'Sender Name' },
  { value: 'fromDomain',        label: 'Sender Domain' },
  { value: 'toAddr',            label: 'Recipient Email' },
  { value: 'toDomain',          label: 'Recipient Domain' },
  { value: 'ccAddr',            label: 'CC Email' },
  { value: 'ccDomain',          label: 'CC Domain' },
  { value: 'subject',           label: 'Subject' },
  { value: 'status',            label: 'Status' },
  { value: 'tags',              label: 'Tags' },
  { value: 'hasAttachments',    label: 'Has Attachments' },
  { value: 'isActionable',      label: 'Is Actionable' },
  { value: 'isSystemEmail',     label: 'Is Automated' },
  { value: 'fromInGroup',       label: 'Sender in Group' },
  { value: 'recipientInGroup',  label: 'Recipient in Group' },
  { value: 'participantInGroup',label: 'Any Participant in Group' },
];

const BOOL_FIELDS  = new Set(['hasAttachments', 'isActionable', 'isSystemEmail']);
const GROUP_FIELDS = new Set(['fromInGroup', 'recipientInGroup', 'participantInGroup']);

function getOperatorOptions(field, selected) {
  if (BOOL_FIELDS.has(field)) {
    return `<option value="is_true" ${selected === 'is_true' ? 'selected' : ''}>is true</option>
            <option value="is_false" ${selected === 'is_false' ? 'selected' : ''}>is false</option>`;
  }
  if (GROUP_FIELDS.has(field)) {
    return `<option value="in_group" ${selected === 'in_group' ? 'selected' : ''}>is in group</option>
            <option value="not_in_group" ${selected === 'not_in_group' ? 'selected' : ''}>is not in group</option>`;
  }
  const ops = [
    ['contains',     'contains'],
    ['not_contains', 'does not contain'],
    ['equals',       'equals'],
    ['not_equals',   'does not equal'],
    ['starts_with',  'starts with'],
    ['ends_with',    'ends with'],
    ['is_empty',     'is empty'],
    ['is_not_empty', 'is not empty'],
  ];
  return ops.map(([v, l]) => `<option value="${v}" ${selected === v ? 'selected' : ''}>${l}</option>`).join('');
}

function getValueInputHTML(field, value, operator) {
  if (BOOL_FIELDS.has(field)) return '<span style="color:var(--muted);font-size:11px;">—</span>';
  if (operator === 'is_empty' || operator === 'is_not_empty') {
    return '<span style="color:var(--muted);font-size:11px;">—</span>';
  }
  if (GROUP_FIELDS.has(field)) {
    if (!emailGroups.length) {
      return '<span style="color:var(--muted);font-size:11px;">No groups yet — create one in Settings</span>';
    }
    const opts = emailGroups.map(g =>
      `<option value="${escHtml(g.id)}" ${value === g.id ? 'selected' : ''}>${escHtml(g.name)}</option>`
    ).join('');
    return `<select>${opts}</select>`;
  }
  if (field === 'status') {
    const statuses = ['unread','read','replied','awaiting','actioned'];
    return `<select>${statuses.map(s => `<option value="${s}" ${value === s ? 'selected' : ''}>${s}</option>`).join('')}</select>`;
  }
  return `<input type="text" value="${escHtml(value)}" placeholder="Value…">`;
}

function buildRuleRowHTML(rule = {}) {
  const field    = rule.field    || 'fromAddr';
  const operator = rule.operator || 'contains';
  const value    = rule.value    || '';
  return `
    <div class="rule-row">
      <select class="rule-field" onchange="onRuleFieldChange(this)">
        ${RULE_FIELDS.map(f => `<option value="${f.value}" ${field === f.value ? 'selected' : ''}>${f.label}</option>`).join('')}
      </select>
      <select class="rule-operator" onchange="onRuleOperatorChange(this)">
        ${getOperatorOptions(field, operator)}
      </select>
      <div class="rule-value-container" style="min-width:0;">${getValueInputHTML(field, value, operator)}</div>
      <button class="rule-remove" onclick="this.closest('.rule-row').remove()" title="Remove rule">×</button>
    </div>`;
}

function onRuleFieldChange(select) {
  const row = select.closest('.rule-row');
  const field = select.value;
  const defaultOp = GROUP_FIELDS.has(field) ? 'in_group' : BOOL_FIELDS.has(field) ? 'is_true' : 'contains';
  row.querySelector('.rule-operator').innerHTML = getOperatorOptions(field, defaultOp);
  row.querySelector('.rule-value-container').innerHTML = getValueInputHTML(field, '', defaultOp);
}

function onRuleOperatorChange(select) {
  const row = select.closest('.rule-row');
  const field = row.querySelector('.rule-field').value;
  const operator = select.value;
  row.querySelector('.rule-value-container').innerHTML = getValueInputHTML(field, '', operator);
}

function addRuleToGroup(btn) {
  const rulesContainer = btn.closest('.sv-group').querySelector('.sv-group-rules');
  const tmp = document.createElement('div');
  tmp.innerHTML = buildRuleRowHTML();
  rulesContainer.appendChild(tmp.firstElementChild);
}

function setSvGroupOp(btn, op) {
  const group = btn.closest('.sv-group');
  group.dataset.operator = op;
  group.querySelectorAll('.sv-group-header .sv-operator-btn').forEach(b => {
    const btnOp = b.getAttribute('onclick').includes("'AND'") ? 'AND' : 'OR';
    b.classList.toggle('active', btnOp === op);
  });
}

function addSvGroup() {
  const container = document.getElementById('sv-groups-container');
  const groupCount = container.querySelectorAll('.sv-group').length + 1;
  const tmp = document.createElement('div');
  tmp.innerHTML = buildGroupHTML({ operator: 'AND', rules: [] }, groupCount);
  container.appendChild(tmp.firstElementChild);
  // Show top-level operator and enable all remove buttons
  updateSvGroupUI();
}

function removeSvGroup(btn) {
  btn.closest('.sv-group').remove();
  updateSvGroupUI();
}

function updateSvGroupUI() {
  const container = document.getElementById('sv-groups-container');
  const groups = container.querySelectorAll('.sv-group');
  const topOp = document.getElementById('sv-top-op');
  if (topOp) topOp.style.display = groups.length > 1 ? '' : 'none';
  groups.forEach(g => {
    const removeBtn = g.querySelector('.sv-group-remove');
    if (removeBtn) {
      removeBtn.disabled = groups.length <= 1;
      removeBtn.style.opacity = groups.length <= 1 ? '0.3' : '';
      removeBtn.style.pointerEvents = groups.length <= 1 ? 'none' : '';
    }
  });
}

function setSvOperator(op) {
  document.getElementById('sv-operator').value = op;
  document.getElementById('op-btn-AND').classList.toggle('active', op === 'AND');
  document.getElementById('op-btn-OR').classList.toggle('active', op === 'OR');
}

function handleSvOverlayClick(e) {
  if (e.target === document.getElementById('sv-modal-overlay')) closeSmartViewEditor();
}

function closeSmartViewEditor() {
  document.getElementById('sv-modal-overlay').classList.remove('open');
}

function buildGroupHTML(group, groupCount) {
  const op = group.operator || 'AND';
  return `
    <div class="sv-group" data-operator="${op}">
      <div class="sv-group-header">
        <span>where</span>
        <div class="sv-operator-toggle" style="margin:0;">
          <button class="sv-operator-btn${op === 'AND' ? ' active' : ''}"
                  onclick="setSvGroupOp(this, 'AND')">ALL</button>
          <button class="sv-operator-btn${op === 'OR'  ? ' active' : ''}"
                  onclick="setSvGroupOp(this, 'OR')">ANY</button>
        </div>
        <span>of these rules match</span>
        <button class="rule-remove sv-group-remove" onclick="removeSvGroup(this)"
                title="Remove group" style="margin-left:auto;"
                ${groupCount <= 1 ? 'disabled style="opacity:0.3;pointer-events:none;margin-left:auto;"' : 'style="margin-left:auto;"'}>×</button>
      </div>
      <div class="sv-group-rules">
        ${(group.rules || [{ field: 'fromAddr', operator: 'contains', value: '' }]).map(r => buildRuleRowHTML(r)).join('')}
      </div>
      <div class="sv-group-footer">
        <button class="btn" onclick="addRuleToGroup(this)" style="font-size:12px; padding:3px 10px;">+ Add Rule</button>
      </div>
    </div>`;
}

function showSmartViewEditor(svId = null) {
  const sv = svId ? smartViews.find(s => s.id === svId) : null;
  const isEdit = !!sv;
  const nsv = sv ? normalizeSmartView(sv) : null;
  const groups = nsv?.groups?.length ? nsv.groups : [{ operator: 'AND', rules: [{ field: 'fromAddr', operator: 'contains', value: '' }] }];
  const groupOp = nsv?.groupOperator || 'AND';
  const requiredTags = sv?.requiredTags || [];

  // Gather all known tags from loaded emails for the picker
  const availableTags = [...new Set(allEmails.flatMap(e => e.tags || []))].sort();

  const requiredTagsChipsHTML = () => requiredTags.length > 0
    ? requiredTags.map(t => `
        <span class="tag-chip active req-tag-chip" data-tag="${escHtml(t)}" style="cursor:default; user-select:none;">
          # ${escHtml(t)}
          <button onclick="removeSvRequiredTag('${escHtml(t)}')"
                  style="background:none;border:none;cursor:pointer;color:inherit;padding:0 0 0 2px;font-size:14px;line-height:1;" title="Remove">×</button>
        </span>`).join('')
    : `<span id="sv-req-tags-empty" style="color:var(--muted);font-size:12px;font-style:italic;">None — add tags below</span>`;

  const tagPickerHTML = availableTags.length > 0
    ? `<div style="display:flex; gap:6px; margin-top:8px;">
        <select id="sv-tag-select" class="sv-input" style="flex:1; font-size:12px;">
          <option value="">— pick a tag —</option>
          ${availableTags.map(t => `<option value="${escHtml(t)}"${requiredTags.includes(t) ? ' disabled' : ''}>${escHtml(t)}</option>`).join('')}
        </select>
        <button class="btn" onclick="addSvRequiredTag()" style="flex:0 0 auto; font-size:12px; padding:4px 10px;">+ Add</button>
      </div>`
    : `<p style="color:var(--muted);font-size:12px;margin-top:8px;font-style:italic;">No tags in library yet — tag some emails first.</p>`;

  document.getElementById('sv-modal').innerHTML = `
    <div class="sv-modal-header">
      <span class="sv-modal-title">${isEdit ? 'Edit Smart View' : 'New Smart View'}</span>
      <button class="btn" onclick="closeSmartViewEditor()">×</button>
    </div>
    <div class="sv-modal-body">
      <input type="hidden" id="sv-edit-id" value="${isEdit ? escHtml(sv.id) : ''}">

      <div style="display:flex; gap:10px; margin-bottom:16px;">
        <div style="flex:0 0 auto;">
          <div class="sv-field-label">Icon</div>
          <input id="sv-icon" class="sv-input" value="${escHtml(sv?.icon || '🔍')}"
                 style="width:52px; text-align:center; font-size:18px; padding:4px 6px;">
        </div>
        <div style="flex:1;">
          <div class="sv-field-label">View Name</div>
          <input id="sv-name" class="sv-input" placeholder="e.g. From Client" value="${escHtml(sv?.name || '')}">
        </div>
      </div>

      <input type="hidden" id="sv-operator" value="${groupOp}">
      <div class="sv-top-op" id="sv-top-op" style="${groups.length <= 1 ? 'display:none' : ''}">
        <span>Match</span>
        <div class="sv-operator-toggle">
          <button class="sv-operator-btn${groupOp === 'AND' ? ' active' : ''}" id="op-btn-AND" onclick="setSvOperator('AND')">ALL groups</button>
          <button class="sv-operator-btn${groupOp === 'OR'  ? ' active' : ''}" id="op-btn-OR"  onclick="setSvOperator('OR')">ANY group</button>
        </div>
      </div>

      <div id="sv-groups-container">
        ${groups.map(g => buildGroupHTML(g, groups.length)).join('')}
      </div>
      <button class="btn" onclick="addSvGroup()" style="margin-bottom:16px; font-size:12px;">+ Add Group</button>

      <div style="border:1px solid var(--border); border-radius:6px; padding:12px; margin-bottom:16px; background:var(--surface2);">
        <div class="sv-field-label" style="margin-bottom:8px;">Required Tags <span style="font-weight:400; color:var(--muted);">(email must have ALL of these)</span></div>
        <div id="sv-required-tags" style="display:flex; flex-wrap:wrap; gap:6px; min-height:26px; align-items:center;">
          ${requiredTagsChipsHTML()}
        </div>
        ${tagPickerHTML}
      </div>

      <label style="display:flex; align-items:center; gap:8px; margin-bottom:16px; font-size:13px; cursor:pointer;">
        <input type="checkbox" id="sv-exclude-automated" ${sv?.excludeAutomated !== false ? 'checked' : ''}>
        Exclude automated / system emails
      </label>

      <div style="display:flex; gap:8px; justify-content:flex-end; border-top:1px solid var(--border); padding-top:16px;">
        ${isEdit ? `<button class="btn btn-danger" onclick="deleteSmartView('${escHtml(sv.id)}')">Delete</button>` : ''}
        <button class="btn" onclick="closeSmartViewEditor()">Cancel</button>
        <button class="btn btn-primary" onclick="saveSmartView()">Save</button>
      </div>
    </div>`;

  document.getElementById('sv-modal-overlay').classList.add('open');
  document.getElementById('sv-name').focus();
}

function collectGroupsFromDOM() {
  const groups = [];
  document.querySelectorAll('#sv-groups-container .sv-group').forEach(groupEl => {
    const operator = groupEl.dataset.operator || 'AND';
    const rules = [];
    groupEl.querySelectorAll('.rule-row').forEach(row => {
      const field    = row.querySelector('.rule-field')?.value;
      const operator = row.querySelector('.rule-operator')?.value;
      const textIn   = row.querySelector('.rule-value-container input[type=text]');
      const selIn    = row.querySelector('.rule-value-container select');
      const value    = textIn ? textIn.value : (selIn ? selIn.value : '');
      if (field) rules.push({ field, operator: operator || 'contains', value: value || '' });
    });
    groups.push({ operator, rules });
  });
  return groups;
}

// --- Required Tags helpers (used by the smart view editor) ---
function addSvRequiredTag() {
  const sel = document.getElementById('sv-tag-select');
  const tag = sel?.value;
  if (!tag) return;
  const existing = [...document.querySelectorAll('#sv-required-tags .req-tag-chip')].map(c => c.dataset.tag);
  if (existing.includes(tag)) return;
  renderSvRequiredTags([...existing, tag]);
  sel.value = '';
  // Disable the option so it can't be added twice
  const opt = sel.querySelector(`option[value="${tag.replace(/"/g, '\\"')}"]`);
  if (opt) opt.disabled = true;
}

function removeSvRequiredTag(tag) {
  const remaining = [...document.querySelectorAll('#sv-required-tags .req-tag-chip')]
    .map(c => c.dataset.tag).filter(t => t !== tag);
  renderSvRequiredTags(remaining);
  // Re-enable the option in the picker
  const sel = document.getElementById('sv-tag-select');
  if (sel) {
    const opt = sel.querySelector(`option[value="${tag.replace(/"/g, '\\"')}"]`);
    if (opt) opt.disabled = false;
  }
}

function renderSvRequiredTags(tags) {
  const container = document.getElementById('sv-required-tags');
  if (!container) return;
  if (tags.length === 0) {
    container.innerHTML = `<span id="sv-req-tags-empty" style="color:var(--muted);font-size:12px;font-style:italic;">None — add tags below</span>`;
  } else {
    container.innerHTML = tags.map(t => `
      <span class="tag-chip active req-tag-chip" data-tag="${escHtml(t)}" style="cursor:default; user-select:none;">
        # ${escHtml(t)}
        <button onclick="removeSvRequiredTag('${escHtml(t)}')"
                style="background:none;border:none;cursor:pointer;color:inherit;padding:0 0 0 2px;font-size:14px;line-height:1;" title="Remove">×</button>
      </span>`).join('');
  }
}

async function saveSmartView() {
  const id   = document.getElementById('sv-edit-id').value;
  const name = document.getElementById('sv-name').value.trim();
  const icon = document.getElementById('sv-icon').value.trim() || '🔍';
  const groupOperator = document.getElementById('sv-operator').value || 'AND';

  if (!name) {
    document.getElementById('sv-name').focus();
    toast('Please enter a view name', 'warn');
    return;
  }

  const groups = collectGroupsFromDOM();
  const requiredTags = [...document.querySelectorAll('#sv-required-tags .req-tag-chip')]
    .map(chip => chip.dataset.tag).filter(Boolean);

  const existing = id ? smartViews.find(s => s.id === id) : null;
  const svRecord = {
    id: id || ('sv-' + Date.now()),
    name, icon, groupOperator, groups,
    requiredTags,
    excludeAutomated: document.getElementById('sv-exclude-automated').checked,
    createdAt: existing?.createdAt || new Date().toISOString(),
  };

  await dbPut('smartViews', svRecord);

  const idx = smartViews.findIndex(s => s.id === svRecord.id);
  if (idx >= 0) smartViews[idx] = svRecord;
  else smartViews.push(svRecord);

  closeSmartViewEditor();
  renderSmartViewsSidebar();
  updateNavCounts();
  switchView('sv-' + svRecord.id);
  toast(`Smart view "${name}" saved`, 'ok');
}

async function deleteSmartView(id) {
  if (!confirm('Delete this smart view?')) return;
  await dbDelete('smartViews', id);
  smartViews = smartViews.filter(s => s.id !== id);
  closeSmartViewEditor();
  renderSmartViewsSidebar();
  if (currentView === 'sv-' + id) switchView('all');
  toast('Smart view deleted', 'ok');
}

// --- Rule engine ---
function getEmailFieldValue(email, field) {
  switch (field) {
    case 'fromAddr':       return (email.fromAddr  || '').toLowerCase();
    case 'fromName':       return (email.fromName  || '').toLowerCase();
    case 'fromDomain':     return ((email.fromAddr || '').split('@')[1] || '').toLowerCase();
    case 'toAddr':         return (email.toAddrs   || []).join(' ').toLowerCase();
    case 'toDomain':       return (email.toAddrs   || []).map(a => (a.split('@')[1] || '')).join(' ').toLowerCase();
    case 'ccAddr':         return (email.ccAddrs   || []).join(' ').toLowerCase();
    case 'ccDomain':       return (email.ccAddrs   || []).map(a => (a.split('@')[1] || '')).join(' ').toLowerCase();
    case 'subject':        return (email.subject   || '').toLowerCase();
    case 'status':         return (email.status    || '').toLowerCase();
    case 'tags':           return (email.tags      || []).join(' ').toLowerCase();
    case 'hasAttachments': return email.hasAttachments ? 'true' : 'false';
    case 'isActionable':   return email.isActionable   ? 'true' : 'false';
    case 'isSystemEmail':  return email.isSystemEmail  ? 'true' : 'false';
    default: return '';
  }
}

function evaluateRule(email, rule) {
  const { field, operator, value } = rule;
  if (BOOL_FIELDS.has(field)) {
    const boolVal = email[field] === true;
    return operator === 'is_true' ? boolVal : !boolVal;
  }
  if (GROUP_FIELDS.has(field)) {
    const group = emailGroups.find(g => g.id === value);
    if (!group) return false;
    const members = (group.members || []).map(m => m.toLowerCase());
    let addrs = [];
    if (field === 'fromInGroup') {
      addrs = [(email.fromAddr || '').toLowerCase()];
    } else if (field === 'recipientInGroup') {
      addrs = [...(email.toAddrs || []), ...(email.ccAddrs || [])].map(a => a.toLowerCase());
    } else { // participantInGroup
      addrs = [(email.fromAddr || ''), ...(email.toAddrs || []), ...(email.ccAddrs || [])].map(a => a.toLowerCase());
    }
    const match = addrs.some(a => members.includes(a));
    return operator === 'in_group' ? match : !match;
  }
  const fv  = getEmailFieldValue(email, field);
  const val = (value || '').toLowerCase();
  switch (operator) {
    case 'contains':     return fv.includes(val);
    case 'not_contains': return !fv.includes(val);
    case 'equals':       return fv === val;
    case 'not_equals':   return fv !== val;
    case 'starts_with':  return fv.startsWith(val);
    case 'ends_with':    return fv.endsWith(val);
    case 'is_empty':     return fv === '';
    case 'is_not_empty': return fv !== '';
    default: return false;
  }
}

// Converts old flat-rules format to grouped format for backward compat
function normalizeSmartView(sv) {
  if (sv.groups) return sv;
  return {
    ...sv,
    groupOperator: sv.ruleOperator || 'AND',
    groups: [{ operator: sv.ruleOperator || 'AND', rules: sv.rules || [] }],
  };
}

function applySmartViewRules(email, sv) {
  // Required tags are always AND-combined (email must have ALL of them)
  const requiredTags = sv.requiredTags || [];
  if (requiredTags.length > 0) {
    const emailTags = email.tags || [];
    if (!requiredTags.every(t => emailTags.includes(t))) return false;
  }

  const nsv = normalizeSmartView(sv);
  const { groupOperator = 'AND', groups = [] } = nsv;
  if (!groups.length) return true;
  const evalGroup = g => {
    if (!g.rules || !g.rules.length) return true;
    return g.operator === 'OR'
      ? g.rules.some(r => evaluateRule(email, r))
      : g.rules.every(r => evaluateRule(email, r));
  };
  return groupOperator === 'OR' ? groups.some(evalGroup) : groups.every(evalGroup);
}

async function loadSmartViews() {
  smartViews = await dbGetAll('smartViews');
  renderSmartViewsSidebar();
}

async function loadEmailGroups() {
  emailGroups = await dbGetAll('emailGroups');
}

// ── AI prompt settings ─────────────────────────────────
async function loadAiPrompts() {
  const saved = await dbGet('settings', 'aiPrompts');
  if (saved) {
    aiSystemPrompt = saved.systemPrompt ?? AI_SYSTEM_PROMPT_DEFAULT;
    aiUserTemplate = saved.userTemplate ?? AI_USER_TEMPLATE_DEFAULT;
    aiBodyLimit    = saved.bodyLimit    ?? AI_BODY_LIMIT_DEFAULT;
  }
}

async function saveAiPrompts() {
  await dbPut('settings', {
    key: 'aiPrompts',
    systemPrompt: aiSystemPrompt,
    userTemplate: aiUserTemplate,
    bodyLimit:    aiBodyLimit,
  });
}

// ── Auto-Tag Rules engine ──────────────────────────────
async function loadAutoTagRules() {
  const saved = await dbGet('settings', 'autoTagRules');
  autoTagRules = saved?.rules || [];
}

async function saveAutoTagRules() {
  await dbPut('settings', { key: 'autoTagRules', rules: autoTagRules });
}

// Returns array of tag strings to apply to an email (respects tagExclusions)
function getAutoTagsForEmail(email) {
  const toApply = [];
  for (const rule of autoTagRules) {
    if (!rule.enabled) continue;
    if (applySmartViewRules(email, rule)) {
      const tag = (rule.tag || '').trim().toLowerCase();
      if (tag && !(email.tagExclusions || []).includes(tag)) {
        toApply.push(tag);
      }
    }
  }
  return toApply;
}

async function rerunAutoTagRules() {
  const active = autoTagRules.filter(r => r.enabled);
  if (!active.length) { toast('No enabled auto-tag rules', 'warn'); return; }
  let changed = 0;
  for (const email of allEmails) {
    const toApply = getAutoTagsForEmail(email);
    const newTags = toApply.filter(t => !(email.tags || []).includes(t));
    if (newTags.length) {
      if (!email.tags) email.tags = [];
      email.tags.push(...newTags);
      await dbPut('emails', email);
      changed++;
    }
  }
  applyFilters();
  toast(`Auto-tag rules applied: ${changed} email${changed !== 1 ? 's' : ''} updated`, 'ok');
}

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

function renderSvTabToggle() {
  const el = document.getElementById('sv-tab-toggle');
  if (!el) return;
  el.style.display = 'flex';
  el.className = 'sv-tab-toggle';
  el.innerHTML = `
    <button class="sv-tab-btn${svSubView === 'emails' ? ' active' : ''}" onclick="setSvSubView('emails')">Emails</button>
    <button class="sv-tab-btn${svSubView === 'attachments' ? ' active' : ''}" onclick="setSvSubView('attachments')">Attachments</button>
  `;
}

function hideSvTabToggle() {
  const el = document.getElementById('sv-tab-toggle');
  if (el) el.style.display = 'none';
}

function setSvSubView(sub) {
  svSubView = sub;
  renderSvTabToggle();
  const header = document.querySelector('.email-list-header');
  if (sub === 'attachments') {
    if (header) header.style.display = 'none';
    document.getElementById('bulk-tag-bar').style.display = 'none';
    showSvAttachments();
  } else {
    if (header) header.style.display = '';
    applyFilters(); // rebuilds filteredEmails and calls renderEmailList + refreshBulkTagBar
  }
}

async function showSvAttachments() {
  const container = document.getElementById('email-list');
  container.innerHTML = '<div style="padding:20px; color:var(--muted); font-size:12px;">Loading attachments…</div>';

  const emailIds = new Set(filteredEmails.map(e => e.id));
  const allAtts = await dbGetAll('attachments');
  const atts = allAtts.filter(a => emailIds.has(a.emailId));

  const emailMap = new Map(filteredEmails.map(e => [e.id, e]));
  const rows = atts.map(a => ({ ...a, email: emailMap.get(a.emailId) }));
  rows.sort((a, b) => (b.email?.date || '').localeCompare(a.email?.date || ''));

  if (!rows.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📎</div>
        <div class="empty-text">No attachments in the filtered emails.</div>
      </div>`;
    return;
  }

  container.innerHTML = `
    <table style="width:100%; border-collapse:collapse; font-size:12px;">
      <thead style="position:sticky; top:0; background:var(--surface); border-bottom:1px solid var(--border2); z-index:1;">
        <tr style="height:34px;">
          <th style="text-align:left; padding:8px; font-family:var(--mono); font-size:10px; letter-spacing:0.08em; color:var(--muted); text-transform:uppercase;">File</th>
          <th style="text-align:left; padding:8px; font-family:var(--mono); font-size:10px; letter-spacing:0.08em; color:var(--muted); text-transform:uppercase;">Subject</th>
          <th style="text-align:left; padding:8px; font-family:var(--mono); font-size:10px; letter-spacing:0.08em; color:var(--muted); text-transform:uppercase;">From</th>
          <th style="text-align:left; padding:8px; font-family:var(--mono); font-size:10px; letter-spacing:0.08em; color:var(--muted); text-transform:uppercase;">Date</th>
          <th style="text-align:left; padding:8px; font-family:var(--mono); font-size:10px; letter-spacing:0.08em; color:var(--muted); text-transform:uppercase;">Size</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(r => {
          const hasFile = !!r.storedPath;
          const fileIcon = hasFile ? '📎' : '📋';
          const fileAction = hasFile ? `onclick="openAttachmentFromDisk('${escHtml(r.storedPath)}')" style="cursor:pointer; color:var(--accent);"` : '';
          const dateStr = r.email?.date ? formatDate(r.email.date) : '—';
          const from = r.email?.fromName || r.email?.fromAddr || '—';
          const subject = r.email?.subject || '—';
          const emailId = r.email?.id ? escHtml(r.email.id) : '';
          const subjectTrunc = subject.length > 45 ? subject.slice(0, 45) + '…' : subject;
          return `
            <tr style="border-bottom:1px solid var(--border); height:38px;"
                onmouseover="this.style.background='var(--surface2)'"
                onmouseout="this.style.background=''">
              <td style="padding:8px; max-width:220px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                <span ${fileAction} title="${escHtml(r.filename)}" style="display:flex; align-items:center; gap:4px;">
                  ${fileIcon} ${escHtml(r.filename)}
                </span>
              </td>
              <td style="padding:8px; max-width:240px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                ${emailId
                  ? `<a href="#" onclick="selectEmail('${emailId}');return false;" style="color:var(--accent); text-decoration:none;" title="${escHtml(subject)}">${escHtml(subjectTrunc)}</a>`
                  : escHtml(subjectTrunc)}
              </td>
              <td style="padding:8px; max-width:160px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--muted);">
                ${escHtml(from)}
              </td>
              <td style="padding:8px; font-family:var(--mono); font-size:11px; color:var(--muted); white-space:nowrap;">
                ${dateStr}
              </td>
              <td style="padding:8px; font-family:var(--mono); font-size:11px; color:var(--muted); white-space:nowrap;">
                ${formatSize(r.size)}
              </td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}

function renderSmartViewsSidebar() {
  const container = document.getElementById('smart-views-nav');
  if (!container) return;
  if (!smartViews.length) {
    container.innerHTML = '<div style="padding:4px 8px 4px 16px; font-size:11px; color:var(--muted); font-style:italic;">No smart views yet</div>';
    return;
  }
  container.innerHTML = [...smartViews].sort((a, b) => a.name.localeCompare(b.name)).map(sv => {
    const count   = allEmails.filter(e => applySmartViewRules(e, sv)).length;
    const isActive = currentView === 'sv-' + sv.id;
    return `
      <button class="nav-item ${isActive ? 'active' : ''}" data-view="sv-${escHtml(sv.id)}"
              onclick="switchView('sv-${escHtml(sv.id)}')"
              oncontextmenu="event.preventDefault(); showSmartViewEditor('${escHtml(sv.id)}')"
              title="Right-click to edit">
        ${escHtml(sv.icon || '🔍')} ${escHtml(sv.name)}
        <span class="nav-count">${count}</span>
      </button>`;
  }).join('');
}

// --- Custom automation patterns (persisted) ---
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

// --- Auto-tag rules CRUD + UI ---
let _atrEditing = null; // 'new' | rule ID | null

function showAtrEditor(id) {
  _atrEditing = id;
  showSettings();
  setTimeout(() => {
    const ed = document.getElementById('atr-editor');
    if (ed) ed.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, 50);
}

function cancelAtrEdit() {
  _atrEditing = null;
  showSettings();
}

function addAtrRuleRow() {
  const container = document.getElementById('atr-rules-container');
  if (!container) return;
  const tmp = document.createElement('div');
  tmp.innerHTML = buildRuleRowHTML();
  container.appendChild(tmp.firstElementChild);
}

async function saveAutoTagRule() {
  const tagInput = document.getElementById('atr-tag');
  const tag = (tagInput?.value || '').trim().toLowerCase();
  if (!tag) { if (tagInput) tagInput.focus(); toast('Enter a tag name', 'warn'); return; }

  const ruleOp = document.getElementById('atr-rule-op')?.value || 'AND';
  const editId = document.getElementById('atr-edit-id')?.value || '';
  const rules = [];
  document.querySelectorAll('#atr-rules-container .rule-row').forEach(row => {
    const field    = row.querySelector('.rule-field')?.value;
    const operator = row.querySelector('.rule-operator')?.value;
    const textIn   = row.querySelector('.rule-value-container input[type=text]');
    const selIn    = row.querySelector('.rule-value-container select');
    const value    = textIn ? textIn.value : (selIn ? selIn.value : '');
    if (field) rules.push({ field, operator: operator || 'contains', value: value || '' });
  });
  if (!rules.length) { toast('Add at least one condition', 'warn'); return; }

  const ruleData = {
    id: editId || ('atr-' + Date.now()),
    tag, ruleOperator: ruleOp, rules, enabled: true,
  };
  const existing = autoTagRules.find(r => r.id === ruleData.id);
  if (existing) { Object.assign(existing, ruleData); } else { autoTagRules.push(ruleData); }
  await saveAutoTagRules();
  _atrEditing = null;
  showSettings();
  toast(`Auto-tag rule "${tag}" saved`, 'ok');
}

async function deleteAutoTagRule(id) {
  if (!confirm('Delete this auto-tag rule?')) return;
  autoTagRules = autoTagRules.filter(r => r.id !== id);
  await saveAutoTagRules();
  if (_atrEditing === id) _atrEditing = null;
  showSettings();
  toast('Auto-tag rule deleted', 'ok');
}

async function toggleAutoTagRule(id) {
  const rule = autoTagRules.find(r => r.id === id);
  if (!rule) return;
  rule.enabled = !rule.enabled;
  await saveAutoTagRules();
  showSettings();
}

function renderAutoTagRulesSection() {
  const rulesHTML = autoTagRules.length ? autoTagRules.map(r => `
    <div style="display:flex; align-items:center; gap:8px; padding:8px 10px; background:var(--surface); border:1px solid var(--border2); border-radius:4px; margin-bottom:6px; opacity:${r.enabled ? '1' : '0.55'};">
      <input type="checkbox" ${r.enabled ? 'checked' : ''} onchange="toggleAutoTagRule('${escHtml(r.id)}')" style="width:14px;height:14px;cursor:pointer;" title="Enable/disable rule">
      <span style="flex:1; font-weight:500;"># ${escHtml(r.tag)}</span>
      <span style="color:var(--muted); font-size:11px;">${r.rules.length} condition${r.rules.length !== 1 ? 's' : ''} · ${r.ruleOperator}</span>
      <button class="btn" style="padding:2px 8px; font-size:11px;" onclick="showAtrEditor('${escHtml(r.id)}')">Edit</button>
      <button class="btn btn-danger" style="padding:2px 8px; font-size:11px;" onclick="deleteAutoTagRule('${escHtml(r.id)}')">×</button>
    </div>`).join('') :
    '<div style="color:var(--muted); font-size:12px; font-style:italic; margin-bottom:6px;">No auto-tag rules yet.</div>';

  let editorHTML = '';
  if (_atrEditing) {
    const rule = _atrEditing === 'new' ? null : autoTagRules.find(r => r.id === _atrEditing);
    const ruleRows = rule?.rules?.length ? rule.rules : [{ field: 'fromAddr', operator: 'contains', value: '' }];
    const ruleOp = rule?.ruleOperator || 'AND';
    const tag = rule?.tag || '';
    editorHTML = `
      <div id="atr-editor" style="margin-top:10px; padding:12px; background:var(--surface); border:1px solid var(--accent); border-radius:5px;">
        <input type="hidden" id="atr-edit-id" value="${escHtml(_atrEditing === 'new' ? '' : _atrEditing)}">
        <div class="atr-rule-row" style="margin-bottom:10px;">
          <span style="font-size:12px; font-weight:500; white-space:nowrap;">Tag name:</span>
          <input type="text" id="atr-tag" class="search-input" value="${escHtml(tag)}" placeholder="e.g. rcy, drawing-submission" style="flex:1;">
        </div>
        <div class="atr-rule-row" style="font-size:12px; margin-bottom:8px;">
          <span>Apply when</span>
          <select id="atr-rule-op" class="search-input" style="width:auto;">
            <option value="AND" ${ruleOp === 'AND' ? 'selected' : ''}>ALL</option>
            <option value="OR" ${ruleOp === 'OR' ? 'selected' : ''}>ANY</option>
          </select>
          <span>of these conditions match:</span>
        </div>
        <div id="atr-rules-container">
          ${ruleRows.map(r => buildRuleRowHTML(r)).join('')}
        </div>
        <div style="margin-top:8px; display:flex; gap:8px; align-items:center;">
          <button class="btn" style="font-size:11px; padding:3px 8px;" onclick="addAtrRuleRow()">+ Add condition</button>
          <div style="flex:1;"></div>
          <button class="btn" onclick="cancelAtrEdit()">Cancel</button>
          <button class="btn btn-primary" onclick="saveAutoTagRule()">Save rule</button>
        </div>
      </div>`;
  }

  const hasEnabled = autoTagRules.some(r => r.enabled);
  return `
    ${rulesHTML}
    ${editorHTML}
    ${!_atrEditing ? `
      <div style="display:flex; gap:8px; margin-top:8px; flex-wrap:wrap;">
        <button class="btn" onclick="showAtrEditor('new')">+ Add Rule</button>
        <button class="btn" onclick="rerunAutoTagRules()" ${!hasEnabled ? 'disabled title="No enabled rules"' : ''}>⟳ Re-run on all emails</button>
      </div>` : ''}`;
}

// --- Claude API key helpers ---
async function getClaudeApiKey() {
  const rec = await dbGet('settings', 'claudeApiKey');
  return rec?.value || null;
}

async function saveClaudeApiKey() {
  const input = document.getElementById('setting-claude-key');
  const val = (input?.value || '').trim();
  if (!val) { toast('Enter an API key first', 'warn'); return; }
  await dbPut('settings', { key: 'claudeApiKey', value: val });
  if (input) input.value = '';
  await _loadClaudeKeyStatus();
  toast('Claude API key saved', 'ok');
}

async function clearClaudeApiKey() {
  await dbPut('settings', { key: 'claudeApiKey', value: '' });
  await _loadClaudeKeyStatus();
  toast('Claude API key cleared', 'ok');
}

async function saveAiPromptsFromUI() {
  const sys  = document.getElementById('ai-system-prompt')?.value ?? '';
  const tmpl = document.getElementById('ai-user-template')?.value ?? '';
  const lim  = parseInt(document.getElementById('ai-body-limit')?.value, 10);
  if (!sys.trim())  { toast('System prompt cannot be empty', 'warn'); return; }
  if (!tmpl.trim()) { toast('User template cannot be empty', 'warn'); return; }
  aiSystemPrompt = sys;
  aiUserTemplate = tmpl;
  aiBodyLimit    = Number.isFinite(lim) && lim > 0 ? lim : AI_BODY_LIMIT_DEFAULT;
  await saveAiPrompts();
  toast('AI prompt settings saved', 'ok');
}

function resetAiSystemPrompt() {
  const el = document.getElementById('ai-system-prompt');
  if (el) el.value = AI_SYSTEM_PROMPT_DEFAULT;
}

function resetAiUserTemplate() {
  const el = document.getElementById('ai-user-template');
  if (el) el.value = AI_USER_TEMPLATE_DEFAULT;
}

async function _loadClaudeKeyStatus() {
  const el = document.getElementById('claude-key-status');
  if (!el) return;
  const key = await getClaudeApiKey();
  el.textContent = key ? '✓ API key is set (stored locally only)' : 'No key saved';
  el.style.color = key ? 'var(--ok, #2a9d5c)' : 'var(--muted)';
}

// --- AI tagging functions ---
function buildEmailPrompt(email) {
  const vars = {
    subject: email.subject || '(none)',
    from:    email.fromName ? `${email.fromName} <${email.fromAddr}>` : (email.fromAddr || ''),
    to:      (email.toAddrs || []).join(', '),
    cc:      email.ccAddrs?.length ? `CC: ${email.ccAddrs.join(', ')}` : '',
    body:    (email.textBody || '(no body)').slice(0, aiBodyLimit),
  };
  return aiUserTemplate.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');
}

async function aiTagEmail(emailId) {
  const email = allEmails.find(e => e.id === emailId);
  if (!email) return;
  const apiKey = await getClaudeApiKey();
  if (!apiKey) { toast('Add Claude API key in Settings first', 'err'); return; }

  toast('Running AI tagging…', 'ok');
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 300,
        output_config: {
          format: {
            type: 'json_schema',
            schema: {
              type: 'object',
              properties: {
                tags:    { type: 'array', items: { type: 'string' } },
                summary: { type: 'string' },
              },
              required: ['tags', 'summary'],
              additionalProperties: false,
            },
          },
        },
        system: aiSystemPrompt,
        messages: [{ role: 'user', content: buildEmailPrompt(email) }],
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      toast(`AI error ${res.status}: ${errText.slice(0, 100)}`, 'err');
      return;
    }
    const data = await res.json();
    const parsed = JSON.parse(data.content[0].text);
    const tags = parsed.tags || [];
    const summary = parsed.summary || null;

    if (!email.tags) email.tags = [];
    for (const tag of tags) {
      const clean = tag.trim().toLowerCase();
      if (clean && !(email.tagExclusions || []).includes(clean) && !email.tags.includes(clean)) {
        email.tags.push(clean);
      }
    }
    email.aiSummary = summary;
    await dbPut('emails', email);

    if (selectedEmail?.id === emailId) openDetail(email);
    renderEmailList();
    toast(`AI tagged: ${tags.join(', ')}`, 'ok');
  } catch (e) {
    toast(`AI error: ${e.message}`, 'err');
  }
}

async function bulkAiTagView() {
  const apiKey = await getClaudeApiKey();
  if (!apiKey) { toast('Add Claude API key in Settings first', 'err'); return; }
  const targets = [...filteredEmails];
  if (!targets.length) { toast('No emails in current view', 'warn'); return; }
  if (!confirm(`Run AI tagging on ${targets.length} email${targets.length !== 1 ? 's' : ''}?\n\nThis will use Claude API credits (claude-haiku-4-5).`)) return;

  let done = 0, errors = 0;
  for (const email of targets) {
    try {
      await aiTagEmail(email.id);
      done++;
      if (done % 5 === 0) toast(`AI tagging: ${done}/${targets.length}…`, 'ok');
    } catch { errors++; }
  }
  applyFilters();
  toast(`AI tagging complete: ${done} tagged${errors ? ', ' + errors + ' errors' : ''}`, 'ok');
}

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

function showImport() { showPanel('import'); }

function switchView(view) {
  currentView = view;
  document.querySelector('.toolbar').style.display = '';
  document.querySelector('.email-list-header').style.display = '';
  document.querySelectorAll('.nav-item[data-view]').forEach(el => {
    el.classList.toggle('active', el.dataset.view === view);
  });

  if (view.startsWith('sv-')) {
    const svId = view.slice(3);
    const sv   = smartViews.find(s => s.id === svId);
    document.getElementById('view-title').textContent = sv ? (sv.icon + ' ' + sv.name) : 'Smart View';
    svSubView = 'emails';
    renderSvTabToggle();
    document.querySelector('.email-list-header').style.display = '';
    showPanel('list');
    applyFilters();
  } else if (view === 'transmittals') {
    document.getElementById('view-title').textContent = VIEW_LABELS[view] || view;
    hideSvTabToggle();
    refreshBulkTagBar();
    showTransmittalRegister();
  } else if (view === 'issues') {
    document.getElementById('view-title').textContent = VIEW_LABELS[view] || view;
    hideSvTabToggle();
    refreshBulkTagBar();
    showIssuesList();
  } else {
    document.getElementById('view-title').textContent = VIEW_LABELS[view] || view;
    hideSvTabToggle();
    applyFilters();
  }

  closeDetail();
}

function applySort(val) {
  currentSort = val;
  applyFilters();
}

let _searchDebounceTimer = null;
function searchEmails(val) {
  clearTimeout(_searchDebounceTimer);
  _searchDebounceTimer = setTimeout(() => {
    searchTerm = val.toLowerCase();
    applyFilters();
  }, 150);
}

function applyFilters() {
  // Resolve smart view if active
  let sv = null;
  if (currentView.startsWith('sv-')) {
    const svId = currentView.slice(3);
    sv = smartViews.find(s => s.id === svId) || null;
  }

  const excludeSystem = sv ? sv.excludeAutomated !== false : currentView !== 'automated';
  const excludeLow    = sv ? true : currentView !== 'lowvalue';
  const term          = searchTerm;
  const now           = Date.now();

  // Single pass: all predicates combined
  const list = [];
  for (const e of allEmails) {
    if (excludeSystem && e.isSystemEmail) continue;
    if (excludeLow    && e.isLowValue)    continue;

    if (sv) {
      if (!applySmartViewRules(e, sv)) continue;
    } else {
      switch (currentView) {
        case 'unread':      if (e.status !== 'unread')  continue; break;
        case 'actionable':  if (!e.isActionable)         continue; break;
        case 'awaiting': {
          if (e.status !== 'awaiting') continue;
          if (e.awaitingSince) {
            const days = (now - new Date(e.awaitingSince).getTime()) / (1000*60*60*24);
            e._overdue = days > 7;
          }
          break;
        }
        case 'threads':     if (e.inReplyTo || !hasReplies(e)) continue; break;
        case 'attachments': if (!e.hasAttachments)  continue; break;
        case 'automated':   if (!e.isSystemEmail)   continue; break;
        case 'lowvalue':    if (!e.isLowValue)       continue; break;
      }
    }

    if (term) {
      if (
        !(e.subject  || '').toLowerCase().includes(term) &&
        !(e.fromAddr || '').toLowerCase().includes(term) &&
        !(e.fromName || '').toLowerCase().includes(term) &&
        !(e.textBody || '').toLowerCase().includes(term)
      ) continue;
    }

    list.push(e);
  }

  // Sort
  list.sort((a, b) => {
    switch (currentSort) {
      case 'date-desc': return (b.date || '').localeCompare(a.date || '');
      case 'date-asc':  return (a.date || '').localeCompare(b.date || '');
      case 'from':      return (a.fromAddr || '').localeCompare(b.fromAddr || '');
      case 'subject':   return (a.subject || '').localeCompare(b.subject || '');
      default: return 0;
    }
  });

  filteredEmails = list;
  // Keep selectedEmailIdx in sync after filter/sort changes
  selectedEmailIdx = selectedEmail ? filteredEmails.findIndex(e => e.id === selectedEmail.id) : -1;
  if (currentView.startsWith('sv-') && svSubView === 'attachments') {
    showSvAttachments();
  } else {
    renderEmailList();
  }
}
