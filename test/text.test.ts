import { describe, expect, test } from "bun:test";
import { clip, focusQuery, isSubstantivePrompt, looksLikeSecret } from "../src/text.ts";

function loneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    const high = code >= 0xd800 && code <= 0xdbff;
    const low = code >= 0xdc00 && code <= 0xdfff;
    if (low) return true;
    if (!high) continue;
    const next = text.charCodeAt(i + 1);
    if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
    i += 1;
  }
  return false;
}

describe("focusQuery", () => {
  test("given whitespace, when focused, then it is empty", () => {
    // Given blank input, when focused, then nothing remains.
    expect(focusQuery(" \n\t  ", 40)).toBe("");
  });

  test("given a fenced block, when focused, then the fence is gone and whitespace collapses", () => {
    // Given a prompt wrapping a fence, when focused, then only the prose remains.
    const input = "before\n```ts\nconst x = 1;\n```\n  after   text";
    expect(focusQuery(input, 80)).toBe("before after text");
  });

  test("given an inline fence and a tilde fence, when focused, then both are removed", () => {
    // Given mixed fences, when focused, then the surrounding prose is joined.
    const input = "see ```code``` please\n~~~\nblock\n~~~\nkept";
    expect(focusQuery(input, 80)).toBe("see please kept");
  });

  test("given an unclosed fence, when focused, then the fenced tail is dropped", () => {
    // Given an opening fence without a close, when focused, then later lines are not kept.
    expect(focusQuery("hello\n```\nsecret tail", 80)).toBe("hello");
  });

  test("given system blocks, when focused, then those tags and bodies are removed", () => {
    // Given reminder and directive blocks, when focused, then only the user sentence remains.
    const input = [
      "Project Falcon <system-reminder>ignore</system-reminder> uses",
      '<system-directive kind="quiet">hidden</system-directive>',
      "<session-reminder>note</session-reminder> PostgreSQL 16",
    ].join(" ");
    expect(focusQuery(input, 200)).toBe("Project Falcon uses PostgreSQL 16");
  });

  test("given an ordinary tag, when focused, then it is kept", () => {
    // Given a non-system tag, when focused, then the tag text remains.
    expect(focusQuery("keep <note>visible</note> please", 80)).toBe("keep <note>visible</note> please");
  });

  test("given a long sentence, when focused inside the last fifth, then it clips on a word", () => {
    // Given spaces inside the last 20%, when focused, then the cut is the later word boundary.
    expect(focusQuery("alpha beta gamma delta", 12)).toBe("alpha beta");
  });

  test("given a space before the last fifth, when focused, then it hard-clips", () => {
    // Given the only space is outside the last 20%, when focused, then the cut is not that space.
    expect(focusQuery("ww wwwwwwwwwwwww", 10)).toBe("ww wwwwwww");
  });

  test("given CJK without spaces, when focused, then it hard-clips", () => {
    // Given ideographs and no spaces, when focused, then the cut is a hard clip.
    expect(focusQuery("我們上次決定用哪個資料庫", 4)).toBe("我們上次");
  });

  test("given emoji on the cut, when focused, then no surrogate is split", () => {
    // Given emoji at the hard-clip boundary, when focused, then the pair stays intact.
    const emoji = "😀";
    const focused = focusQuery(emoji.repeat(5), 5);
    expect(focused).toBe(emoji.repeat(2));
    expect(loneSurrogate(focused)).toBe(false);
  });

  test("given text under the limit, when focused, then no ellipsis is added", () => {
    // Given a short prompt, when focused, then it is returned whole.
    expect(focusQuery("Project Falcon", 40)).toBe("Project Falcon");
  });
});

describe("isSubstantivePrompt", () => {
  const cases: readonly (readonly [string, boolean])[] = [
    ["", false],
    ["  \n\t", false],
    ["/recall something long enough to pass the length bar", false],
    ["  /help me migrate Project Falcon", false],
    ["!ls -la and tell me about Project Falcon", false],
    ["好的！", false],
    ["ok", false],
    ["okay", false],
    ["k", false],
    ["thanks", false],
    ["thank you", false],
    ["thx", false],
    ["ty", false],
    ["yes", false],
    ["yep", false],
    ["yeah", false],
    ["no", false],
    ["nope", false],
    ["sure", false],
    ["got it", false],
    ["continue", false],
    ["go on", false],
    ["go ahead", false],
    ["next", false],
    ["done", false],
    ["lgtm", false],
    ["OKAY!!!", false],
    ["LGTM 👍", false],
    ["謝謝", false],
    ["谢谢", false],
    ["繼續", false],
    ["继续", false],
    ["是", false],
    ["對", false],
    ["对", false],
    ["嗯", false],
    ["可以", false],
    ["好", false],
    ["我們上次決定用哪個資料庫？", true],
    ["資料庫選", true],
    ["資料庫", false],
    ["abcdefghijk", false],
    ["abcdefghijkl", true],
    ["Project Falcon uses PostgreSQL 16", true],
    ["<system-reminder>ignore</system-reminder>\n/help", false],
    ["```\nconst x = 1;\n```\nhi", false],
    ["ok we should migrate Project Falcon to PostgreSQL 16", true],
  ];

  for (const [input, expected] of cases) {
    test(`given ${JSON.stringify(input)}, when judged, then ${String(expected)}`, () => {
      // Given a prompt, when substantive-ness is judged, then the table expectation holds.
      expect(isSubstantivePrompt(input)).toBe(expected);
    });
  }
});

