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
  { value: 'isSystemEmail',     label: 'Is Automated' },
  { value: 'fromInGroup',       label: 'Sender in Group' },
  { value: 'recipientInGroup',  label: 'Recipient in Group' },
  { value: 'participantInGroup',label: 'Any Participant in Group' },
];

const BOOL_FIELDS  = new Set(['hasAttachments', 'isSystemEmail']);
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
    const statuses = ['unread','read'];
    return `<select>${statuses.map(s => `<option value="${s}" ${value === s ? 'selected' : ''}>${s}</option>`).join('')}</select>`;
  }
  return `<input type="text" value="${escHtml(value)}" placeholder="Value…">`;
}

// --- Rule evaluation ---

// Lazily compute & cache lowercase forms of stable email fields on the email
// object itself (in a hidden `_lc` slot). Smart-view filtering invokes this
// hot path N (emails) × M (rules) × K (views) times per render, so caching
// turns repeated .toLowerCase() / .split() / .map() work into one-time cost.
// Cache is invalidated by callers that mutate these fields (see invalidateEmailLC).
function getEmailLC(email) {
  let c = email._lc;
  if (!c) {
    const from   = (email.fromAddr || '').toLowerCase();
    const toList = (email.toAddrs  || []).map(a => (a || '').toLowerCase());
    const ccList = (email.ccAddrs  || []).map(a => (a || '').toLowerCase());
    c = email._lc = {
      fromAddr:   from,
      fromName:   (email.fromName || '').toLowerCase(),
      fromDomain: (from.split('@')[1] || ''),
      subject:    (email.subject  || '').toLowerCase(),
      toAddr:     toList.join(' '),
      toDomain:   toList.map(a => a.split('@')[1] || '').join(' '),
      ccAddr:     ccList.join(' '),
      ccDomain:   ccList.map(a => a.split('@')[1] || '').join(' '),
      toList,
      ccList,
    };
  }
  return c;
}

function invalidateEmailLC(email) {
  if (email) email._lc = null;
}

function getEmailFieldValue(email, field) {
  const lc = getEmailLC(email);
  switch (field) {
    case 'fromAddr':       return lc.fromAddr;
    case 'fromName':       return lc.fromName;
    case 'fromDomain':     return lc.fromDomain;
    case 'toAddr':         return lc.toAddr;
    case 'toDomain':       return lc.toDomain;
    case 'ccAddr':         return lc.ccAddr;
    case 'ccDomain':       return lc.ccDomain;
    case 'subject':        return lc.subject;
    case 'status':         return (email.status || '').toLowerCase();
    case 'tags':           return (email.tags   || []).join(' ').toLowerCase();
    case 'hasAttachments': return email.hasAttachments ? 'true' : 'false';
    case 'isSystemEmail':  return email.isSystemEmail  ? 'true' : 'false';
    default: return '';
  }
}

// Cache lowercase Set of group members on the group object itself for O(1) lookup.
// Callers mutating group.members must call invalidateGroupCache(group).
function getGroupMemberSet(group) {
  let s = group._memberSet;
  if (!s) {
    s = group._memberSet = new Set((group.members || []).map(m => (m || '').toLowerCase()));
  }
  return s;
}

function invalidateGroupCache(group) {
  if (group) group._memberSet = null;
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
    const members = getGroupMemberSet(group);
    if (!members.size) return operator === 'not_in_group';
    const lc = getEmailLC(email);
    let match = false;
    if (field === 'fromInGroup') {
      match = members.has(lc.fromAddr);
    } else if (field === 'recipientInGroup') {
      match = lc.toList.some(a => members.has(a)) || lc.ccList.some(a => members.has(a));
    } else { // participantInGroup
      match = members.has(lc.fromAddr)
           || lc.toList.some(a => members.has(a))
           || lc.ccList.some(a => members.has(a));
    }
    return operator === 'in_group' ? match : !match;
  }
  const fv = getEmailFieldValue(email, field);
  // Cache rule.value lowercase on the rule object — rules are immutable for
  // the lifetime of a smart view (edits create a fresh rules array).
  let val = rule._valueLC;
  if (val === undefined) {
    val = rule._valueLC = (value || '').toLowerCase();
  }
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
