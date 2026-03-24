// ═══════════════════════════════════════════════════════
//  EML PARSER
// ═══════════════════════════════════════════════════════

function parseEML(raw) {
  // Split headers from body
  const headerBodySplit = raw.indexOf('\r\n\r\n');
  const headerBodySplit2 = raw.indexOf('\n\n');
  const splitAt = (headerBodySplit !== -1 && (headerBodySplit2 === -1 || headerBodySplit < headerBodySplit2))
    ? headerBodySplit : headerBodySplit2;

  if (splitAt === -1) return null;

  const headerSection = raw.substring(0, splitAt);
  const bodySection   = raw.substring(splitAt + (raw[splitAt + 1] === '\r' ? 4 : 2));

  // Parse headers (handles folded headers)
  const headers = parseHeaders(headerSection);

  // Determine content type and boundary
  const contentType = headers['content-type'] || '';
  const boundary    = extractBoundary(contentType);

  let textBody    = '';
  let htmlBody    = '';
  let attachments = [];

  if (boundary) {
    const parts = splitMIME(bodySection, boundary);
    
    for (const part of parts) {
      const r = parseMIMEPart(part);
      if (!r) continue;
      const ct = (r.headers['content-type'] || '').toLowerCase();
      const cd = r.headers['content-disposition'] || '';

      // Outlook often uses Content-Disposition: inline; filename="..." for real attachments.
      // Treat any part with a filename in Content-Disposition as an attachment,
      // regardless of whether the keyword is 'attachment' or 'inline'.
      // Also treat inline images with a Content-ID (cid: references) as attachments.
      const cdIsAttachment = cd.toLowerCase().includes('attachment') || !!extractParam(cd, 'filename')
        || (!!r.headers['content-id'] && ct.startsWith('image/'));
      if (cdIsAttachment) {
        attachments.push(buildAttachment(r));
      } else if (ct.startsWith('text/plain') && !textBody) {
        textBody = decodePart(r);
      } else if (ct.startsWith('text/html') && !htmlBody) {
        htmlBody = decodePart(r);
      } else if (ct.startsWith('multipart/')) {
        // Nested multipart — recurse (handles multipart/alternative inside multipart/mixed)
        const nb = extractBoundary(r.headers['content-type'] || '');
        if (nb) {
          const subparts = splitMIME(r.body, nb);
          for (const sp of subparts) {
            const sr = parseMIMEPart(sp);
            if (!sr) continue;
            const sct = (sr.headers['content-type'] || '').toLowerCase();
            const scd = sr.headers['content-disposition'] || '';
            const scdIsAttachment = scd.toLowerCase().includes('attachment') || !!extractParam(scd, 'filename')
              || (!!sr.headers['content-id'] && sct.startsWith('image/'));
            if (scdIsAttachment) {
              attachments.push(buildAttachment(sr));
            } else if (sct.startsWith('text/plain') && !textBody) {
              textBody = decodePart(sr);
            } else if (sct.startsWith('text/html') && !htmlBody) {
              htmlBody = decodePart(sr);
            } else if (sct.startsWith('multipart/')) {
              // Double-nested (rare but happens) — recurse again
              const nnb = extractBoundary(sr.headers['content-type'] || '');
              if (nnb) {
                const subsubparts = splitMIME(sr.body, nnb);
                for (const ssp of subsubparts) {
                  const ssr = parseMIMEPart(ssp);
                  if (!ssr) continue;
                  const ssct = (ssr.headers['content-type'] || '').toLowerCase();
                  const sscd = ssr.headers['content-disposition'] || '';
                  const sscdIsAttachment = sscd.toLowerCase().includes('attachment') || !!extractParam(sscd, 'filename')
                    || (!!ssr.headers['content-id'] && ssct.startsWith('image/'));
                  if (sscdIsAttachment) {
                    attachments.push(buildAttachment(ssr));
                  } else if (ssct.startsWith('text/plain') && !textBody) {
                    textBody = decodePart(ssr);
                  } else if (ssct.startsWith('text/html') && !htmlBody) {
                    htmlBody = decodePart(ssr);
                  }
                }
              }
            }
          }
        }
      } else if (!ct.startsWith('image/') || cd.toLowerCase().includes('attachment')) {
        if (!ct.startsWith('text/') && ct !== '') {
          attachments.push(buildAttachment(r));
        }
      }
    }
  } else {
    // Single-part email (no multipart boundary)
    const enc = headers['content-transfer-encoding'] || '';
    const ct = (headers['content-type'] || '').toLowerCase();
    
    const decodedBody = decodeBody(bodySection, enc);
    
    if (ct.includes('text/html')) {
      htmlBody = decodedBody;
    } else {
      textBody = decodedBody;
    }
  }

  // Clean quoted text from body for "first message" view
  let cleanText = textBody ? stripQuotedText(textBody) : '';

  // If stripping removed everything, keep the original
  if (!cleanText && textBody) {
    cleanText = textBody.trim();
  }

  // Strip corporate/boilerplate signature block from the bottom
  if (cleanText) {
    const noSig = stripSignature(cleanText);
    if (noSig) cleanText = noSig;
  }
  
  // If still no text, try HTML
  if (!cleanText && htmlBody) {
    cleanText = stripHtml(htmlBody);
  }

  // Remove excessive blank lines (e.g. \r\n\r\n \r\n\r\n → single newline)
  if (cleanText) cleanText = cleanText.replace(/\r\n/g, '\n').replace(/\n([ \t]*\n)+/g, '\n');

  // Parse addresses
  const from  = parseAddress(headers['from']  || '');
  const to    = parseAddressList(headers['to'] || '');
  const cc    = parseAddressList(headers['cc'] || '');
  const date  = parseDate(headers['date'] || '');

  // Thread fields
  const messageId  = cleanMsgId(headers['message-id'] || '');
  const inReplyTo  = cleanMsgId(headers['in-reply-to'] || '');
  const references = (headers['references'] || '')
    .split(/\s+/)
    .map(cleanMsgId)
    .filter(Boolean);

  return {
    messageId,
    inReplyTo,
    references,
    subject:     decodeEncodedWord(headers['subject'] || '(no subject)'),
    from,
    to,
    cc,
    date,
    textBody:    cleanText,
    rawTextBody: textBody,
    htmlBody:    htmlBody ? '[HTML available]' : '',
    attachments,
    rawHeaders:  headers,
  };
}

