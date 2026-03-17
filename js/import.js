// ═══════════════════════════════════════════════════════
//  IMPORT PIPELINE
// ═══════════════════════════════════════════════════════

let importedEmails = 0;
let attachmentDirHandle = null; // File System Directory Handle
let emlArchiveDirHandle = null; // For organizing imported EML files
let extractNestedAttachments = true; // Setting: extract attachments from embedded .eml files
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

async function setupAttachmentStorage() {
  if (!('showDirectoryPicker' in window)) {
    alert('File System Access API not supported in this browser.\n\nAttachments will be imported as metadata only.');
    return false;
  }

  try {
    attachmentDirHandle = await window.showDirectoryPicker({
      mode: 'readwrite',
      startIn: 'documents',
    });
    
    // Check permission
    const permission = await attachmentDirHandle.queryPermission({ mode: 'readwrite' });
    if (permission !== 'granted') {
      const granted = await attachmentDirHandle.requestPermission({ mode: 'readwrite' });
      if (granted !== 'granted') {
        alert('Storage permission denied.\n\nAttachments will be imported as metadata only.');
        attachmentDirHandle = null;
        return false;
      }
    }
    
    toast('Attachment folder: ' + attachmentDirHandle.name, 'ok');
    return true;
  } catch (err) {
    if (err.name === 'AbortError') {
      // User cancelled - silent failure
      console.log('Folder selection cancelled by user');
      return false;
    } else {
      console.error('Attachment folder setup failed:', err);
      alert('Failed to select attachment folder:\n' + err.message + '\n\nAttachments will be imported as metadata only.');
      return false;
    }
  }
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
        return false;
      }
    }
    
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
  const fileArr = Array.from(files);

  // Check browser support
  const hasFileSystemAPI = 'showDirectoryPicker' in window;

  // If we don't have a storage folder yet and API is supported, ask upfront
  if (!attachmentDirHandle && hasFileSystemAPI) {
    const setupNow = confirm(
      'Set up attachment storage folder?\n\n' +
      'Attachments will be saved to a folder you choose.\n' +
      'Click OK to select folder now, or Cancel to skip.\n\n' +
      '(This folder will be remembered for this session.)'
    );
    
    if (setupNow) {
      await setupAttachmentStorage();
    }
  }
  
  // Ask about EML file organization
  if (!emlArchiveDirHandle && hasFileSystemAPI && organizeEmlFiles) {
    const setupEml = confirm(
      'Organize imported EML files by sender domain?\n\n' +
      'Files will be copied to domain-based folders.\n' +
      'Click OK to select archive folder, or Cancel to skip.'
    );
    
    if (setupEml) {
      const success = await setupEmlArchiveFolder();
      if (!success) {
        const continueAnyway = confirm(
          'EML archive folder not set up.\n\n' +
          'Continue import without organizing EML files?'
        );
        if (!continueAnyway) return;
      }
    }
  }

  // Process files through the import pipeline
  await processFilesForImport(fileArr);
}

