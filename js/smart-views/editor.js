// ═══════════════════════════════════════════════════════
//  SMART VIEWS — Editor modal
//  Build, show, and save the smart view editor modal.
//  Depends on: rule-engine.js (RULE_FIELDS, BOOL_FIELDS, GROUP_FIELDS,
//              getOperatorOptions, getValueInputHTML)
// ═══════════════════════════════════════════════════════

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
