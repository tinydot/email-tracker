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
  }
}

async function saveAiPrompts() {
  await dbPut('settings', {
    key: 'aiPrompts',
    systemPrompt: aiSystemPrompt,
    userTemplate: aiUserTemplate,
    bodyLimit:    aiBodyLimit,
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
  const sys  = document.getElementById('ai-system-prompt')?.value ?? '';
  const tmpl = document.getElementById('ai-user-template')?.value ?? '';
  const lim  = parseInt(document.getElementById('ai-body-limit')?.value, 10);
  if (!sys.trim())  { toast('System prompt cannot be empty', 'warn'); return; }
  if (!tmpl.trim()) { toast('User template cannot be empty', 'warn'); return; }
  aiSystemPrompt = sys;
  aiUserTemplate = tmpl;
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

async function _loadClaudeKeyStatus() {
  const el = document.getElementById('claude-key-status');
  if (!el) return;
  const key = await getClaudeApiKey();
  el.textContent = key ? '✓ API key is set (stored locally only)' : 'No key saved';
  el.style.color = key ? 'var(--ok, #2a9d5c)' : 'var(--muted)';
}

// --- AI tagging functions ---

function buildEmailPrompt(email) {
  const vars = {
    subject: email.subject || '(none)',
    from:    email.fromName ? `${email.fromName} <${email.fromAddr}>` : (email.fromAddr || ''),
    to:      (email.toAddrs || []).join(', '),
    cc:      email.ccAddrs?.length ? `CC: ${email.ccAddrs.join(', ')}` : '',
    body:    (email.textBody || '(no body)').slice(0, aiBodyLimit),
  };
  return aiUserTemplate.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');
}

async function aiTagEmail(emailId) {
  const email = allEmails.find(e => e.id === emailId);
  if (!email) return;
  const apiKey = await getClaudeApiKey();
  if (!apiKey) { toast('Add Claude API key in Settings first', 'err'); return; }

  toast('Running AI tagging…', 'ok');
  try {
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
        max_tokens: 300,
        output_config: {
          format: {
            type: 'json_schema',
            schema: {
              type: 'object',
              properties: {
                tags:    { type: 'array', items: { type: 'string' } },
                summary: { type: 'string' },
              },
              required: ['tags', 'summary'],
              additionalProperties: false,
            },
          },
        },
        system: aiSystemPrompt,
        messages: [{ role: 'user', content: buildEmailPrompt(email) }],
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      toast(`AI error ${res.status}: ${errText.slice(0, 100)}`, 'err');
      return;
    }
    const data = await res.json();
    const parsed = JSON.parse(data.content[0].text);
    const tags = parsed.tags || [];
    const summary = parsed.summary || null;

    if (!email.tags) email.tags = [];
    for (const tag of tags) {
      const clean = tag.trim().toLowerCase();
      if (clean && !(email.tagExclusions || []).includes(clean) && !email.tags.includes(clean)) {
        email.tags.push(clean);
      }
    }
    email.aiSummary = summary;
    await dbPut('emails', email);

    if (selectedEmail?.id === emailId) openDetail(email);
    renderEmailList();
    toast(`AI tagged: ${tags.join(', ')}`, 'ok');
  } catch (e) {
    toast(`AI error: ${e.message}`, 'err');
  }
}

async function bulkAiTagView() {
  const apiKey = await getClaudeApiKey();
  if (!apiKey) { toast('Add Claude API key in Settings first', 'err'); return; }
  const targets = [...filteredEmails];
  if (!targets.length) { toast('No emails in current view', 'warn'); return; }
  if (!confirm(`Run AI tagging on ${targets.length} email${targets.length !== 1 ? 's' : ''}?\n\nThis will use Claude API credits (claude-haiku-4-5).`)) return;

  let done = 0, errors = 0;
  for (const email of targets) {
    try {
      await aiTagEmail(email.id);
      done++;
      if (done % 5 === 0) toast(`AI tagging: ${done}/${targets.length}…`, 'ok');
    } catch { errors++; }
  }
  applyFilters();
  toast(`AI tagging complete: ${done} tagged${errors ? ', ' + errors + ' errors' : ''}`, 'ok');
}