function parseHeaders(text) {
  // Unfold folded headers first
  const unfolded = text.replace(/\r\n([ \t])/g, ' ').replace(/\n([ \t])/g, ' ');
  const lines    = unfolded.split(/\r?\n/);
  const headers  = {};
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon < 1) continue;
    const key = line.substring(0, colon).trim().toLowerCase();
    const val = line.substring(colon + 1).trim();
    // Keep first occurrence (most important for Message-ID etc.)
    if (!headers[key]) headers[key] = val;
  }
  return headers;
}

function extractBoundary(ct) {
  const m = ct.match(/boundary=(?:"([^"]+)"|([^\s;]+))/i);
  return m ? (m[1] || m[2]) : null;
}

function splitMIME(body, boundary) {
  const parts   = [];
  const delim   = '--' + boundary;
  const lines   = body.split(/\r?\n/);
  let current   = [];
  let inPart    = false;

  for (const line of lines) {
    if (line.startsWith(delim + '--')) break;
    if (line.startsWith(delim)) {
      if (inPart && current.length) parts.push(current.join('\n'));
      current = [];
      inPart  = true;
      continue;
    }
    if (inPart) current.push(line);
  }
  if (inPart && current.length) parts.push(current.join('\n'));
  return parts;
}

function parseMIMEPart(partText) {
  const split = partText.indexOf('\n\n');
  if (split === -1) return null;
  const hText = partText.substring(0, split);
  const body  = partText.substring(split + 2);
  const headers = parseHeaders(hText);
  return { headers, body };
}