describe("looksLikeSecret", () => {
  // Token-shaped fixtures are assembled at runtime so secret scanners never see a literal.
  const pem = (kind: string) => `${"-----BEGIN"} ${kind}KEY-----`;
  const jwt = (...parts: readonly string[]) => parts.map((part) => `eyJ${part}`).join(".");
  const cases: readonly (readonly [string, boolean])[] = [
    [`sk-${"a".repeat(17)}`, true],
    [`sk-${"a".repeat(16)}`, false],
    [`sk-ant-${"b".repeat(13)}`, true],
    [`sk-ant-${"b".repeat(12)}`, false],
    [`ghp_${"a".repeat(36)}`, true],
    [`gho_${"b".repeat(36)}`, true],
    [`ghu_${"c".repeat(36)}`, true],
    [`ghs_${"d".repeat(36)}`, true],
    [`ghr_${"e".repeat(36)}`, true],
    [`github_pat_${"f".repeat(22)}_${"a".repeat(20)}`, true],
    ["tokens look like ghp_ in docs", false],
    [`AKIA${"A".repeat(16)}`, true],
    [`ASIA${"B".repeat(16)}`, true],
    [`AKIA${"A".repeat(15)}`, false],
    [`akia${"A".repeat(16)}`, false],
    [`xoxb-${"1".repeat(12)}`, true],
    [`xoxp-${"a".repeat(12)}`, true],
    [`xoxa-${"a".repeat(12)}`, true],
    [`xoxr-${"a".repeat(12)}`, true],
    [`xoxs-${"a".repeat(12)}`, true],
    ["xoxb-short", false],
    [`AIza${"a".repeat(35)}`, true],
    [`AIza${"a".repeat(34)}`, false],
    [`AIza${"a".repeat(36)}`, false],
    [pem("PRIVATE "), true],
    [pem("RSA PRIVATE "), true],
    [pem("OPENSSH PRIVATE "), true],
    [pem("PUBLIC "), false],
    [`${jwt("header", "payload")}.signature`, true],
    [jwt("header", "payload"), false],
    ["password: hunter2hunter2", true],
    ["password: hunter2", false],
    ["passwd=hunter2hunter2", true],
    ["secret: hunter22x", true],
    ["api_key: abcdefgh", true],
    ["token=abcdefgh", true],
    ['{"password":"hunter2hunter2"}', true],
    ["the password is not stored here", false],
    ["token bucket is a rate limiter", false],
    ["Remember the password but do not store the token in the repo.", false],
  ];

  for (const [input, expected] of cases) {
    test(`given ${JSON.stringify(input)}, when scanned, then secret is ${String(expected)}`, () => {
      // Given text, when scanned for secrets, then the table expectation holds.
      expect(looksLikeSecret(input)).toBe(expected);
    });
  }

  test("given a key inside a fence, when scanned, then it is still a secret", () => {
    // Given a fenced key, when scanned, then fences are not stripped before the check.
    expect(looksLikeSecret(`\`\`\`\nsk-${"a".repeat(20)}\n\`\`\``)).toBe(true);
  });
});

describe("clip", () => {
  test("given extra whitespace, when clipped under the limit, then it collapses", () => {
    // Given spaced text, when clipped, then whitespace is one space.
    expect(clip("alpha   beta\n", 40)).toBe("alpha beta");
  });

  test("given text over the limit, when clipped, then it ends with an ellipsis", () => {
    // Given a long sentence, when clipped, then the cut is maxChars-1 plus ellipsis.
    expect(clip("alpha beta gamma", 8)).toBe("alpha b…");
  });

  test("given emoji on the cut, when clipped, then no surrogate is split", () => {
    // Given an emoji at maxChars-1, when clipped, then the pair is dropped whole.
    const clipped = clip(`hi${"😀"}there-and-more`, 4);
    expect(clipped).toBe("hi…");
    expect(loneSurrogate(clipped)).toBe(false);
  });

  test("given a non-positive limit, when clipped, then it is empty", () => {
    // Given maxChars of zero, when clipped, then nothing is returned.
    expect(clip("hello", 0)).toBe("");
    expect(clip("   ", 10)).toBe("");
  });
});
