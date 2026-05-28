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

const VIEW_LABELS = {
  all:          'All Emails',
  unread:       'Unread',
  actionable:   'Actionable',
  awaiting:     'Awaiting Reply',
  threads:      'Threads',
  attachments:  'Has Attachments',
  automated:    'Automated / System',
  lowvalue:     'Low Value',
  addressbook:  'Address Book',
};

function showPanel(name) {
  document.getElementById('import-panel').style.display   = name === 'import'   ? '' : 'none';
  document.getElementById('progress-panel').className     = name === 'progress' ? 'active' : '';
  document.getElementById('email-list-panel').className   = name === 'list'     ? 'active' : '';
}