async function handleFolderImport() {
  if (!('showDirectoryPicker' in window)) {
    alert('Folder import requires File System Access API which is not supported in this browser.\n\nPlease use Chrome or Edge.');
    return;
  }
  
  // Setup attachment storage FIRST (while we still have user gesture)
  if (!attachmentDirHandle) {
    const setupNow = confirm(
      'Set up attachment storage folder?\n\n' +
      'Attachments will be saved to a folder you choose.\n' +
      'Click OK to select folder now, or Cancel to skip.\n\n' +
      '(This folder will be remembered for this session.)'
    );
    
    if (setupNow) {
      await setupAttachmentStorage();
    }
  }
  
  // Setup EML archive SECOND (while we still have user gesture)
  if (!emlArchiveDirHandle && organizeEmlFiles) {
    const setupEml = confirm(
      'Organize imported EML files by sender domain?\n\n' +
      'Files will be copied to domain-based folders.\n' +
      'Click OK to select archive folder, or Cancel to skip.'
    );
    
    if (setupEml) {
      const success = await setupEmlArchiveFolder();
      if (!success) {
        const continueAnyway = confirm(
          'EML archive folder not set up.\n\n' +
          'Continue import without organizing EML files?'
        );
        if (!continueAnyway) return;
      }
    }
  }
  
  // NOW select the folder to scan (after all folder prompts are done)
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

async function processFilesForImport(fileArr) {

  // Start progress immediately - no pre-checking
  showPanel('progress');
  const log   = document.getElementById('progress-log');
  const fill  = document.getElementById('progress-fill');
  const label = document.getElementById('progress-label');
  const pct   = document.getElementById('progress-pct');
  log.innerHTML = '';

  const appendLog = (msg, cls = '') => {
    const d = document.createElement('div');
    d.className = 'log-line ' + cls;
    d.textContent = msg;
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
  };

  appendLog(`Starting import of ${fileArr.length} file(s)…`);
  if (attachmentDirHandle) {
    appendLog(`Attachment storage: ${attachmentDirHandle.name}`, 'ok');
  } else {
    appendLog(`Attachment storage: not configured (metadata only)`, 'warn');
  }

  let ok = 0, errs = 0, updated = 0;

  for (let i = 0; i < fileArr.length; i++) {
    const file = fileArr[i];
    const prog = Math.round((i / fileArr.length) * 100);
    fill.style.width  = prog + '%';
    label.textContent = `${i} / ${fileArr.length}`;
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

      // isActionable defaults to false; user can mark manually
      const isActionable = false;

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
        textBody:     parsed.textBody,
        isActionable,
        isSystemEmail,
        status:       'unread',
        tags:         [],
        linkedIssues: [], // For issue tracking
        emailType:    null, // query | decision | risk | action
        hasAttachments: parsed.attachments.length > 0,
        attachmentCount: parsed.attachments.length,
        awaitingSince: null,
        importedAt:   new Date().toISOString(),
        fileName:     file.name,
        aiSummary:    null,
      };

      // Apply auto-tag rules to newly imported email
      const autoTags = getAutoTagsForEmail(emailRecord);
      if (autoTags.length) emailRecord.tags = autoTags;

      await dbPut('emails', emailRecord);

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
          transmittalRef: '',
          sourceParty: '',
          documentType: '',
          storedPath: '',
          isNested: false,
          parentFilename: null,
          importedAt: new Date().toISOString(),
        };

        // Inherit blacklist status from any existing attachment with the same hash
        const existingForBlacklist = await dbGetByIndex('attachments', 'hash', att.hash);
        if (existingForBlacklist.some(a => a.isBlacklisted)) {
          attRecord.isBlacklisted = true;
        }

        // Save attachment to disk if storage is available
        if (attachmentDirHandle && att.rawData) {
          try {
            const savedPath = await saveAttachmentToDisk(att, emailRecord.fromAddr);
            if (savedPath) {
              attRecord.storedPath = savedPath;
            }
          } catch (err) {
            appendLog(`  ⚠ Failed to save ${att.filename}: ${err.message}`, 'warn');
          }
        }

        await dbPut('attachments', attRecord);

        // Extract text in the background (non-blocking)
        if (att.rawData && isExtractableType(att.contentType, att.filename)) {
          _extractAndStoreText(attId, att.rawData, att.contentType, att.filename).catch(() => {});
        }

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
              transmittalRef: '',
              sourceParty: '',
              documentType: '',
              storedPath: '',
              isNested: true,
              parentFilename: att.filename,
              importedAt: new Date().toISOString(),
            };
            
            // Inherit blacklist status from any existing attachment with the same hash
            const existingNested = await dbGetByIndex('attachments', 'hash', nested.hash);
            if (existingNested.some(a => a.isBlacklisted)) {
              nestedRecord.isBlacklisted = true;
            }

            // Save nested attachment to disk
            if (attachmentDirHandle && nested.rawData) {
              try {
                const savedPath = await saveAttachmentToDisk(nested, emailRecord.fromAddr);
                if (savedPath) {
                  nestedRecord.storedPath = savedPath;
                }
              } catch (err) {
                appendLog(`  ⚠ Failed to save nested ${nested.filename}: ${err.message}`, 'warn');
              }
            }

            await dbPut('attachments', nestedRecord);

            // Extract text in the background (non-blocking)
            if (nested.rawData && isExtractableType(nested.contentType, nested.filename)) {
              _extractAndStoreText(nestedId, nested.rawData, nested.contentType, nested.filename).catch(() => {});
            }
          }
        }
      }

      ok++;
      const totalAttachments = parsed.attachments.reduce((sum, att) => 
        sum + 1 + (att.nestedAttachments?.length || 0), 0);
      const attInfo = totalAttachments > 0
        ? ` [${totalAttachments} attach${attachmentDirHandle ? ' → saved' : ''}]` 
        : '';
      appendLog(`✓ ${file.name}${attInfo}`, 'ok');

    } catch (err) {
      appendLog(`✕ ${file.name}: ${err.message}`, 'err');
      errs++;
    }

    // Yield to UI every 5 emails
    if (i % 5 === 0) await new Promise(r => setTimeout(r, 0));
  }

  pct.textContent   = '100%';
  const skipped = fileArr.length - ok - errs - updated;
  appendLog(`Done — ${ok} imported${updated > 0 ? `, ${updated} recipients updated` : ''}${skipped > 0 ? `, ${skipped} skipped (duplicates)` : ''}, ${errs} errors.`, ok > 0 || updated > 0 ? 'ok' : 'err');

  importedEmails += ok;

  await new Promise(r => setTimeout(r, 800));
  await loadEmailList();
  await updateHeaderStats();
  showPanel('list');
  toast(`Imported ${ok} email(s)`, 'ok');
}

