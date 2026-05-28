// ═══════════════════════════════════════════════════════
//  DRAG & DROP
// ═══════════════════════════════════════════════════════

function setupDropZone() {
  const dz = document.getElementById('drop-zone');
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag-over'); });
  dz.addEventListener('dragleave',()=> dz.classList.remove('drag-over'));
  dz.addEventListener('drop', e => {
    e.preventDefault();
    dz.classList.remove('drag-over');
    const files = e.dataTransfer.files;
    if (files.length) handleFiles(files);
  });
}

// ═══════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════

const _dateFormatter = new Intl.DateTimeFormat('en-SG', { day: '2-digit', month: 'short', year: '2-digit' });
const _formatDateCache = new Map();
function formatDate(iso) {
  const cached = _formatDateCache.get(iso);
  if (cached !== undefined) return cached;
  const out = _dateFormatter.format(new Date(iso));
  if (_formatDateCache.size > 20000) _formatDateCache.clear();
  _formatDateCache.set(iso, out);
  return out;
}

function formatSize(bytes) {
  if (!bytes) return '?';
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1048576) return Math.round(bytes / 1024) + 'KB';
  return (bytes / 1048576).toFixed(1) + 'MB';
}

function truncate(str, n) {
  if (!str) return '';
  return str.length > n ? str.substring(0, n) + '…' : str;
}

function recipientSpan(label, fullStr, maxLen, uid) {
  if (!fullStr || fullStr.length <= maxLen) {
    return `<span><b>${label}:</b> ${escHtml(fullStr || '—')}</span>`;
  }
  const s = `recip-${uid}-${label.toLowerCase()}`;
  return `<span><b>${label}:</b> <span id="${s}-short">${escHtml(truncate(fullStr, maxLen))} <a href="#" onclick="document.getElementById('${s}-short').style.display='none';document.getElementById('${s}-full').style.display='';return false;" style="color:var(--accent);text-decoration:none">show&nbsp;more</a></span><span id="${s}-full" style="display:none">${escHtml(fullStr)} <a href="#" onclick="document.getElementById('${s}-full').style.display='none';document.getElementById('${s}-short').style.display='';return false;" style="color:var(--accent);text-decoration:none">show&nbsp;less</a></span></span>`;
}

function escHtml(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

function toast(msg, type = '') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className   = 'show ' + type;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.className = ''; }, 3000);
}
