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

const AI_SYSTEM_PROMPT_DEFAULT = 'You tag and summarize project emails. Return 1–4 short lowercase tags (company names, topics, document types) and a one-sentence summary under 25 words. Tags must be single words or hyphenated, e.g. "rcy", "drawing-submission", "rfi".';
const AI_USER_TEMPLATE_DEFAULT = 'Subject: {{subject}}\nFrom: {{from}}\nTo: {{to}}\n{{cc}}\n\n{{body}}';
const AI_BODY_LIMIT_DEFAULT    = 2000;

let aiSystemPrompt = AI_SYSTEM_PROMPT_DEFAULT;
let aiUserTemplate = AI_USER_TEMPLATE_DEFAULT;
let aiBodyLimit    = AI_BODY_LIMIT_DEFAULT;

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
  transmittals: 'Transmittal Register',
};

function showPanel(name) {
  document.getElementById('import-panel').style.display   = name === 'import'   ? '' : 'none';
  document.getElementById('progress-panel').className     = name === 'progress' ? 'active' : '';
  document.getElementById('email-list-panel').className   = name === 'list'     ? 'active' : '';
}