function decodePart(part) {
  const enc = part.headers['content-transfer-encoding'] || '';
  return decodeBody(part.body, enc);
}

function decodeBody(body, encoding) {
  const enc = encoding.trim().toLowerCase();
  if (enc === 'base64') {
    try {
      const cleaned = body.replace(/\s/g, '');
      return atob(cleaned);
    } catch { return body; }
  }
  if (enc === 'quoted-printable') {
    return decodeQP(body);
  }
  return body;
}

function decodeQP(str) {
  // First, handle soft line breaks (= at end of line means line continues)
  str = str.replace(/=\r?\n/g, '');
  
  // Then decode =XX hex sequences
  return str.replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function buildAttachment(part) {
  const cd       = part.headers['content-disposition'] || '';
  const ct       = part.headers['content-type'] || 'application/octet-stream';
  let rawName    = extractParam(cd, 'filename') || extractParam(ct, 'name');
  
  // Special handling for embedded emails (message/rfc822)
  let isEmbeddedEmail = false;
  if (!rawName && ct.toLowerCase().includes('message/rfc822')) {
    isEmbeddedEmail = true;
    // This is an embedded email - try to extract subject as filename
    const subjectMatch = part.body.match(/^Subject:\s*(.+?)$/m);
    if (subjectMatch) {
      rawName = subjectMatch[1].trim() + '.eml';
    } else {
      rawName = 'forwarded-message.eml';
    }
  }
  
  if (!rawName) rawName = 'attachment';
  
  const filename = decodeEncodedWord(rawName);
  const enc      = (part.headers['content-transfer-encoding'] || '').trim().toLowerCase();
  
  // Keep raw data for file saving
  let rawData = null;
  if (enc === 'base64') {
    try {
      const cleaned = part.body.replace(/\s/g, '');
      rawData = base64ToUint8Array(cleaned);
    } catch (e) {
      console.warn('Failed to decode base64 attachment:', filename, e);
    }
  } else if (enc === 'quoted-printable') {
    const decoded = decodeQP(part.body);
    rawData = stringToUint8Array(decoded);
  } else {
    rawData = stringToUint8Array(part.body);
  }
  
  const size = rawData ? rawData.length : part.body.length;
  const hash = rawData ? hashUint8Array(rawData) : simpleHash(part.body.substring(0, 512));
  
  // Preserve Content-ID for inline/embedded images (cid: references in body)
  const contentId = (part.headers['content-id'] || '').replace(/^<|>$/g, '').trim() || null;

  const result = {
    filename,
    contentType: ct.split(';')[0].trim(),
    size,
    hash,
    encoding: enc,
    rawData,
    isEmbeddedEmail,
    contentId,
    nestedAttachments: [] // Will be populated if this is an embedded email
  };
  
  // If this is an embedded email and setting is enabled, parse nested attachments
  if (isEmbeddedEmail && extractNestedAttachments && part.body) {
    try {
      const nestedParsed = parseEML(part.body);
      if (nestedParsed && nestedParsed.attachments.length > 0) {
        result.nestedAttachments = nestedParsed.attachments.map(nested => ({
          ...nested,
          isNested: true,
          parentFilename: filename
        }));
      }
    } catch (e) {
      console.warn('Failed to parse nested attachments from', filename, e);
    }
  }
  
  return result;
}

function base64ToUint8Array(base64) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

function stringToUint8Array(str) {
  const encoder = new TextEncoder();
  return encoder.encode(str);
}

function hashUint8Array(uint8Array) {
  // Simple FNV-1a hash for Uint8Array
  let h = 0x811c9dc5;
  for (let i = 0; i < uint8Array.length; i++) {
    h ^= uint8Array[i];
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function extractParam(header, param) {
  const re = new RegExp(param + '=(?:"([^"]+)"|([^\\s;]+))', 'i');
  const m  = header.match(re);
  return m ? (m[1] || m[2]) : null;
}

function decodeEncodedWord(str) {
  // RFC 2047 =?charset?encoding?text?=
  return str.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, charset, enc, text) => {
    try {
      if (enc.toUpperCase() === 'B') {
        const bytes = atob(text);
        return new TextDecoder(charset).decode(
          Uint8Array.from(bytes, c => c.charCodeAt(0))
        );
      } else {
        const qp = text.replace(/_/g, ' ');
        return decodeQP(qp);
      }
    } catch { return text; }
  });
}

function parseAddress(str) {
  const decoded = decodeEncodedWord(str.trim());
  const m = decoded.match(/^(.+?)\s*<([^>]+)>$/);
  if (m) return { name: m[1].replace(/^"|"$/g, '').trim(), email: m[2].trim() };
  if (decoded.includes('@')) return { name: '', email: decoded };
  return { name: decoded, email: '' };
}

function parseAddressList(str) {
  if (!str) return [];
  // Statefully split on commas or semicolons not inside angle brackets or double-quoted strings.
  // Outlook (and PST-exported EMLs) frequently uses semicolons as the address delimiter.
  const parts = [];
  let current = '';
  let inAngle = false;
  let inQuote = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '"' && !inAngle) inQuote = !inQuote;
    else if (ch === '<' && !inQuote) inAngle = true;
    else if (ch === '>' && !inQuote) inAngle = false;
    if ((ch === ',' || ch === ';') && !inAngle && !inQuote) {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts.map(p => parseAddress(p.trim())).filter(a => a.email || a.name);
}

function parseDate(str) {
  if (!str) return null;
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function cleanMsgId(str) {
  const m = str.match(/<([^>]+)>/);
  return m ? m[1] : str.trim();
}

// Custom quote/thread-marker patterns loaded from settings (compiled RegExp[])
let customQuotePatterns = [];

// ── Signature stripping ──────────────────────────────────────────────────────

// Default patterns that anchor the start of a corporate email signature block.
// Each pattern is tested against trimmed individual lines.
const DEFAULT_SIGNATURE_PATTERNS = [
  /^--\s*$/,                                                      // standard sig separator
  /^CONFIDENTIALITY\s*(NOTE|NOTICE)?[:\s-]/i,                     // "CONFIDENTIALITY NOTE –"
  /^DISCLAIMER[:\s-]/i,                                           // "DISCLAIMER –"
  /^This\s+(e-?mail|message|communication)\s+(and\s+any\s+attach\S*\s+)?(is|are)\s+confidential/i,
  /^If\s+you\s+(have\s+)?(received|are\s+not\s+the\s+intended)/i,
  /^Please\s+consider\s+the\s+environment\s+before\s+printing/i,
  /^Sent\s+from\s+my\s+(iPhone|iPad|Android|Samsung|BlackBerry|Galaxy)/i,
];

// Custom signature patterns loaded from settings (compiled RegExp[])
let customSignaturePatterns = [];

// Strip corporate/boilerplate signature from the bottom of an email body.
// Finds the first line matching a signature anchor and removes it plus everything after.
function stripSignature(text) {
  if (!text) return text;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    const isAnchor =
      DEFAULT_SIGNATURE_PATTERNS.some(re => re.test(trimmed)) ||
      customSignaturePatterns.some(re => re.test(trimmed));
    if (isAnchor) {
      return lines.slice(0, i).join('\n').trim();
    }
  }
  return text;
}

// Returns all line indices where a truncation pattern matches (not just the first).
// Each entry: { lineIndex, snippet } where snippet is the trimmed matching line.
function findTruncationMatches(text) {
  const lines = text.split('\n');
  const matches = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    const isMatch =
      /^On .+ wrote:$/i.test(trimmed) ||
      /^-{3,}\s*Original Message\s*-{3,}/i.test(trimmed) ||
      /^_{3,}\s*Original Message\s*_{3,}/i.test(trimmed) ||
      /^From:.*Sent:.*To:/s.test(text.substring(text.indexOf(line))) ||
      (/^From:/i.test(trimmed) && lines[i+1] && /^Sent:/i.test(lines[i+1].trim())) ||
      /^={3,}$/i.test(trimmed) ||
      /^-{5,}$/i.test(trimmed) ||
      /^Begin forwarded message:/i.test(trimmed) ||
      /^-{3,}\s*Forwarded message\s*-{3,}/i.test(trimmed) ||
      /^发件人:|^寄件者:/i.test(trimmed) ||
      (/^When:/i.test(trimmed) && /^Where:/i.test(lines[i+1]?.trim() || '')) ||
      customQuotePatterns.some(re => re.test(trimmed));

    if (isMatch) {
      matches.push({ lineIndex: i, snippet: trimmed.slice(0, 80) });
    }
  }

  return matches;
}

