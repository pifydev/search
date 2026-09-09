/**
 * Deciding whether a line really matches, once the index has narrowed the
 * field.
 *
 * The trigram index answers "which files could contain this", never "which
 * lines do". Every candidate is still read and matched here, so a wrong
 * candidate costs time and never correctness — which is what makes it safe to
 * narrow aggressively.
 *
 * Three modes, because three different questions get asked: the exact string,
 * a regex, and "something like this" for when the caller does not know how the
 * thing is spelled.
 */

import { maxTypos } from "./fuzzy.ts";

export type Mode = "literal" | "regex" | "fuzzy";

export interface LineMatch {
  /** 1-based, as every editor and every error message counts them. */
  line: number;
  text: string;
  /** Byte-free column range of the hit, for highlighting. */
  start: number;
  end: number;
}

export interface Matcher {
  test(line: string): { start: number; end: number } | null;
}

/** A matcher for one pattern, or null when the pattern itself is broken. */
export function buildMatcher(pattern: string, mode: Mode, caseInsensitive: boolean): Matcher | null {
  if (pattern === "") return null;

  if (mode === "literal") {
    const needle = caseInsensitive ? pattern.toLowerCase() : pattern;
    return {
      test(line) {
        const hay = caseInsensitive ? line.toLowerCase() : line;
        const at = hay.indexOf(needle);
        return at === -1 ? null : { start: at, end: at + needle.length };
      },
    };
  }

  if (mode === "regex") {
    let re: RegExp;
    try {
      re = new RegExp(pattern, caseInsensitive ? "i" : "");
    } catch {
      return null;
    }
    return {
      test(line) {
        const m = re.exec(line);
        return m ? { start: m.index, end: m.index + m[0].length } : null;
      },
    };
  }

  // Fuzzy: the query's characters in order, within a typo budget, and close
  // enough together to be one word rather than three scattered letters.
  const budget = maxTypos(pattern);
  const needle = pattern.toLowerCase();
  const span = Math.max(needle.length * 3, needle.length + 8);
  return {
    test(line) {
      const hay = line.toLowerCase();
      for (let start = 0; start < hay.length; start++) {
        if (hay[start] !== needle[0] && budget === 0) continue;
        let typos = 0;
        let at = start;
        let matched = 0;
        for (let n = 0; n < needle.length; n++) {
          const found = hay.indexOf(needle[n]!, at);
          if (found === -1 || found - start > span) {
            typos++;
            if (typos > budget) break;
            continue;
          }
          at = found + 1;
          matched++;
        }
        if (matched > 0 && typos <= budget && matched >= needle.length - budget) {
          return { start, end: Math.min(at, hay.length) };
        }
      }
      return null;
    },
  };
}

/** Every matching line in one file's content. */
export function matchLines(content: string, matcher: Matcher, limit: number): LineMatch[] {
  const out: LineMatch[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length && out.length < limit; i++) {
    const text = lines[i]!;
    const hit = matcher.test(text);
    if (hit) out.push({ line: i + 1, text, start: hit.start, end: hit.end });
  }
  return out;
}

/**
 * Whether a file is worth reading as text at all.
 *
 * A NUL byte in the first few kilobytes is the classic signal, and it is
 * cheaper and more reliable than trusting an extension: a `.dat` may be text
 * and a `.txt` may not.
 */
export function looksBinary(sample: string): boolean {
  const window = sample.slice(0, 8192);
  for (let i = 0; i < window.length; i++) {
    if (window.charCodeAt(i) === 0) return true;
  }
  return false;
}
