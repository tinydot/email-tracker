// ═══════════════════════════════════════════════════════
//  SMART VIEWS — Rule engine
//  Rule field definitions, operator helpers, and rule evaluation logic.
//  No DOM access — pure data functions only.
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

// --- Rule evaluation ---

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

// --- DB loaders ---

async function loadSmartViews() {
  smartViews = await dbGetAll('smartViews');
  renderSmartViewsSidebar();
}

async function loadEmailGroups() {
  emailGroups = await dbGetAll('emailGroups');
}