// Truncate text at a specific line index (returned by findTruncationMatches).
function truncateAtLine(text, lineIndex) {
  return text.split('\n').slice(0, lineIndex).join('\n').trim();
}

function stripQuotedText(text) {
  // Remove lines starting with > (quoted), and common quote headers
  const lines = text.split('\n');
  const cleaned = [];
  let foundThreadMarker = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Thread marker patterns (stop processing when we hit these)
    if (
      // Gmail/standard style
      /^On .+ wrote:$/i.test(trimmed) ||

      // Outlook style - various formats
      /^-{3,}\s*Original Message\s*-{3,}/i.test(trimmed) ||
      /^_{3,}\s*Original Message\s*_{3,}/i.test(trimmed) ||
      /^From:.*Sent:.*To:/s.test(text.substring(text.indexOf(line))) ||

      // "From: X, Sent: Y" block
      (/^From:/i.test(trimmed) && lines[i+1] && /^Sent:/i.test(lines[i+1].trim())) ||

      // Reply separator lines
      /^={3,}$/i.test(trimmed) ||
      /^-{5,}$/i.test(trimmed) ||

      // Common forwarded email markers
      /^Begin forwarded message:/i.test(trimmed) ||
      /^-{3,}\s*Forwarded message\s*-{3,}/i.test(trimmed) ||

      // Additional Asian format patterns (common in SG/regional offices)
      /^发件人:|^寄件者:/i.test(trimmed) ||

      // Outlook meeting/appointment footers
      /^When:/i.test(trimmed) && /^Where:/i.test(lines[i+1]?.trim() || '') ||

      // User-defined custom quote patterns
      customQuotePatterns.some(re => re.test(trimmed))
    ) {
      foundThreadMarker = true;
      break;
    }

    // Skip lines starting with > (inline quotes)
    if (trimmed.startsWith('>')) {
      continue;
    }

    // If we haven't hit a thread marker yet, keep the line
    if (!foundThreadMarker) {
      cleaned.push(line);
    }
  }

  return cleaned.join('\n').trim();
}

