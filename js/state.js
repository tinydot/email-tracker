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
let svSubView      = 'emails'; // 'emails' | 'attachments' | 'links' — sub-view within smart views
let emailGroups    = []; // user-created email groups for smart view rules

const VIEW_LABELS = {
  all:          'All Emails',
  dashboard:    'Dashboard',
  unread:       'Unread',
  threads:      'Threads',
  attachments:  'Has Attachments',
  automated:    'Automated / System',
  addressbook:  'Address Book',
};

function showPanel(name) {
  document.getElementById('import-panel').style.display   = name === 'import' ? '' : 'none';
  document.getElementById('email-list-panel').className   = name === 'list'   ? 'active' : '';
}
