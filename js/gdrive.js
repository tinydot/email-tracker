// ═══════════════════════════════════════════════════════
//  GOOGLE DRIVE BACKUP
//  Backs up the full-corpus JSON payload (same shape as the
//  "Export JSON" download) to a dedicated folder in the user's
//  own Google Drive.
//
//  Auth uses Google Identity Services (GIS), lazy-loaded only
//  when the user connects — the core app stays dependency-free
//  and offline-capable. The user supplies their own OAuth
//  Client ID (Google Cloud Console → OAuth 2.0 Web client),
//  stored locally in the settings store, mirroring the
//  "bring your own key" model used for the Claude API.
//
//  Scope is drive.file — the app can only see and touch files
//  it created itself, never the rest of the user's Drive.
// ═══════════════════════════════════════════════════════

const GDRIVE_SCOPE       = 'https://www.googleapis.com/auth/drive.file';
const GDRIVE_GIS_SRC     = 'https://accounts.google.com/gsi/client';
const GDRIVE_FOLDER_NAME = 'Email Tracker Backups';

// In-memory auth state (tokens are never persisted)
let gdriveClientId      = '';
let gdriveAutoBackup    = false;
let gdriveLastBackup    = null;   // ISO string of the most recent successful backup
let gdriveAccessToken   = null;
let gdriveTokenExpiry   = 0;      // epoch ms
let gdriveTokenClient   = null;   // GIS token client instance
let gdriveFolderId      = null;   // cached backup folder id
let _gisLoadPromise     = null;

// ── Persistence ─────────────────────────────────────────

async function loadGDriveSettings() {
  const rec = await dbGet('settings', 'gdrive');
  if (rec) {
    gdriveClientId   = rec.clientId   || '';
    gdriveAutoBackup = !!rec.autoBackup;
    gdriveLastBackup = rec.lastBackup || null;
  }
}

async function saveGDriveSettings() {
  await dbPut('settings', {
    key: 'gdrive',
    clientId:   gdriveClientId,
    autoBackup: gdriveAutoBackup,
    lastBackup: gdriveLastBackup,
  });
}

function gdriveIsConnected() {
  return !!gdriveAccessToken && Date.now() < gdriveTokenExpiry;
}

// ── GIS bootstrap + token handling ──────────────────────

function loadGisScript() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (_gisLoadPromise) return _gisLoadPromise;
  _gisLoadPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = GDRIVE_GIS_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => { _gisLoadPromise = null; reject(new Error('Could not load Google sign-in library (check your connection)')); };
    document.head.appendChild(s);
  });
  return _gisLoadPromise;
}

// Acquire a valid access token. Reuses the cached one until it nears expiry.
// `interactive` controls whether a consent popup may be shown; a non-interactive
// call resolves to null if consent is still required (avoids an unexpected popup).
async function gdriveEnsureToken(interactive = true) {
  if (gdriveIsConnected()) return gdriveAccessToken;
  if (!gdriveClientId) throw new Error('No Google OAuth Client ID configured');

  await loadGisScript();

  if (!gdriveTokenClient) {
    gdriveTokenClient = google.accounts.oauth2.initTokenClient({
      client_id: gdriveClientId,
      scope: GDRIVE_SCOPE,
      callback: () => {}, // replaced per-request below
    });
  }

  return new Promise((resolve, reject) => {
    gdriveTokenClient.callback = (resp) => {
      if (resp.error) {
        reject(new Error(resp.error_description || resp.error));
        return;
      }
      gdriveAccessToken = resp.access_token;
      // expires_in is seconds; refresh a minute early to be safe
      gdriveTokenExpiry = Date.now() + ((resp.expires_in || 3600) - 60) * 1000;
      resolve(gdriveAccessToken);
    };
    try {
      // '' prompts only when needed; 'consent'/'' both open a popup when consent
      // is missing. A non-interactive caller can't safely trigger that popup.
      gdriveTokenClient.requestAccessToken({ prompt: interactive ? '' : 'none' });
    } catch (err) {
      reject(err);
    }
  });
}