function stripHtml(html) {
  if (!html) return '';
  
  // First pass: remove non-content elements
  let text = html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  
  // Convert common block elements to newlines
  text = text
    .replace(/<\/?(div|p|br|tr|h[1-6])[^>]*>/gi, '\n')
    .replace(/<\/td>/gi, ' ')  // TD ends become spaces
    .replace(/<td[^>]*>/gi, ''); // TD starts removed
  
  // Remove all remaining HTML tags
  text = text.replace(/<[^>]+>/g, '');
  
  // Decode HTML entities
  text = text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'");
  
  // Clean up whitespace
  text = text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .join('\n');
  
  // Remove common email footer noise
  text = text
    .replace(/^(Use this link in|or paste this link into|Button not working\?|This is an automatically generated|Do not reply to this email).*$/gim, '')
    .replace(/https?:\/\/[^\s]+/g, '[link]'); // Replace URLs with placeholder
  
  // Final cleanup
  text = text
    .split('\n')
    .filter(line => {
      // Remove lines that are just noise
      if (line.length < 3) return false;
      if (/^[\s\-_=]+$/.test(line)) return false;
      return true;
    })
    .join('\n')
    .trim();
  
  return text;
}

function simpleHash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// ═══════════════════════════════════════════════════════
//  ATTACHMENT TEXT EXTRACTION
// ═══════════════════════════════════════════════════════

