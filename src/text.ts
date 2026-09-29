const ACKNOWLEDGEMENTS: readonly string[] = [
  "thank you",
  "go ahead",
  "got it",
  "go on",
  "okay",
  "thanks",
  "continue",
  "yeah",
  "yep",
  "yes",
  "nope",
  "sure",
  "next",
  "done",
  "lgtm",
  "thx",
  "ok",
  "ty",
  "no",
  "k",
  "謝謝",
  "谢谢",
  "繼續",
  "继续",
  "好的",
  "可以",
  "好",
  "是",
  "對",
  "对",
  "嗯",
];

const SECRET_PATTERNS: readonly RegExp[] = [
  /(?:^|[^A-Za-z0-9_-])sk-[A-Za-z0-9_-]{17,}/,
  /(?:^|[^A-Za-z0-9_])(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{8,}/,
  /(?:^|[^A-Za-z0-9_])github_pat_[A-Za-z0-9_]{8,}/,
  /(?:^|[^A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])/,
  /(?:^|[^A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{8,}/,
  /(?:^|[^A-Za-z0-9])AIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  /(?:^|[^A-Za-z0-9_])eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
  /(?:^|[^A-Za-z0-9_])(?:password|passwd|secret|api_key|token)["']?\s*[:=]\s*["']?\S{8,}/i,
];

const SYSTEM_PAIR_SOURCE =
  "<(?=[\\w:.-]*(?:system|reminder))([A-Za-z_:][\\w:.-]*)\\b[^<>]*>[\\s\\S]*?</\\1\\s*>";
const SYSTEM_EMPTY_SOURCE = "<(?=[\\w:.-]*(?:system|reminder))[A-Za-z_:][\\w:.-]*\\b[^<>]*\\/>";

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function removeFencedBlocks(text: string): string {
  return text
    .replace(/(`{3,})[^\n`]*\1/g, " ")
    .replace(/(~{3,})[^\n~]*\1/g, " ")
    .replace(/(`{3,})[^\n`]*\n[\s\S]*?\1/g, " ")
    .replace(/(~{3,})[^\n~]*\n[\s\S]*?\1/g, " ")
    .replace(/(`{3,})[^\n`]*\n[\s\S]*$/g, " ")
    .replace(/(~{3,})[^\n~]*\n[\s\S]*$/g, " ")
    .replace(/(?:^|\n)[ \t]{0,3}(`{3,}|~{3,})[^\n]*$/g, " ");
}

function removeSystemBlocks(text: string): string {
  // Fresh regexes: a shared global instance would keep lastIndex across calls.
  const paired = new RegExp(SYSTEM_PAIR_SOURCE, "gi");
  const empty = new RegExp(SYSTEM_EMPTY_SOURCE, "gi");
  return text.replace(paired, " ").replace(empty, " ");
}

function cleanText(text: string): string {
  return collapseWhitespace(removeSystemBlocks(removeFencedBlocks(text)));
}

function cutSurrogate(text: string, end: number): string {
  if (end <= 0) return "";
  const limit = Math.min(end, text.length);
  const code = text.charCodeAt(limit - 1);
  const safe = code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit;
  return text.slice(0, safe);
}

function clipToWord(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  // Last 20% of the window: break on a space when one exists; otherwise hard-clip (CJK).
  const windowStart = Math.floor(maxChars * 0.8);
  const boundary = text.lastIndexOf(" ", maxChars - 1);
  if (boundary >= windowStart) return text.slice(0, boundary);
  return cutSurrogate(text, maxChars);
}

function isTrailingNoise(rest: string): boolean {
  return /^[\s\p{P}\p{S}\p{M}\p{Cf}]*$/u.test(rest);
}

function isBareAcknowledgement(text: string): boolean {
  const lower = text.toLowerCase();
  for (const ack of ACKNOWLEDGEMENTS) {
    if (lower.startsWith(ack) && isTrailingNoise(text.slice(ack.length))) return true;
  }
  return false;
}

function countNonSpace(text: string): number {
  let count = 0;
  for (const char of text) {
    if (!/\s/u.test(char)) count += 1;
  }
  return count;
}

function countHan(text: string): number {
  let count = 0;
  for (const char of text) {
    if (/\p{Script=Han}/u.test(char)) count += 1;
  }
  return count;
}

export function focusQuery(text: string, maxChars: number): string {
  return clipToWord(cleanText(text), maxChars);
}

export function isSubstantivePrompt(text: string): boolean {
  const focused = cleanText(text);
  if (focused.length === 0 || focused.startsWith("/") || focused.startsWith("!")) return false;
  if (isBareAcknowledgement(focused)) return false;
  return countNonSpace(focused) >= 12 || countHan(focused) >= 4;
}

export function looksLikeSecret(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

export function clip(text: string, maxChars: number): string {
  const collapsed = collapseWhitespace(text);
  if (maxChars <= 0) return "";
  if (collapsed.length <= maxChars) return collapsed;
  return `${cutSurrogate(collapsed, maxChars - 1)}…`;
}