// Authenticated Drive API fetch with a single silent retry on 401 (expired token).
async function gdriveFetch(url, opts = {}, _retried = false) {
  const token = await gdriveEnsureToken(true);
  const headers = { ...(opts.headers || {}), Authorization: 'Bearer ' + token };
  const resp = await fetch(url, { ...opts, headers });
  if (resp.status === 401 && !_retried) {
    gdriveAccessToken = null;
    gdriveTokenExpiry = 0;
    return gdriveFetch(url, opts, true);
  }
  if (!resp.ok) {
    let detail = '';
    try { detail = (await resp.json())?.error?.message || ''; } catch {}
    throw new Error(`Drive API error ${resp.status}${detail ? ': ' + detail : ''}`);
  }
  return resp;
}

// ── Connect / disconnect ────────────────────────────────

async function gdriveConnect() {
  if (!gdriveClientId) {
    toast('Enter and save your Google OAuth Client ID first', 'warn');
    return;
  }
  try {
    await gdriveEnsureToken(true);
    toast('Connected to Google Drive', 'ok');
  } catch (err) {
    console.error('Google Drive connect failed:', err);
    toast('Google Drive connection failed: ' + err.message, 'err');
  }
  if (typeof showSettings === 'function' && isSettingsOpen()) showSettings();
}

function gdriveDisconnect() {
  if (gdriveAccessToken && window.google?.accounts?.oauth2) {
    try { google.accounts.oauth2.revoke(gdriveAccessToken, () => {}); } catch {}
  }
  gdriveAccessToken = null;
  gdriveTokenExpiry = 0;
  gdriveFolderId = null;
  toast('Disconnected from Google Drive', 'ok');
  if (typeof showSettings === 'function' && isSettingsOpen()) showSettings();
}

// ── Folder + file operations ────────────────────────────

async function gdriveGetBackupFolder() {
  if (gdriveFolderId) return gdriveFolderId;

  // Look for an existing (non-trashed) backup folder this app created.
  const q = encodeURIComponent(
    `name='${GDRIVE_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`
  );
  const listResp = await gdriveFetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&spaces=drive`
  );
  const { files } = await listResp.json();
  if (files && files.length) {
    gdriveFolderId = files[0].id;
    return gdriveFolderId;
  }

  // Create it.
  const createResp = await gdriveFetch('https://www.googleapis.com/drive/v3/files?fields=id', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: GDRIVE_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
  });
  gdriveFolderId = (await createResp.json()).id;
  return gdriveFolderId;
}

// Upload the current corpus as a new timestamped JSON file in the backup folder.
async function gdriveBackupNow({ silent = false } = {}) {
  if (!gdriveClientId) {
    if (!silent) toast('Configure Google Drive backup in Settings first', 'warn');
    return false;
  }
  try {
    if (!silent) toast('Backing up to Google Drive…', '');
    const folderId = await gdriveGetBackupFolder();
    const { blob, emailCount } = await buildBackupBlob();
    const stamp    = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `email-tracker-${stamp}.json`;

    // Multipart upload: metadata part + media part in one request. Assembled as a
    // Blob so the corpus is never concatenated into a single heap string — fetch
    // streams it from blob storage.
    const boundary = 'etbackup' + Math.random().toString(36).slice(2);
    const metadata = { name: filename, parents: [folderId], mimeType: 'application/json' };
    const body = new Blob([
      `--${boundary}\r\n` +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      JSON.stringify(metadata) + '\r\n' +
      `--${boundary}\r\n` +
      'Content-Type: application/json\r\n\r\n',
      blob,
      `\r\n--${boundary}--`,
    ]);

    await gdriveFetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
      {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body,
      }
    );

    gdriveLastBackup = new Date().toISOString();
    await saveGDriveSettings();
    const sizeKb = Math.round(blob.size / 1024);
    toast(`Backed up ${emailCount} emails to Google Drive (${sizeKb} KB)`, 'ok');
    if (typeof isSettingsOpen === 'function' && isSettingsOpen()) refreshGDriveBackupsList();
    return true;
  } catch (err) {
    console.error('Google Drive backup failed:', err);
    toast('Backup failed: ' + err.message, 'err');
    return false;
  }
}

// Called after a successful import when auto-backup is on.
async function gdriveMaybeAutoBackup() {
  if (!gdriveAutoBackup || !gdriveClientId) return;
  // Only proceed if we can get a token without forcing a popup mid-workflow.
  try {
    const token = await gdriveEnsureToken(false).catch(() => null);
    if (!token) {
      toast('Auto-backup skipped — reconnect Google Drive in Settings', 'warn');
      return;
    }
    await gdriveBackupNow({ silent: true });
  } catch (err) {
    console.warn('Auto-backup skipped:', err);
  }
}

async function gdriveListBackups() {
  const folderId = await gdriveGetBackupFolder();
  const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
  const resp = await gdriveFetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}` +
    `&fields=files(id,name,size,createdTime)&orderBy=createdTime desc&pageSize=100&spaces=drive`
  );
  return (await resp.json()).files || [];
}