// ═══════════════════════════════════════════════════════
//  ATTACHMENT FILE STORAGE
// ═══════════════════════════════════════════════════════

async function saveAttachmentToDisk(attachment, senderEmail) {
  if (!attachmentDirHandle || !attachment.rawData) return null;

  // Organize by sender domain: attachments/rcy.com.sg/filename.pdf
  const domain = senderEmail.split('@')[1] || 'unknown';
  // Sanitize domain and remove leading/trailing underscores
  const sanitizedDomain = domain.replace(/[^a-zA-Z0-9.-]/g, '_').replace(/^_+|_+$/g, '');
  
  try {
    // Check if this attachment already exists by hash (deduplication)
    const existingByHash = await findAttachmentByHash(attachment.hash);
    if (existingByHash && existingByHash.storedPath) {
      console.log('Attachment already exists (duplicate):', attachment.filename, '→ reusing', existingByHash.storedPath);
      return existingByHash.storedPath; // Return existing path, don't save again
    }
    
    // Get or create domain subfolder
    const domainFolder = await attachmentDirHandle.getDirectoryHandle(sanitizedDomain, { create: true });
    
    // Sanitize filename
    let filename = attachment.filename.replace(/[<>:"/\\|?*]/g, '_');
    
    // Check if file exists by name - if so, add counter
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
    
    // Create and write file
    fileHandle = await domainFolder.getFileHandle(finalFilename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(attachment.rawData);
    await writable.close();
    
    const fullPath = `${sanitizedDomain}/${finalFilename}`;
    console.log('Saved attachment:', attachment.filename, '→', fullPath);
    return fullPath;
  } catch (err) {
    console.error('Failed to save attachment:', attachment.filename, err);
    throw err;
  }
}

async function findAttachmentByHash(hash) {
  // Use the hash index instead of a full table scan
  try {
    const atts = await dbGetByIndex('attachments', 'hash', hash);
    return atts.find(a => a.storedPath) || null;
  } catch (err) {
    console.error('Error checking for duplicate attachment:', err);
    return null;
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
  const email = allEmails.find(e => e.id === emailId);
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
    email.textBody = bodyForTrunc;
    const idx = allEmails.findIndex(e => e.id === emailId);
    if (idx >= 0) allEmails[idx].textBody = bodyForTrunc;

    // Load into truncation UI if this email is still open
    if (selectedEmail?.id === emailId) {
      const bodyEl = document.getElementById('det-body-text');
      if (bodyEl) bodyEl.textContent = bodyForTrunc || '(no plain text body)';

      // Show Save Full button so user can bypass truncation if they want the whole body
      const saveFullBtn = document.getElementById('trunc-save-full-btn');
      if (saveFullBtn) saveFullBtn.style.display = '';

      // Auto-scan for truncation points and populate the controls
      // (truncFindMatches reads selectedEmail.textBody, which we just updated above)
      truncFindMatches();
    }

    // Re-process attachments — add any that are missing from the DB.
    // Existing attachment records are left untouched to preserve metadata
    // (transmittalRef, sourceParty, blacklist status, etc.).
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
          transmittalRef: '',
          sourceParty: '',
          documentType: '',
          storedPath: '',
          isNested: false,
          parentFilename: null,
          importedAt: new Date().toISOString(),
        };

        // Inherit blacklist status from any existing attachment with the same hash
        const existingForBlacklist = await dbGetByIndex('attachments', 'hash', att.hash);
        if (existingForBlacklist.some(a => a.isBlacklisted)) {
          attRecord.isBlacklisted = true;
        }

        if (attachmentDirHandle && att.rawData) {
          try {
            const savedPath = await saveAttachmentToDisk(att, email.fromAddr);
            if (savedPath) attRecord.storedPath = savedPath;
          } catch (e) { /* non-fatal */ }
        }

        await dbPut('attachments', attRecord);
        if (att.rawData && isExtractableType(att.contentType, att.filename)) {
          _extractAndStoreText(attId, att.rawData, att.contentType, att.filename).catch(() => {});
        }
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
            transmittalRef: '',
            sourceParty: '',
            documentType: '',
            storedPath: '',
            isNested: true,
            parentFilename: att.filename,
            importedAt: new Date().toISOString(),
          };

          const existingNestedBL = await dbGetByIndex('attachments', 'hash', nested.hash);
          if (existingNestedBL.some(a => a.isBlacklisted)) {
            nestedRecord.isBlacklisted = true;
          }

          if (attachmentDirHandle && nested.rawData) {
            try {
              const savedPath = await saveAttachmentToDisk(nested, email.fromAddr);
              if (savedPath) nestedRecord.storedPath = savedPath;
            } catch (e) { /* non-fatal */ }
          }

          await dbPut('attachments', nestedRecord);
          if (nested.rawData && isExtractableType(nested.contentType, nested.filename)) {
            _extractAndStoreText(nestedId, nested.rawData, nested.contentType, nested.filename).catch(() => {});
          }
          newAttCount++;
        }
      }
    }

    // Update email's attachment count if new attachments were found
    if (newAttCount > 0) {
      const allAtts = await dbGetByIndex('attachments', 'emailId', emailId);
      email.hasAttachments = allAtts.length > 0;
      email.attachmentCount = allAtts.length;
      if (idx >= 0) {
        allEmails[idx].hasAttachments = email.hasAttachments;
        allEmails[idx].attachmentCount = email.attachmentCount;
      }
      await dbPut('emails', email);

      // Refresh detail panel if email is still open
      if (selectedEmail?.id === emailId) {
        selectedEmail.hasAttachments = email.hasAttachments;
        selectedEmail.attachmentCount = email.attachmentCount;
        openDetail(email);
      }
    }

    const attMsg = newAttCount > 0 ? `, ${newAttCount} new attachment${newAttCount > 1 ? 's' : ''} added` : '';
    toast(`Body loaded from ${sanitizedDomain}/${targetFilename}${attMsg} — pick truncation or Save Full`, 'ok');
  } catch (err) {
    toast('Reimport failed: ' + err.message, 'err');
  }
}