// User-configurable; stored in DB as KB. Default = 5 KB (~2 pages).
const ATTACH_TEXT_LIMIT_DEFAULT_KB = 5;
let attachTextLimitKb = ATTACH_TEXT_LIMIT_DEFAULT_KB;
let attachTextLimit   = attachTextLimitKb * 1000; // chars; recomputed on load

const _LIB_URLS = {
  pdfjs:   'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  mammoth: 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.8.0/mammoth.browser.min.js',
  jszip:   'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
  xlsx:    'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js',
};
const _libLoaded = {};

async function loadLib(name) {
  if (_libLoaded[name]) return;
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = _LIB_URLS[name];
    s.onload  = resolve;
    s.onerror = () => reject(new Error(`Failed to load ${name} from CDN`));
    document.head.appendChild(s);
  });
  _libLoaded[name] = true;
  if (name === 'pdfjs' && window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }
}

async function loadAttachTextLimit() {
  const saved = await dbGet('settings', 'attachTextLimit');
  if (saved?.kb > 0) {
    attachTextLimitKb = saved.kb;
    attachTextLimit   = attachTextLimitKb * 1000;
  }
}

async function saveAttachTextLimitFromUI() {
  const input = document.getElementById('setting-attach-text-limit');
  const kb    = parseInt(input?.value, 10);
  if (!Number.isFinite(kb) || kb < 1) {
    toast('Enter a valid KB limit (e.g. 200)', 'warn');
    return;
  }
  attachTextLimitKb = kb;
  attachTextLimit   = kb * 1000;
  await dbPut('settings', { key: 'attachTextLimit', kb });
  toast(`Attachment text limit set to ${kb} KB`, 'ok');
}

function isExtractableType(contentType, filename) {
  const ext  = (filename || '').split('.').pop().toLowerCase();
  const mime = (contentType || '').toLowerCase();
  return (
    mime.includes('pdf') || ext === 'pdf' ||
    mime.includes('wordprocessingml') || mime.includes('msword') || ext === 'docx' || ext === 'doc' ||
    mime.includes('spreadsheetml') || mime.includes('excel') ||
      ext === 'xlsx' || ext === 'xls' || ext === 'csv' ||
    mime.includes('presentationml') || ext === 'pptx' || ext === 'pptm' ||
    ext === 'odp' || ext === 'ods' || ext === 'odt'
  );
}

function _truncateToLimit(text) {
  if (!text) return '';
  const clean = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (clean.length <= attachTextLimit) return clean;
  const cut = clean.slice(0, attachTextLimit);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > attachTextLimit * 0.8 ? cut.slice(0, lastSpace) : cut) + '…';
}