async function gdriveRestoreBackup(fileId, fileName) {
  if (!confirm(`Restore from “${fileName}”?\n\nExisting emails are kept — only records not already present will be added.`)) return;
  try {
    toast('Downloading backup…', '');
    const resp = await gdriveFetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`
    );
    // Applied straight off the download — the backup is never held whole
    const { parts, anyAdded, totalRecords } = await applyBackupStream(resp.body);
    if (totalRecords === 0) return;
    toast(parts.length ? 'Restored: ' + parts.join(', ') : 'Nothing new to restore', anyAdded ? 'ok' : '');
  } catch (err) {
    console.error('Google Drive restore failed:', err);
    toast('Restore failed: ' + err.message, 'err');
  }
}

// ── Settings UI ─────────────────────────────────────────

function isSettingsOpen() {
  const el = document.getElementById('gdrive-settings-block');
  return !!el;
}

function renderGDriveSection() {
  const connected = gdriveIsConnected();
  const lastTxt = gdriveLastBackup
    ? `Last backup: ${new Date(gdriveLastBackup).toLocaleString()}`
    : 'No backups yet';

  return `
    <div id="gdrive-settings-block" style="padding:16px; background:var(--surface2); border:1px solid var(--border); border-radius:6px; margin-bottom:16px;">
      <div style="font-weight:500; margin-bottom:4px;">☁ Google Drive backup</div>
      <div style="color:var(--muted); font-size:12px; margin-bottom:14px;">
        Back up your full corpus (the same data as “Export JSON”) to a
        <strong>${escHtml(GDRIVE_FOLDER_NAME)}</strong> folder in your own Google Drive.
        Uses the <code>drive.file</code> scope, so this app can only see files it created — never the rest of your Drive.
        You supply your own OAuth Client ID; nothing is sent to any third-party server.
      </div>

      <div style="font-size:11px; font-family:var(--mono); letter-spacing:0.06em; text-transform:uppercase; color:var(--muted); margin-bottom:6px;">OAuth Client ID</div>
      <div style="display:flex; gap:6px; margin-bottom:6px;">
        <input type="text" id="gdrive-client-id" class="search-input" style="flex:1;"
               placeholder="xxxxxxxx.apps.googleusercontent.com"
               value="${escHtml(gdriveClientId)}">
        <button class="btn" onclick="saveGDriveClientId()">Save</button>
      </div>
      <div style="color:var(--muted); font-size:11px; margin-bottom:14px;">
        Create one at Google Cloud Console → APIs &amp; Services → Credentials → OAuth client ID
        (type “Web application”). Enable the Google Drive API, and add this page's origin
        (<code>${escHtml(location.origin)}</code>) under “Authorized JavaScript origins”.
      </div>

      <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:14px;">
        <span class="conn-dot ${connected ? 'ok' : ''}"></span>
        <span style="font-size:13px;">${connected ? 'Connected' : 'Not connected'}</span>
        ${connected
          ? `<button class="btn" onclick="gdriveDisconnect()">Disconnect</button>`
          : `<button class="btn btn-primary" onclick="gdriveConnect()" ${gdriveClientId ? '' : 'disabled'}>Connect</button>`}
        <button class="btn" onclick="gdriveBackupNow()" ${gdriveClientId ? '' : 'disabled'}>⬆ Back up now</button>
      </div>

      <div style="display:flex; align-items:center; gap:10px; margin-bottom:12px;">
        <input type="checkbox" id="gdrive-auto" ${gdriveAutoBackup ? 'checked' : ''}
               onchange="toggleGDriveAutoBackup(this.checked)"
               style="width:18px; height:18px; cursor:pointer;">
        <label for="gdrive-auto" style="cursor:pointer; font-size:13px;">Automatically back up after each import</label>
      </div>

      <div style="color:var(--muted); font-size:12px; margin-bottom:10px;">${escHtml(lastTxt)}</div>

      <div style="padding-top:12px; border-top:1px solid var(--border);">
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
          <div style="font-size:12px; font-weight:500;">Backups in Drive</div>
          <button class="btn" style="padding:2px 8px; font-size:11px;" onclick="refreshGDriveBackupsList()">↻ Refresh</button>
        </div>
        <div id="gdrive-backups-list" style="font-size:12px; color:var(--muted);">
          ${gdriveClientId ? 'Connect and refresh to list backups.' : 'Configure a Client ID to enable backups.'}
        </div>
      </div>
    </div>`;
}

async function saveGDriveClientId() {
  const input = document.getElementById('gdrive-client-id');
  if (!input) return;
  const val = input.value.trim();
  gdriveClientId = val;
  // A changed client id invalidates any existing token/client instance.
  gdriveTokenClient = null;
  gdriveAccessToken = null;
  gdriveTokenExpiry = 0;
  await saveGDriveSettings();
  toast(val ? 'Client ID saved' : 'Client ID cleared', 'ok');
  if (isSettingsOpen()) showSettings();
}

async function toggleGDriveAutoBackup(enabled) {
  gdriveAutoBackup = enabled;
  await saveGDriveSettings();
  toast(enabled ? 'Auto-backup after import enabled' : 'Auto-backup disabled', 'ok');
}

async function refreshGDriveBackupsList() {
  const el = document.getElementById('gdrive-backups-list');
  if (!el) return;
  if (!gdriveClientId) { el.textContent = 'Configure a Client ID to enable backups.'; return; }
  el.textContent = 'Loading…';
  try {
    const files = await gdriveListBackups();
    if (!files.length) { el.textContent = 'No backups found in Drive yet.'; return; }
    el.innerHTML = files.map(f => {
      const when = f.createdTime ? new Date(f.createdTime).toLocaleString() : '';
      const kb = f.size ? `${Math.round(f.size / 1024)} KB` : '';
      return `
        <div style="display:flex; align-items:center; gap:8px; padding:6px 8px; background:var(--surface); border:1px solid var(--border2); border-radius:4px; margin-bottom:4px;">
          <div style="flex:1; min-width:0;">
            <div style="color:var(--text); font-family:var(--mono); font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escHtml(f.name)}</div>
            <div style="font-size:11px;">${escHtml(when)}${kb ? ' · ' + kb : ''}</div>
          </div>
          <button class="btn" style="padding:2px 8px; font-size:11px;"
                  onclick="gdriveRestoreBackup('${escHtml(f.id)}', ${JSON.stringify(f.name).replace(/"/g, '&quot;')})">Restore</button>
        </div>`;
    }).join('');
  } catch (err) {
    el.textContent = 'Could not list backups: ' + err.message;
  }
}