async function openOriginalEml(emailId) {
  const email = allEmails.find(e => e.id === emailId);
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

async function openAttachmentFromDisk(storedPath) {
  if (!storedPath) {
    toast('No file path stored for this attachment', 'err');
    return;
  }

  // If we don't have the folder handle, ask user to restore it
  if (!attachmentDirHandle) {
    const restore = confirm(
      'Attachment folder not connected.\n\n' +
      'Click OK to select the attachment folder where files are stored.'
    );
    
    if (restore) {
      const success = await setupAttachmentStorage();
      if (!success) {
        toast('Cannot open attachment without folder access', 'err');
        return;
      }
    } else {
      return;
    }
  }

  try {
    const parts = storedPath.split('/');
    const domainFolder = await attachmentDirHandle.getDirectoryHandle(parts[0]);
    const fileHandle = await domainFolder.getFileHandle(parts[1]);
    const file = await fileHandle.getFile();
    
    // Open file in new tab or download
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = parts[1];
    a.click();
    URL.revokeObjectURL(url);
    
    toast('Attachment opened', 'ok');
  } catch (err) {
    console.error('Failed to open attachment:', err);
    
    if (err.name === 'NotFoundError') {
      toast('File not found - it may have been moved or deleted', 'err');
    } else {
      toast('Failed to open attachment: ' + err.message, 'err');
    }
  }
}
