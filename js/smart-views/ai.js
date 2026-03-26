// ═══════════════════════════════════════════════════════
//  SMART VIEWS — Claude AI integration
//  API key management, prompt configuration, and
//  AI-powered email tagging via the Anthropic API.
// ═══════════════════════════════════════════════════════

// ── AI prompt settings ─────────────────────────────────

async function loadAiPrompts() {
  const saved = await dbGet('settings', 'aiPrompts');
  if (saved) {
    aiSystemPrompt = saved.systemPrompt ?? AI_SYSTEM_PROMPT_DEFAULT;
    aiUserTemplate = saved.userTemplate ?? AI_USER_TEMPLATE_DEFAULT;
    aiBodyLimit    = saved.bodyLimit    ?? AI_BODY_LIMIT_DEFAULT;
    aiThreadPrompt = saved.threadPrompt ?? AI_THREAD_SYSTEM_PROMPT;
  }
}

async function saveAiPrompts() {
  await dbPut('settings', {
    key: 'aiPrompts',
    systemPrompt: aiSystemPrompt,
    userTemplate: aiUserTemplate,
    bodyLimit:    aiBodyLimit,
    threadPrompt: aiThreadPrompt,
  });
}

// --- Claude API key helpers ---

async function getClaudeApiKey() {
  const rec = await dbGet('settings', 'claudeApiKey');
  return rec?.value || null;
}

async function saveClaudeApiKey() {
  const input = document.getElementById('setting-claude-key');
  const val = (input?.value || '').trim();
  if (!val) { toast('Enter an API key first', 'warn'); return; }
  await dbPut('settings', { key: 'claudeApiKey', value: val });
  if (input) input.value = '';
  await _loadClaudeKeyStatus();
  toast('Claude API key saved', 'ok');
}

async function clearClaudeApiKey() {
  await dbPut('settings', { key: 'claudeApiKey', value: '' });
  await _loadClaudeKeyStatus();
  toast('Claude API key cleared', 'ok');
}

async function saveAiPromptsFromUI() {
  const sys    = document.getElementById('ai-system-prompt')?.value ?? '';
  const tmpl   = document.getElementById('ai-user-template')?.value ?? '';
  const thread = document.getElementById('ai-thread-prompt')?.value ?? '';
  const lim    = parseInt(document.getElementById('ai-body-limit')?.value, 10);
  if (!sys.trim())    { toast('System prompt cannot be empty', 'warn'); return; }
  if (!tmpl.trim())   { toast('User template cannot be empty', 'warn'); return; }
  if (!thread.trim()) { toast('Thread prompt cannot be empty', 'warn'); return; }
  aiSystemPrompt = sys;
  aiUserTemplate = tmpl;
  aiThreadPrompt = thread;
  aiBodyLimit    = Number.isFinite(lim) && lim > 0 ? lim : AI_BODY_LIMIT_DEFAULT;
  await saveAiPrompts();
  toast('AI prompt settings saved', 'ok');
}

function resetAiSystemPrompt() {
  const el = document.getElementById('ai-system-prompt');
  if (el) el.value = AI_SYSTEM_PROMPT_DEFAULT;
}

function resetAiUserTemplate() {
  const el = document.getElementById('ai-user-template');
  if (el) el.value = AI_USER_TEMPLATE_DEFAULT;
}

function resetAiThreadPrompt() {
  const el = document.getElementById('ai-thread-prompt');
  if (el) el.value = AI_THREAD_SYSTEM_PROMPT;
}

async function _loadClaudeKeyStatus() {
  const el = document.getElementById('claude-key-status');
  if (!el) return;
  const key = await getClaudeApiKey();
  el.textContent = key ? '✓ API key is set (stored locally only)' : 'No key saved';
  el.style.color = key ? 'var(--ok, #2a9d5c)' : 'var(--muted)';
}

// --- AI analysis functions ---

async function buildEmailPrompt(email) {
  const allAddrs = [
    email.fromAddr,
    ...(email.toAddrs || []),
    ...(email.ccAddrs || []),
  ].filter(Boolean);
  const contactCtx = await getContactContextForAddresses(allAddrs);

  const vars = {
    subject:  email.subject || '(none)',
    from:     email.fromName ? `${email.fromName} <${email.fromAddr}>` : (email.fromAddr || ''),
    to:       (email.toAddrs || []).join(', '),
    cc:       email.ccAddrs?.length ? `CC: ${email.ccAddrs.join(', ')}` : '',
    body:     (email.textBody || '(no body)').slice(0, aiBodyLimit),
    contacts: contactCtx,
  };
  return aiUserTemplate.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');
}

async function _callClaude(systemPrompt, userContent, schema, maxTokens = 500) {
  const apiKey = await getClaudeApiKey();
  if (!apiKey) { toast('Add Claude API key in Settings first', 'err'); return null; }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: maxTokens,
      output_config: {
        format: {
          type: 'json_schema',
          schema,
        },
      },
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    toast(`AI error ${res.status}: ${errText.slice(0, 100)}`, 'err');
    return null;
  }
  const data = await res.json();
  return JSON.parse(data.content[0].text);
}

