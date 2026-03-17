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
