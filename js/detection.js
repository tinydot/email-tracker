// ═══════════════════════════════════════════════════════
//  SYSTEM / AUTOMATED EMAIL DETECTION
// ═══════════════════════════════════════════════════════

// Built-in patterns (mutable so custom ones can be merged in at runtime)
let SYSTEM_SENDER_PATTERNS = [
  /^(noreply|no-reply|no\.reply|donotreply|do-not-reply|do\.not\.reply)@/i,
  /^(mailer-daemon|postmaster|bounce|bounces|daemon|notifications?|alerts?|automailer|auto-mailer|automated?)@/i,
];

let SYSTEM_SUBJECT_PATTERNS = [
  /^(auto-?reply|automatic reply|out of office|undeliverable)/i,
  /^delivery (status notification|failure|failed)/i,
  /^(mail delivery (failed|failure)|returned mail|non-delivery report)/i,
  /^\[?(automated|auto-generated|do not reply)\]?:/i,
];

let SYSTEM_BODY_PATTERNS = [
  /this (is an |message (was |is ))?(automated|automatically (generated|sent))/i,
  /do not (reply to|respond to) this (email|message)/i,
  /this email (was sent automatically|is automatically generated)/i,
  /you('re| are) receiving this (email|message|notification) because/i,
  /to (unsubscribe|manage your (notification|email) preferences)/i,
];

// Default pattern sources (kept for reference / reset)
const DEFAULT_SENDER_PATTERNS = [
  /^(noreply|no-reply|no\.reply|donotreply|do-not-reply|do\.not\.reply)@/i,
  /^(mailer-daemon|postmaster|bounce|bounces|daemon|notifications?|alerts?|automailer|auto-mailer|automated?)@/i,
];
const DEFAULT_SUBJECT_PATTERNS = [
  /^(auto-?reply|automatic reply|out of office|undeliverable)/i,
  /^delivery (status notification|failure|failed)/i,
  /^(mail delivery (failed|failure)|returned mail|non-delivery report)/i,
  /^\[?(automated|auto-generated|do not reply)\]?:/i,
];
const DEFAULT_BODY_PATTERNS = [
  /this (is an |message (was |is ))?(automated|automatically (generated|sent))/i,
  /do not (reply to|respond to) this (email|message)/i,
  /this email (was sent automatically|is automatically generated)/i,
  /you('re| are) receiving this (email|message|notification) because/i,
  /to (unsubscribe|manage your (notification|email) preferences)/i,
];

// Custom patterns loaded from DB (stored as plain regex source strings)
let customPatterns = { senders: [], subjects: [], body: [] };

function detectSystemEmail(rawHeaders, fromAddr, subject, body) {
  // 1. Authoritative automation headers
  const autoSubmitted = rawHeaders['auto-submitted'] || '';
  if (autoSubmitted && autoSubmitted.toLowerCase() !== 'no') return true;

  const precedence = (rawHeaders['precedence'] || '').toLowerCase();
  if (precedence === 'bulk' || precedence === 'list' || precedence === 'junk') return true;

  if (rawHeaders['list-id']) return true;
  if (rawHeaders['list-unsubscribe']) return true;
  if (rawHeaders['x-auto-response-suppress']) return true;
  if (rawHeaders['feedback-id']) return true;
  if (rawHeaders['x-campaign-id'] || rawHeaders['x-campaignid']) return true;

  // 2. Sender address patterns
  const addr = (fromAddr || '').toLowerCase();
  if (SYSTEM_SENDER_PATTERNS.some(re => re.test(addr))) return true;

  // 3. Subject patterns
  if (SYSTEM_SUBJECT_PATTERNS.some(re => re.test(subject || ''))) return true;

  // 4. Body snippet patterns (first 1000 chars)
  const bodySnippet = (body || '').substring(0, 1000);
  if (SYSTEM_BODY_PATTERNS.some(re => re.test(bodySnippet))) return true;

  return false;
}
