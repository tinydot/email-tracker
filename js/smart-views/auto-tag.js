// ═══════════════════════════════════════════════════════
//  SMART VIEWS — Auto-tag rules
//  Data layer (load/save/evaluate) and CRUD UI rendered
//  inside the Settings panel.
// ═══════════════════════════════════════════════════════

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
