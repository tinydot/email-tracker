// ═══════════════════════════════════════════════════════
//  SMART VIEWS — View routing & filtering
//  switchView, applyFilters, search, and sort.
// ═══════════════════════════════════════════════════════

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
  } else if (view === 'addressbook') {
    document.getElementById('view-title').textContent = VIEW_LABELS[view] || view;
    hideSvTabToggle();
    document.querySelector('.toolbar').style.display = '';
    document.querySelector('.email-list-header').style.display = 'none';
    showAddressBook();
  } else if (view === 'dashboard') {
    document.getElementById('view-title').textContent = VIEW_LABELS[view] || view;
    hideSvTabToggle();
    document.querySelector('.toolbar').style.display = '';
    document.querySelector('.email-list-header').style.display = 'none';
    showDashboard();
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
let _searchGeneration = 0;  // discards results of a scan the user has typed past

function searchEmails(val) {
  clearTimeout(_searchDebounceTimer);
  _searchDebounceTimer = setTimeout(async () => {
    const term = val.toLowerCase();
    const gen  = ++_searchGeneration;
    // Bodies live in their own store, so a body search is a cursor pass rather
    // than an in-memory scan. Only the matching ids are kept.
    const matches = term ? await scanBodiesFor(term) : null;
    if (gen !== _searchGeneration) return; // a newer search superseded this one
    searchTerm        = term;
    searchBodyMatches = matches;
    applyFilters();
  }, 150);
}

// One streaming pass over the `bodies` store, collecting the ids whose text
// contains `term`. Only ids are retained — bodies are released as we go.
async function scanBodiesFor(term) {
  const ids = new Set();
  await dbIterate('bodies', rec => {
    if (rec.text && rec.text.toLowerCase().includes(term)) ids.add(rec.id);
  });
  return ids;
}

// Keeps the active search result honest after a body is edited in place,
// without re-running the whole scan.
function updateSearchMatchForBody(id, text) {
  if (!searchBodyMatches || !searchTerm) return;
  if (text && text.toLowerCase().includes(searchTerm)) searchBodyMatches.add(id);
  else searchBodyMatches.delete(id);
}

function applyFilters() {
  // Resolve smart view if active
  let sv = null;
  if (currentView.startsWith('sv-')) {
    const svId = currentView.slice(3);
    sv = smartViews.find(s => s.id === svId) || null;
  }

  const excludeSystem = sv ? sv.excludeAutomated !== false : currentView !== 'automated';
  const term          = searchTerm;

  // Single pass: all predicates combined
  const list = [];
  for (const e of allEmails) {
    if (excludeSystem && e.isSystemEmail) continue;

    if (sv) {
      if (!applySmartViewRules(e, sv)) continue;
    } else {
      switch (currentView) {
        case 'unread':      if (e.status !== 'unread')        continue; break;
        case 'threads':     if (e.inReplyTo || !hasReplies(e)) continue; break;
        case 'attachments': if (!e.hasAttachments)             continue; break;
        case 'automated':   if (!e.isSystemEmail)              continue; break;
      }
    }

    if (term) {
      const attNames = attachmentNameIndex.get(e.id);
      if (
        !(e.subject  || '').toLowerCase().includes(term) &&
        !(e.fromAddr || '').toLowerCase().includes(term) &&
        !(e.fromName || '').toLowerCase().includes(term) &&
        !(searchBodyMatches && searchBodyMatches.has(e.id)) &&
        !(attNames && attNames.includes(term))
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
  } else if (currentView.startsWith('sv-') && svSubView === 'links') {
    showSvLinks();
  } else {
    renderEmailList();
  }
}