// Returns extracted plain text string, or null for unsupported formats.
// data: Uint8Array or ArrayBuffer
async function extractAttachmentText(data, contentType, filename) {
  const buf  = data instanceof Uint8Array ? data.buffer : data;
  const ext  = (filename || '').split('.').pop().toLowerCase();
  const mime = (contentType || '').toLowerCase();

  // ── PDF ──────────────────────────────────────────────
  if (mime.includes('pdf') || ext === 'pdf') {
    await loadLib('pdfjs');
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
    let text = '';
    for (let i = 1; i <= pdf.numPages; i++) {
      const page    = await pdf.getPage(i);
      const content = await page.getTextContent();
      text += content.items.map(item => item.str).join(' ') + '\n';
      if (text.length > attachTextLimit * 1.5) break;
    }
    return _truncateToLimit(text);
  }

  // ── DOCX / DOC ────────────────────────────────────────
  if (mime.includes('wordprocessingml') || mime.includes('msword') ||
      ext === 'docx' || ext === 'doc') {
    await loadLib('mammoth');
    const result = await mammoth.extractRawText({ arrayBuffer: buf });
    return _truncateToLimit(result.value);
  }

  // ── XLSX / XLS / CSV ─────────────────────────────────
  if (mime.includes('spreadsheetml') || mime.includes('excel') ||
      ext === 'xlsx' || ext === 'xls' || ext === 'csv') {
    await loadLib('xlsx');
    const wb = XLSX.read(new Uint8Array(buf), { type: 'array' });
    let text = '';
    for (const sheetName of wb.SheetNames) {
      const csv = XLSX.utils.sheet_to_csv(wb.Sheets[sheetName], { skipHidden: true });
      text += `[${sheetName}]\n${csv}\n\n`;
      if (text.length > attachTextLimit * 1.5) break;
    }
    return _truncateToLimit(text);
  }

  // ── PPTX / PPTM ──────────────────────────────────────
  if (mime.includes('presentationml') || ext === 'pptx' || ext === 'pptm') {
    await loadLib('jszip');
    const zip = await JSZip.loadAsync(buf);
    const slideNames = Object.keys(zip.files)
      .filter(n => /^ppt\/slides\/slide\d+\.xml$/i.test(n))
      .sort((a, b) => {
        const na = parseInt(a.match(/slide(\d+)/i)[1]);
        const nb = parseInt(b.match(/slide(\d+)/i)[1]);
        return na - nb;
      });
    let text = '';
    for (const name of slideNames) {
      const xml       = await zip.files[name].async('string');
      const matches   = [...xml.matchAll(/<a:t[^>]*>([^<]*)<\/a:t>/g)];
      const slideText = matches.map(m => m[1]).join(' ').trim();
      if (slideText) text += slideText + '\n';
      if (text.length > attachTextLimit * 1.5) break;
    }
    return _truncateToLimit(text);
  }

  // ── ODP / ODS / ODT ──────────────────────────────────
  if (ext === 'odp' || ext === 'ods' || ext === 'odt') {
    await loadLib('jszip');
    const zip         = await JSZip.loadAsync(buf);
    const contentFile = zip.files['content.xml'];
    if (!contentFile) return '';
    const xml     = await contentFile.async('string');
    const matches = [...xml.matchAll(/<text:[^>]+>([^<]+)<\/text:[^>]+>/g)];
    return _truncateToLimit(matches.map(m => m[1]).filter(Boolean).join(' '));
  }

  return null; // unsupported
}

// Internal helper: extract and persist to DB.  data = Uint8Array (available at import time).
async function _extractAndStoreText(attId, data, contentType, filename) {
  if (!isExtractableType(contentType, filename)) return;
  try {
    const text = await extractAttachmentText(data, contentType, filename);
    const att  = await dbGet('attachments', attId);
    if (!att) return;
    att.extractedText      = text ?? '';
    att.extractionStatus   = text != null ? 'done' : 'unsupported';
    att.extractedAt        = Date.now();
    await dbPut('attachments', att);
  } catch (err) {
    console.warn('Auto-extract failed for', filename, err);
    const att = await dbGet('attachments', attId);
    if (!att) return;
    att.extractionStatus = 'failed';
    att.extractedAt      = Date.now();
    await dbPut('attachments', att);
  }
}

