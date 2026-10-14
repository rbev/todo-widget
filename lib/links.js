// Link extraction helper for todo-widget — pure ES module, no platform deps.
//
// Extracts clickable web links from raw Markdown task text so that the
// indicator can display them as separate menu items below each task's
// CheckMenuItem.  Only http/https URLs are extracted; other schemes are
// silently ignored.  Best-effort, not a full CommonMark parser.
//
// Supported syntax:
//   • [label](https://example.com)   — inline Markdown link
//   • <https://example.com>          — angle-bracket autolink
//   • https://example.com/path       — bare URL
//
// URLs are validated with a small lexical checker (no platform URL API
// dependency).  Links are extracted in source order; each source link
// produces at most one item (no nested or duplicate matches).  Duplicate
// URLs are deduplicated (first occurrence wins).

/** URL body: http(s):// followed by non-delimiter chars, allowing one level
 *  of balanced parentheses.  Excludes whitespace and angle delimiters. */
const URL_BODY = 'https?:\\/\\/(?:[^()<>\\s]|\\([^()<>\\s]*\\))*';

// Combined link matcher — Markdown, angle, bare in one pass for source order.
// Group 1: Markdown label, 2: Markdown URL, 3: angle URL, 4: bare URL.
const LINK_RE = new RegExp(
  '\\[([^\\]]+)\\]\\((' + URL_BODY + ')\\)' +
  '|<(' + URL_BODY + ')>' +
  '|(\\b' + URL_BODY + ')',
  'g');

// Markdown-link-only regex for cleanLinkSyntax.
const MD_LINK_RE = new RegExp('\\[([^\\]]+)\\]\\((' + URL_BODY + ')\\)', 'g');

/**
 * Lexical validation of an http/https URL — no platform URL API needed.
 * Checks scheme, nonempty hostname, no whitespace/control/angle delimiters.
 * Allows DNS names, localhost, ports, and bracketed IPv6.
 */
function isSafeUrl(url) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return false;
  if (/[\s<>\x00-\x1f\x7f]/.test(url)) return false;
  const rest = url.slice(url.indexOf('://') + 3);
  const auth = rest.split(/[/?#]/)[0].replace(/^.*@/, '');
  if (auth.length === 0) return false;
  if (auth[0] === '[') {                               // IPv6 in brackets
    const close = auth.indexOf(']');
    if (close < 2) return false;
    const after = auth.slice(close + 1);
    return !after || /^:\d+$/.test(after);
  }
  const colon = auth.indexOf(':');
  const host = colon === -1 ? auth : auth.slice(0, colon);
  if (host.length === 0) return false;
  if (colon !== -1 && !/^\d+$/.test(auth.slice(colon + 1))) return false;
  return /^[a-zA-Z0-9.\-]+$/.test(host);
}

/**
 * Trim trailing punctuation and unmatched closing brackets/parens from a
 * bare URL.  Only applies to bare URLs — angle and Markdown destinations
 * are explicitly delimited and preserve literal punctuation.
 */
function trimTrailing(url) {
  let out = url.replace(/[.,;:!?\u2014\u2013]+$/u, '');
  for (let i = 0; i < 4; i++) {
    const last = out[out.length - 1];
    if (last === ')' || last === ']' || last === '}') {
      const open = last === ')' ? '(' : last === ']' ? '[' : '{';
      const closeCount = (out.match(new RegExp('\\' + last, 'g')) || []).length;
      const openCount = (out.match(new RegExp('\\' + open, 'g')) || []).length;
      if (closeCount > openCount) out = out.slice(0, -1);
      else break;
    } else break;
  }
  return out;
}

/**
 * Extract clickable web links from raw text, in source order, deduplicated.
 * @param {string} text
 * @returns {{ label: string, url: string }[]}
 */
export function extractLinks(text) {
  if (!text) return [];
  const seen = new Set();
  const results = [];
  for (const m of text.matchAll(LINK_RE)) {
    const rawUrl = m[2] || m[3] || m[4];
    if (!rawUrl) continue;
    // Only bare URLs get trailing-punctuation trimming; angle and Markdown
    // destinations are explicitly delimited.
    const url = m[4] ? trimTrailing(rawUrl) : rawUrl;
    if (!isSafeUrl(url) || seen.has(url)) continue;
    seen.add(url);
    const label = (m[1] && m[1].trim()) || url;
    results.push({ label, url });
  }
  return results;
}

/**
 * Replace Markdown link syntax [label](url) with just the label text.
 * @param {string} text
 * @returns {string}
 */
export function cleanLinkSyntax(text) {
  if (!text) return text;
  return text.replace(MD_LINK_RE, (_whole, label) => label);
}