async function aiAnalyzeEmail(emailId) {
  const email = allEmails.find(e => e.id === emailId);
  if (!email) return;
  const apiKey = await getClaudeApiKey();
  if (!apiKey) { toast('Add Claude API key in Settings first', 'err'); return; }

  toast('Running AI analysis…', 'ok');
  try {
    const parsed = await _callClaude(
      aiSystemPrompt,
      await buildEmailPrompt(email),
      {
        type: 'object',
        properties: {
          tags:        { type: 'array', items: { type: 'string' } },
          intent:      { type: 'string', enum: ['actionable', 'statement', 'answer', 'actioned', 'fyi'] },
          summary:     { type: 'string' },
          actionItems: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id:          { type: 'string' },
                description: { type: 'string' },
              },
              required: ['id', 'description'],
              additionalProperties: false,
            },
          },
        },
        required: ['tags', 'intent', 'summary', 'actionItems'],
        additionalProperties: false,
      },
      500,
    );
    if (!parsed) return;

    const tags = parsed.tags || [];
    if (!email.tags) email.tags = [];
    for (const tag of tags) {
      const clean = tag.trim().toLowerCase();
      if (clean && !(email.tagExclusions || []).includes(clean) && !email.tags.includes(clean)) {
        email.tags.push(clean);
      }
    }

    email.aiIntent  = parsed.intent  || null;
    email.aiSummary = parsed.summary || null;

    // Merge incoming action items with any existing ones (preserve resolved/deferred statuses)
    const existing = email.actionItems || [];
    const existingMap = new Map(existing.map(a => [a.id, a]));
    email.actionItems = (parsed.actionItems || []).map(a => ({
      id:          a.id,
      description: a.description,
      status:      existingMap.get(a.id)?.status || 'open',
    }));

    // Mark actionable if AI found action items (never unset a manual flag)
    if (email.actionItems.length > 0) email.isActionable = true;

    await dbPut('emails', email);
    if (selectedEmail?.id === emailId) openDetail(email);
    renderEmailList();
    toast(`AI: ${email.aiIntent}${tags.length ? ' · ' + tags.join(', ') : ''}`, 'ok');
  } catch (e) {
    toast(`AI error: ${e.message}`, 'err');
  }
}

// Legacy alias so any external callers still work
const aiTagEmail = aiAnalyzeEmail;

async function aiAnalyzeThread(emailId) {
  const email = emailIdIndex.get(emailId) || allEmails.find(e => e.id === emailId);
  if (!email) return;
  const apiKey = await getClaudeApiKey();
  if (!apiKey) { toast('Add Claude API key in Settings first', 'err'); return; }

  const root = getThreadRoot(email);
  const threadEmails = getThreadEmails(root);
  if (threadEmails.length < 2) { toast('Thread needs at least 2 emails', 'warn'); return; }

  // Step 1: analyze any emails in the thread that haven't been analyzed yet
  const unanalyzed = threadEmails.filter(e => !e.aiIntent);
  if (unanalyzed.length > 0) {
    toast(`Analyzing ${unanalyzed.length} unanalyzed email${unanalyzed.length !== 1 ? 's' : ''} first…`, 'ok');
    for (const e of unanalyzed) {
      await aiAnalyzeEmail(e.id);
    }
  }

  // Check there's at least one actionable email in the thread
  const hasActionable = threadEmails.some(e => (e.actionItems || []).length > 0);
  if (!hasActionable) {
    toast('No action items found in this thread', 'warn');
    return;
  }

  // Step 2: build condensed thread JSON (no body text)
  const threadData = threadEmails.map(e => ({
    emailId:     e.id,
    from:        e.fromName ? `${e.fromName} <${e.fromAddr}>` : (e.fromAddr || ''),
    date:        e.date || '',
    intent:      e.aiIntent || 'unknown',
    summary:     e.aiSummary || '(not analyzed)',
    actionItems: (e.actionItems || []).map(a => ({ id: a.id, description: a.description, status: a.status })),
  }));

  toast('Analyzing thread action items…', 'ok');
  try {
    const parsed = await _callClaude(
      aiThreadPrompt,
      JSON.stringify(threadData, null, 2),
      {
        type: 'object',
        properties: {
          updates: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                emailId:      { type: 'string' },
                actionItemId: { type: 'string' },
                status:       { type: 'string', enum: ['open', 'resolved', 'deferred'] },
              },
              required: ['emailId', 'actionItemId', 'status'],
              additionalProperties: false,
            },
          },
        },
        required: ['updates'],
        additionalProperties: false,
      },
      600,
    );
    if (!parsed) return;

    let updatedCount = 0;
    for (const upd of (parsed.updates || [])) {
      const target = emailIdIndex.get(upd.emailId) || allEmails.find(e => e.id === upd.emailId);
      if (!target || !target.actionItems) continue;
      const item = target.actionItems.find(a => a.id === upd.actionItemId);
      if (!item) continue;
      item.status = upd.status;
      await dbPut('emails', target);
      updatedCount++;
    }

    // Re-open current detail if it's in this thread
    if (selectedEmail && threadEmails.some(e => e.id === selectedEmail.id)) {
      openDetail(selectedEmail);
    }
    renderEmailList();
    toast(`Thread analysis complete: ${updatedCount} action item${updatedCount !== 1 ? 's' : ''} updated`, 'ok');
  } catch (e) {
    toast(`AI error: ${e.message}`, 'err');
  }
}

async function bulkAiTagView() {
  const apiKey = await getClaudeApiKey();
  if (!apiKey) { toast('Add Claude API key in Settings first', 'err'); return; }
  const targets = [...filteredEmails];
  if (!targets.length) { toast('No emails in current view', 'warn'); return; }
  if (!confirm(`Run AI analysis on ${targets.length} email${targets.length !== 1 ? 's' : ''}?\n\nThis will use Claude API credits (claude-haiku-4-5).`)) return;

  let done = 0, errors = 0;
  for (const email of targets) {
    try {
      await aiAnalyzeEmail(email.id);
      done++;
      if (done % 5 === 0) toast(`AI analysis: ${done}/${targets.length}…`, 'ok');
    } catch { errors++; }
  }
  applyFilters();
  toast(`AI analysis complete: ${done} analyzed${errors ? ', ' + errors + ' errors' : ''}`, 'ok');
}
