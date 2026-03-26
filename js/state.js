// ═══════════════════════════════════════════════════════
//  UI STATE
// ═══════════════════════════════════════════════════════

let allEmails      = [];
let filteredEmails = [];
let currentView    = 'all';
let currentSort    = 'date-desc';
let searchTerm     = '';
let selectedEmail  = null;
let selectedEmailIdx = -1; // index in filteredEmails for navigation
let smartViews     = []; // user-created smart views
let svSubView      = 'emails'; // 'emails' | 'attachments' — sub-view within smart views
let emailGroups    = []; // user-created email groups for smart view rules
let autoTagRules   = []; // user-created auto-tag rules (applied on import)

const AI_SYSTEM_PROMPT_DEFAULT = 'You analyze project emails. Return JSON with: intent (one of: "actionable" — requires action from recipient, "statement" — declares facts or updates, "answer" — responds to a prior question or request, "actioned" — confirms something was completed, "fyi" — informational only); summary (one sentence under 20 words matching the intent, e.g. "Requests drawing markup and site inspection confirmation by Friday"); tags (1–4 lowercase single-word or hyphenated tags: company names, topics, document types, e.g. "rcy", "drawing-submission", "rfi"); actionItems (array of {id: "a1"/"a2"/..., description: the specific action required in under 15 words} — only when intent is "actionable", otherwise empty array).';
const AI_THREAD_SYSTEM_PROMPT = 'You analyze email thread action items. Given a thread as structured JSON (summaries and action items only — no full bodies), determine the current status of each action item. For each, return status "open" (not yet addressed), "resolved" (clearly completed in a later email), or "deferred" (acknowledged but postponed). Return JSON with "updates": array of {emailId, actionItemId, status}.';
const AI_USER_TEMPLATE_DEFAULT = 'Subject: {{subject}}\nFrom: {{from}}\nTo: {{to}}\n{{cc}}\n{{contacts}}\n\n{{body}}';
const AI_BODY_LIMIT_DEFAULT    = 2000;

let aiSystemPrompt  = AI_SYSTEM_PROMPT_DEFAULT;
let aiUserTemplate  = AI_USER_TEMPLATE_DEFAULT;
let aiBodyLimit     = AI_BODY_LIMIT_DEFAULT;
let aiThreadPrompt  = AI_THREAD_SYSTEM_PROMPT;

const VIEW_LABELS = {
  all:          'All Emails',
  unread:       'Unread',
  actionable:   'Actionable',
  awaiting:     'Awaiting Reply',
  threads:      'Threads',
  attachments:  'Has Attachments',
  automated:    'Automated / System',
  lowvalue:     'Low Value',
  issues:       'Issues',
  actionitems:  'Action Items',
  transmittals: 'Transmittal Register',
  addressbook:  'Address Book',
};

function showPanel(name) {
  document.getElementById('import-panel').style.display   = name === 'import'   ? '' : 'none';
  document.getElementById('progress-panel').className     = name === 'progress' ? 'active' : '';
  document.getElementById('email-list-panel').className   = name === 'list'     ? 'active' : '';
}
