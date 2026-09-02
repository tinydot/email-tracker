// ═══════════════════════════════════════════════════════
//  IMPORT PIPELINE
// ═══════════════════════════════════════════════════════

let importedEmails = 0;
let emlArchiveDirHandle = null; // For organizing imported EML files
let extractNestedAttachments = true; // Setting: record attachments from embedded .eml files
let organizeEmlFiles = true; // Setting: copy EML files to organized folders by domain

async function organizeEmlFile(file, fromAddr) {
  if (!emlArchiveDirHandle || !fromAddr) return null;
  
  try {
    // Extract domain from sender email
    const domain = fromAddr.split('@')[1] || 'unknown';
    const sanitizedDomain = domain.replace(/[^a-zA-Z0-9.-]/g, '_').replace(/^_+|_+$/g, '');
    
    // Get or create domain subfolder
    const domainFolder = await emlArchiveDirHandle.getDirectoryHandle(sanitizedDomain, { create: true });
    
    // Sanitize filename
    let filename = file.name.replace(/[<>:"/\\|?*]/g, '_');
    
    // Check if file exists - if so, add counter
    let finalFilename = filename;
    let counter = 1;
    let fileHandle = null;
    
    while (counter < 1000) {
      try {
        fileHandle = await domainFolder.getFileHandle(finalFilename, { create: false });
        // File exists - try next number
        const extIndex = filename.lastIndexOf('.');
        const basename = extIndex > 0 ? filename.substring(0, extIndex) : filename;
        const ext = extIndex > 0 ? filename.substring(extIndex) : '';
        finalFilename = `${basename}_${counter}${ext}`;
        counter++;
      } catch {
        // File doesn't exist - good to use
        break;
      }
    }
    
    // Read the file content
    const arrayBuffer = await file.arrayBuffer();
    
    // Create and write file
    fileHandle = await domainFolder.getFileHandle(finalFilename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(arrayBuffer);
    await writable.close();
    
    return `${sanitizedDomain}/${finalFilename}`;
  } catch (err) {
    console.error('Failed to organize EML file:', file.name, err);
    return null;
  }
}

// ═══════════════════════════════════════════════════════
//  STORAGE CONNECTIONS
//  Folder handles are persisted in the settings store so they
//  survive reloads; a restored handle whose permission has lapsed
//  is kept in a "pending" slot until the user clicks Reconnect
//  (permission re-grant needs a user gesture).
// ═══════════════════════════════════════════════════════

let pendingEmlHandle = null;

async function persistDirHandle(key, handle) {
  try {
    await dbPut('settings', { key, handle });
  } catch (err) {
    console.warn('Could not persist folder handle:', key, err);
  }
}

async function restoreDirHandles() {
  if ('showDirectoryPicker' in window) {
    // Attachment extraction was removed — clean up the legacy folder handle
    try { await dbDelete('settings', 'attachmentDirHandle'); } catch {}
    try {
      const rec = await dbGet('settings', 'emlArchiveDirHandle');
      if (rec?.handle) {
        const perm = await rec.handle.queryPermission({ mode: 'readwrite' });
        if (perm === 'granted') emlArchiveDirHandle = rec.handle;
        else if (perm === 'prompt') pendingEmlHandle = rec.handle;
      }
    } catch (err) {
      console.warn('Could not restore EML archive folder handle:', err);
    }
  }
  renderConnectionStatus();
}

async function connectEmlArchiveFolder() {
  // One-click re-grant on the previously used folder, if we have one
  if (!emlArchiveDirHandle && pendingEmlHandle) {
    try {
      const granted = await pendingEmlHandle.requestPermission({ mode: 'readwrite' });
      if (granted === 'granted') {
        emlArchiveDirHandle = pendingEmlHandle;
        pendingEmlHandle = null;
        renderConnectionStatus();
        toast('EML archive folder reconnected: ' + emlArchiveDirHandle.name, 'ok');
        return;
      }
    } catch (err) {
      console.warn('Permission re-grant failed, falling back to picker:', err);
    }
  }
  await setupEmlArchiveFolder();
}

async function disconnectEmlArchiveFolder() {
  emlArchiveDirHandle = null;
  pendingEmlHandle = null;
  try { await dbDelete('settings', 'emlArchiveDirHandle'); } catch {}
  renderConnectionStatus();
  toast('EML archive folder disconnected', 'ok');
}

function renderConnectionStatus() {
  const supported = 'showDirectoryPicker' in window;
  const rows = [
    {
      dot: 'conn-eml-dot', detail: 'conn-eml-detail', btn: 'conn-eml-btn', x: 'conn-eml-x',
      handle: emlArchiveDirHandle, pending: pendingEmlHandle,
      connectedText: h => `Copying imported .eml files into “${h.name}” by sender domain`,
      offText: 'Not connected — needed to reopen originals and their attachments later',
    },
  ];

  for (const r of rows) {
    const dot    = document.getElementById(r.dot);
    const detail = document.getElementById(r.detail);
    const btn    = document.getElementById(r.btn);
    const x      = document.getElementById(r.x);
    if (!dot || !detail || !btn || !x) return;

    if (!supported) {
      dot.className = 'conn-dot';
      detail.textContent = 'Not supported in this browser (use Chrome or Edge)';
      btn.disabled = true;
      x.style.display = 'none';
      continue;
    }

    if (r.handle) {
      dot.className = 'conn-dot ok';
      detail.textContent = r.connectedText(r.handle);
      btn.textContent = 'Change';
      x.style.display = '';
    } else if (r.pending) {
      dot.className = 'conn-dot warn';
      detail.textContent = `“${r.pending.name}” needs permission — click Reconnect`;
      btn.textContent = 'Reconnect';
      x.style.display = '';
    } else {
      dot.className = 'conn-dot';
      detail.textContent = r.offText;
      btn.textContent = 'Connect';
      x.style.display = 'none';
    }
  }

  const importBtn = document.getElementById('conn-import-btn');
  if (importBtn && !supported) importBtn.disabled = true;
}

async function setupEmlArchiveFolder() {
  if (!('showDirectoryPicker' in window)) {
    alert('File System Access API not supported in this browser.');
    return false;
  }

  try {
    emlArchiveDirHandle = await window.showDirectoryPicker({
      mode: 'readwrite',
      startIn: 'documents',
    });
    
    // Check permission
    const permission = await emlArchiveDirHandle.queryPermission({ mode: 'readwrite' });
    if (permission !== 'granted') {
      const granted = await emlArchiveDirHandle.requestPermission({ mode: 'readwrite' });
      if (granted !== 'granted') {
        alert('Storage permission denied.');
        emlArchiveDirHandle = null;
        renderConnectionStatus();
        return false;
      }
    }

    pendingEmlHandle = null;
    await persistDirHandle('emlArchiveDirHandle', emlArchiveDirHandle);
    renderConnectionStatus();
    toast('EML archive folder: ' + emlArchiveDirHandle.name, 'ok');
    return true;
  } catch (err) {
    if (err.name === 'AbortError') {
      console.log('EML folder selection cancelled by user');
      return false;
    } else {
      console.error('EML archive folder setup failed:', err);
      alert('Failed to select EML archive folder:\n' + err.message);
      return false;
    }
  }
}

async function handleFiles(files) {
  if (!files.length) return;
  // Storage folders are connected via the checklist in the import panel —
  // no blocking prompts here; the import log notes what isn't connected.
  await processFilesForImport(Array.from(files));
}

async function handleFolderImport() {
  if (!('showDirectoryPicker' in window)) {
    alert('Folder import requires File System Access API which is not supported in this browser.\n\nPlease use Chrome or Edge.');
    return;
  }

  try {
    const dirHandle = await window.showDirectoryPicker({
      mode: 'read',
    });
    
    toast('Scanning folder recursively...', 'ok');
    
    // Recursively collect all .eml files
    const emlFiles = await collectEmlFilesRecursively(dirHandle);
    
    if (emlFiles.length === 0) {
      toast('No .eml files found in folder', 'warn');
      return;
    }
    
    toast(`Found ${emlFiles.length} .eml file(s)`, 'ok');
    
    // Process the collected files (skip the prompts since we already did them)
    await processFilesForImport(emlFiles);
    
  } catch (err) {
    if (err.name === 'AbortError') {
      console.log('Folder selection cancelled');
    } else {
      console.error('Folder import error:', err);
      alert('Failed to import folder:\n' + err.message);
    }
  }
}

async function collectEmlFilesRecursively(dirHandle, path = '') {
  const files = [];
  
  for await (const entry of dirHandle.values()) {
    const currentPath = path ? `${path}/${entry.name}` : entry.name;
    
    if (entry.kind === 'file' && entry.name.toLowerCase().endsWith('.eml')) {
      // Get the actual File object
      const file = await entry.getFile();
      files.push(file);
    } else if (entry.kind === 'directory') {
      // Recursively scan subdirectory
      const subFiles = await collectEmlFilesRecursively(entry, currentPath);
      files.push(...subFiles);
    }
  }
  
  return files;
}

function toggleImportLog() {
  const log = document.getElementById('ipb-log');
  const btn = document.getElementById('ipb-toggle-btn');
  const visible = log.style.display !== 'none';
  log.style.display = visible ? 'none' : '';
  btn.textContent = visible ? '▲ Log' : '▼ Log';
  // when log is shown, adjust bottom padding
  document.getElementById('email-list-panel').style.paddingBottom =
    visible ? '' : '168px';
}

async function processFilesForImport(fileArr) {

  // Switch to list panel so user can browse while import runs
  showPanel('list');
  const bar    = document.getElementById('import-progress-bar');
  const fill   = document.getElementById('ipb-fill');
  const counts = document.getElementById('ipb-counts');
  const pct    = document.getElementById('ipb-pct');
  const log    = document.getElementById('ipb-log');
  const title  = bar.querySelector('.ipb-title');

  log.innerHTML = '';
  bar.style.display = '';
  document.getElementById('email-list-panel').classList.add('import-running');

  // The log is a scrollback, not a record — keep only the tail so a 25k-file
  // import doesn't leave 25k nodes (and their text) in the DOM.
  const MAX_LOG_LINES = 400;
  const appendLog = (msg, cls = '') => {
    const d = document.createElement('div');
    d.className = 'log-line ' + cls;
    d.textContent = msg;
    log.appendChild(d);
    while (log.childElementCount > MAX_LOG_LINES) log.removeChild(log.firstElementChild);
    log.scrollTop = log.scrollHeight;
  };

  appendLog(`Starting import of ${fileArr.length} file(s)…`);
  if (organizeEmlFiles) {
    if (emlArchiveDirHandle) {
      appendLog(`EML archive: ${emlArchiveDirHandle.name}`, 'ok');
    } else {
      appendLog(`EML archive: not connected (originals stay where they are)`, 'warn');
    }
  }

  let ok = 0, errs = 0, updated = 0;
  const LIST_REFRESH_MS = 1500;
  let lastListRefresh = performance.now();

  for (let i = 0; i < fileArr.length; i++) {
    const file = fileArr[i];
    const prog = Math.round((i / fileArr.length) * 100);
    fill.style.width  = prog + '%';
    counts.textContent = `${i} / ${fileArr.length}`;
    pct.textContent   = prog + '%';

    try {
      const raw = await file.text();
      const parsed = parseEML(raw);

      if (!parsed) {
        appendLog(`⚠ ${file.name}: parse failed`, 'warn');
        errs++;
        continue;
      }

      // Generate stable ID
      const id = parsed.messageId || `${file.name}-${parsed.date || Date.now()}`;

      // Check for existing (full record or tombstone)
      const seen = await dbGet('seenIds', id);
      if (seen) {
        appendLog(`⊘ ${file.name}: previously discarded (skipped)`, 'warn');
        continue;
      }
      const existing = await dbGet('emails', id);
      if (existing) {
        // Re-parse recipients in case the email was imported with the old buggy parser
        const toAddrs = parsed.to.map(a => a.email);
        const ccAddrs = parsed.cc.map(a => a.email);
        const toChanged = toAddrs.length !== (existing.toAddrs || []).length;
        const ccChanged = ccAddrs.length !== (existing.ccAddrs || []).length;
        if (toChanged || ccChanged) {
          await dbPut('emails', { ...existing, toAddrs, ccAddrs });
          appendLog(`↻ ${file.name}: recipients updated (To: ${toAddrs.length}, CC: ${ccAddrs.length})`, 'ok');
          updated++;
        } else {
          appendLog(`⊘ ${file.name}: already imported (skipped)`, 'warn');
        }
        continue;
      }

      // Detect system/automated email
      const isSystemEmail = detectSystemEmail(parsed.rawHeaders, parsed.from.email, parsed.subject, parsed.textBody);

      const emailRecord = {
        id,
        messageId:    parsed.messageId,
        inReplyTo:    parsed.inReplyTo,
        references:   parsed.references,
        subject:      parsed.subject,
        fromAddr:     parsed.from.email,
        fromName:     parsed.from.name,
        toAddrs:      parsed.to.map(a => a.email),
        ccAddrs:      parsed.cc.map(a => a.email),
        date:         parsed.date,
        isSystemEmail,
        status:       'unread',
        tags:         [],
        hasAttachments: parsed.attachments.length > 0,
        attachmentCount: parsed.attachments.length,
        importedAt:   new Date().toISOString(),
        fileName:     file.name,
      };

      await dbPut('emails', emailRecord);
      // Body goes to its own store — see the `bodies` store in js/db.js
      await putBody(id, parsed.textBody);

      // Organize EML file if enabled
      if (emlArchiveDirHandle && organizeEmlFiles) {
        try {
          const emlPath = await organizeEmlFile(file, emailRecord.fromAddr);
          if (emlPath) {
            // Optionally store the path in the email record
            emailRecord.emlArchivePath = emlPath;
            await dbPut('emails', emailRecord);
            console.log('Organized EML:', file.name, '→', emlPath);
          } else {
            console.warn('EML organization returned null for:', file.name);
          }
        } catch (err) {
          console.error('Failed to organize EML:', file.name, err);
          appendLog(`  ⚠ Failed to organize EML: ${err.message}`, 'warn');
        }
      }

      // Index Message-ID
      if (parsed.messageId) {
        await dbPut('msgIndex', { messageId: parsed.messageId, emailId: id });
      }

      // Store attachment metadata
      for (const att of parsed.attachments) {
        const attId = `${id}::${att.filename}`;
        const attRecord = {
          id: attId,
          emailId: id,
          filename: att.filename,
          contentType: att.contentType,
          size: att.size,
          hash: att.hash,
          contentId: att.contentId || null,
          isNested: false,
          parentFilename: null,
          importedAt: new Date().toISOString(),
        };

        // Inherit blacklist status from any existing attachment with the same hash
        const existingForBlacklist = await dbGetByIndex('attachments', 'hash', att.hash);
        if (existingForBlacklist.some(a => a.isBlacklisted)) {
          attRecord.isBlacklisted = true;
        }

        await dbPut('attachments', attRecord);

        // Extract text alongside the import — bounded, so it can't outpace us
        await queueAttachmentTextExtraction(attId, att.rawData, att.contentType, att.filename);

        // Process nested attachments (from embedded .eml files)
        if (att.nestedAttachments && att.nestedAttachments.length > 0) {
          for (const nested of att.nestedAttachments) {
            const nestedId = `${id}::${att.filename}::${nested.filename}`;
            const nestedRecord = {
              id: nestedId,
              emailId: id,
              filename: nested.filename,
              contentType: nested.contentType,
              size: nested.size,
              hash: nested.hash,
              isNested: true,
              parentFilename: att.filename,
              importedAt: new Date().toISOString(),
            };

            // Inherit blacklist status from any existing attachment with the same hash
            const existingNested = await dbGetByIndex('attachments', 'hash', nested.hash);
            if (existingNested.some(a => a.isBlacklisted)) {
              nestedRecord.isBlacklisted = true;
            }

            await dbPut('attachments', nestedRecord);

            // Extract text alongside the import — bounded, so it can't outpace us
            await queueAttachmentTextExtraction(nestedId, nested.rawData, nested.contentType, nested.filename);
          }
        }
      }

      ok++;
      // Add to in-memory list immediately so user sees it while browsing
      allEmails.push(emailRecord);
      const totalAttachments = parsed.attachments.reduce((sum, att) =>
        sum + 1 + (att.nestedAttachments?.length || 0), 0);
      const attInfo = totalAttachments > 0 ? ` [${totalAttachments} attach]` : '';
      appendLog(`✓ ${file.name}${attInfo}`, 'ok');

    } catch (err) {
      appendLog(`✕ ${file.name}: ${err.message}`, 'err');
      errs++;
    }

    // Yield to the UI often (cheap), but refresh the list on a timer rather
    // than every 5 files — applyFilters() re-scans and re-sorts the whole
    // corpus, which at 25k emails is far too costly to run thousands of times.
    if (i % 5 === 0) await new Promise(r => setTimeout(r, 0));
    if (performance.now() - lastListRefresh > LIST_REFRESH_MS) {
      lastListRefresh = performance.now();
      applyFilters();
      updateHeaderStatsFast();
    }
  }

  // Extraction runs alongside the loop; let the tail of it land before the
  // reload below so attachment text is in the DB when the list rebuilds.
  await drainExtractionQueue();

  fill.style.width  = '100%';
  pct.textContent   = '100%';
  const skipped = fileArr.length - ok - errs - updated;
  const doneMsg = `Done — ${ok} imported${updated > 0 ? `, ${updated} recipients updated` : ''}${skipped > 0 ? `, ${skipped} skipped (duplicates)` : ''}, ${errs} errors.`;
  appendLog(doneMsg, ok > 0 || updated > 0 ? 'ok' : 'err');
  title.textContent = 'Import complete';

  importedEmails += ok;

  // Full reload to rebuild thread cache, nav counts etc.
  await loadEmailList();
  await updateHeaderStats();

  // Hide the progress bar after a short delay so user can read the result
  await new Promise(r => setTimeout(r, 2000));
  bar.style.display = 'none';
  document.getElementById('email-list-panel').classList.remove('import-running');
  document.getElementById('email-list-panel').style.paddingBottom = '';
  // Reset log toggle state for next import
  document.getElementById('ipb-log').style.display = 'none';
  document.getElementById('ipb-toggle-btn').textContent = '▲ Log';
  title.textContent = 'Importing emails…';

  toast(`Imported ${ok} email(s)`, 'ok');

  // Auto-backup to Google Drive if enabled and something actually changed.
  if ((ok > 0 || updated > 0) && typeof gdriveMaybeAutoBackup === 'function') {
    gdriveMaybeAutoBackup();
  }
}

// ═══════════════════════════════════════════════════════
//  EML REIMPORT (single email — retrieve full body)
// ═══════════════════════════════════════════════════════

// Shared helper: resolve the File object for an email's archived EML.
// Returns { file, sanitizedDomain, targetFilename } or null on failure.
async function _resolveEmlFile(email) {
  let dirHandle = emlArchiveDirHandle;
  if (!dirHandle) {
    try {
      dirHandle = await window.showDirectoryPicker({ mode: 'read', startIn: 'documents' });
    } catch (err) {
      if (err.name !== 'AbortError') toast('Could not open folder: ' + err.message, 'err');
      return null;
    }
  }

  const domain = (email.fromAddr || '').split('@')[1] || 'unknown';
  const sanitizedDomain = domain.replace(/[^a-zA-Z0-9.-]/g, '_').replace(/^_+|_+$/g, '');

  let domainFolder;
  try {
    domainFolder = await dirHandle.getDirectoryHandle(sanitizedDomain);
  } catch {
    toast(`Domain folder "${sanitizedDomain}" not found in selected folder`, 'err');
    return null;
  }

  let targetFilename = email.fileName || '';
  if (email.emlArchivePath) {
    const parts = email.emlArchivePath.split('/');
    targetFilename = parts[parts.length - 1] || targetFilename;
  }
  if (!targetFilename) {
    toast('No filename stored for this email', 'err');
    return null;
  }

  let fileHandle;
  try {
    fileHandle = await domainFolder.getFileHandle(targetFilename);
  } catch {
    toast(`File "${targetFilename}" not found in ${sanitizedDomain}/`, 'err');
    return null;
  }

  return { file: await fileHandle.getFile(), sanitizedDomain, targetFilename };
}

async function reimportEmlBody(emailId) {
  const email = emailIdIndex.get(emailId);
  if (!email) return;

  try {
    const resolved = await _resolveEmlFile(email);
    if (!resolved) return;
    const { file, sanitizedDomain, targetFilename } = resolved;
    const raw = await file.text();
    const parsed = parseEML(raw);
    if (!parsed) {
      toast('Failed to parse EML file', 'err');
      return;
    }

    // Use the raw (pre-strip) body so truncation controls can find quote markers.
    // The user will choose how much to keep via the truncation controls,
    // then confirm with "Save Truncated" or "Save Full".
    const bodyForTrunc = parsed.rawTextBody || parsed.textBody;

    // Held unsaved in selectedEmailBody — "Save Truncated" / "Save Full" is what
    // commits it to the bodies store.
    if (selectedEmail?.id === emailId) {
      selectedEmailBody = bodyForTrunc;
      _loadedBodyId     = emailId;
      const bodyEl = document.getElementById('det-body-text');
      if (bodyEl) bodyEl.textContent = bodyForTrunc || '(no plain text body)';

      // Show Save Full button so user can bypass truncation if they want the whole body
      const saveFullBtn = document.getElementById('trunc-save-full-btn');
      if (saveFullBtn) saveFullBtn.style.display = '';

      // Auto-scan for truncation points and populate the controls
      // (truncFindMatches reads selectedEmailBody, which we just updated above)
      truncFindMatches();
    }

    // Re-process attachments — add any metadata records missing from the DB.
    // Existing attachment records are left untouched to preserve blacklist
    // status and other persisted flags. Files are never written to disk —
    // the archived .eml itself is the attachment store.

    let newAttCount = 0;
    for (const att of parsed.attachments) {
      const attId = `${emailId}::${att.filename}`;
      const existing = await dbGet('attachments', attId);

      if (!existing) {
        const attRecord = {
          id: attId,
          emailId,
          filename: att.filename,
          contentType: att.contentType,
          size: att.size,
          hash: att.hash,
          contentId: att.contentId || null,
          isNested: false,
          parentFilename: null,
          importedAt: new Date().toISOString(),
        };

        const existingForBlacklist = await dbGetByIndex('attachments', 'hash', att.hash);
        if (existingForBlacklist.some(a => a.isBlacklisted)) attRecord.isBlacklisted = true;

        await dbPut('attachments', attRecord);
        await queueAttachmentTextExtraction(attId, att.rawData, att.contentType, att.filename);
        newAttCount++;
      }

      // Process nested attachments (embedded .eml files)
      for (const nested of (att.nestedAttachments || [])) {
        const nestedId = `${emailId}::${att.filename}::${nested.filename}`;
        const existingNested = await dbGet('attachments', nestedId);

        if (!existingNested) {
          const nestedRecord = {
            id: nestedId,
            emailId,
            filename: nested.filename,
            contentType: nested.contentType,
            size: nested.size,
            hash: nested.hash,
            contentId: nested.contentId || null,
            isNested: true,
            parentFilename: att.filename,
            importedAt: new Date().toISOString(),
          };

          const existingNestedBL = await dbGetByIndex('attachments', 'hash', nested.hash);
          if (existingNestedBL.some(a => a.isBlacklisted)) nestedRecord.isBlacklisted = true;

          await dbPut('attachments', nestedRecord);
          await queueAttachmentTextExtraction(nestedId, nested.rawData, nested.contentType, nested.filename);
          newAttCount++;
        }
      }
    }

    // Update email's attachment count if new attachments were found
    if (newAttCount > 0) {
      const allAtts = await dbGetByIndex('attachments', 'emailId', emailId);
      // email comes from emailIdIndex — same object as in allEmails/selectedEmail
      email.hasAttachments = allAtts.length > 0;
      email.attachmentCount = allAtts.length;
      await dbPut('emails', email);

      // Refresh detail panel if email is still open
      if (selectedEmail?.id === emailId) openDetail(email);
    }

    const attMsg = newAttCount > 0 ? `, ${newAttCount} attachment${newAttCount > 1 ? 's' : ''} recorded` : '';
    toast(`Body loaded from ${sanitizedDomain}/${targetFilename}${attMsg} — pick truncation or Save Full`, 'ok');
  } catch (err) {
    toast('Reimport failed: ' + err.message, 'err');
  }
}

async function openOriginalEml(emailId) {
  const email = emailIdIndex.get(emailId);
  if (!email) return;
  try {
    const resolved = await _resolveEmlFile(email);
    if (!resolved) return;
    const { file, targetFilename } = resolved;
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = targetFilename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (err) {
    toast('Could not open EML: ' + err.message, 'err');
  }
}

// Attachments are not extracted to disk — the archived .eml is the attachment
// store. "Opening" an attachment downloads the email's .eml so the user can
// open it in their mail client and view the attachment there.
async function downloadEmlForAttachment(emailId) {
  await openOriginalEml(emailId);
  toast('Open the downloaded .eml in your email client to view the attachment', 'ok');
}