// Manual single-attachment extraction — reads the file from the stored path on disk.
async function extractTextManualFromDisk(attId) {
  const att = await dbGet('attachments', attId);
  if (!att) return;

  if (!att.storedPath) {
    toast('No file stored on disk for this attachment', 'warn');
    return;
  }
  if (!isExtractableType(att.contentType, att.filename)) {
    toast(`${att.filename}: format not supported for text extraction`, 'warn');
    return;
  }

  if (!attachmentDirHandle) {
    const ok = confirm('Attachment folder not connected.\nClick OK to select the folder.');
    if (ok) {
      const success = await setupAttachmentStorage();
      if (!success) { toast('Cannot extract without folder access', 'err'); return; }
    } else return;
  }

  const btn = document.getElementById(`extract-btn-${attId}`);
  if (btn) { btn.disabled = true; btn.textContent = '…'; }

  try {
    const parts       = att.storedPath.split('/');
    const domainDir   = await attachmentDirHandle.getDirectoryHandle(parts[0]);
    const fileHandle  = await domainDir.getFileHandle(parts[1]);
    const file        = await fileHandle.getFile();
    const buf         = await file.arrayBuffer();
    const text        = await extractAttachmentText(new Uint8Array(buf), att.contentType, att.filename);
    att.extractedText    = text ?? '';
    att.extractionStatus = text != null ? 'done' : 'unsupported';
    att.extractedAt      = Date.now();
    await dbPut('attachments', att);
    toast(
      text ? `Extracted ${text.length.toLocaleString()} chars from ${att.filename}` : `No text found in ${att.filename}`,
      text ? 'ok' : 'warn'
    );
  } catch (err) {
    att.extractionStatus = 'failed';
    att.extractedAt      = Date.now();
    await dbPut('attachments', att);
    toast(`Extraction failed: ${err.message}`, 'err');
  }

  // Re-render the open detail panel so buttons + preview update
  if (selectedEmail) openDetail(selectedEmail);
}

// Bulk extraction — iterates all stored attachments that don't yet have extracted text.
async function bulkExtractAttachmentText() {
  const atts    = await dbGetAll('attachments');
  const pending = atts.filter(a =>
    !a.extractionStatus && isExtractableType(a.contentType, a.filename) && a.storedPath
  );
  if (!pending.length) {
    toast('No pending extractable attachments with stored files', 'warn');
    return;
  }
  if (!confirm(`Extract text from ${pending.length} attachment${pending.length !== 1 ? 's' : ''}?\n\nRequires the attachment folder to be connected.`)) return;

  if (!attachmentDirHandle) {
    const ok = confirm('Attachment folder not connected.\nClick OK to select the folder.');
    if (ok) {
      const success = await setupAttachmentStorage();
      if (!success) { toast('Cannot extract without folder access', 'err'); return; }
    } else return;
  }

  let done = 0, failed = 0;
  toast(`Extracting text from ${pending.length} attachments…`, 'ok');

  for (const att of pending) {
    try {
      const parts      = att.storedPath.split('/');
      const domainDir  = await attachmentDirHandle.getDirectoryHandle(parts[0]);
      const fileHandle = await domainDir.getFileHandle(parts[1]);
      const file       = await fileHandle.getFile();
      const buf        = await file.arrayBuffer();
      const text       = await extractAttachmentText(new Uint8Array(buf), att.contentType, att.filename);
      att.extractedText    = text ?? '';
      att.extractionStatus = text != null ? 'done' : 'unsupported';
      att.extractedAt      = Date.now();
      await dbPut('attachments', att);
      done++;
      if (done % 10 === 0) toast(`Extracting text: ${done}/${pending.length}…`, 'ok');
    } catch (err) {
      att.extractionStatus = 'failed';
      att.extractedAt      = Date.now();
      await dbPut('attachments', att);
      failed++;
    }
  }

  toast(
    `Text extraction complete: ${done} done${failed ? `, ${failed} failed` : ''}`,
    failed && !done ? 'err' : 'ok'
  );
  if (currentView === 'transmittals') showTransmittalRegister();
}

function toggleAttachText(attId) {
  const el = document.getElementById(`att-text-${attId}`);
  if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

function toggleAttachMore(btn) {
  const overflow = btn.closest('.attach-list').querySelector('.attach-overflow');
  const expanded = overflow.style.display !== 'none';
  overflow.style.display = expanded ? 'none' : '';
  btn.textContent = expanded ? btn.dataset.moreLabel : 'show less';
}
