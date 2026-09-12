//! The repository's own ignore rules.
//!
//! The hard-coded skip list in `walk` knows about `node_modules` and `target`.
//! It cannot know that this project generates `build-out/`, or writes
//! `secrets.env` — and those are exactly the files a repository has already
//! said it does not want carried around. An index that carries them lets a
//! content search surface a credential the repo deliberately excluded.
//!
//! This is a deliberate port of the TypeScript fallback's rules, character for
//! character, because the two engines must index the same tree. A file that
//! one finds and the other does not is the one failure this package cannot
//! afford: the tools never learn which engine they got.
//!
//! Only the root `.gitignore` is read. Nested ignore files and git's full
//! precedence rules are not, because a half-implemented ignore hides files
//! silently — and under-ignoring is the safer direction to be wrong in.

use regex::Regex;

pub struct Ignore {
    rules: Vec<Rule>,
}

struct Rule {
    matcher: Regex,
    negate: bool,
}

/// The lines people actually write: blanks and `#` comments dropped, the rest
/// kept in order because a later rule overrides an earlier one.
pub fn parse(text: &str) -> Vec<String> {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(str::to_string)
        .collect()
}

/// Translate one gitignore pattern to a regex, mirroring the fallback exactly.
///
/// The `**` handling is the subtle part: it must be taken out of the way
/// *before* single `*` is expanded, or the second replacement would eat the
/// first one's output. The fallback parks it on a placeholder character; here
/// the same job is done by splitting on it, which cannot collide with anything
/// in the input.
fn to_regex(pattern: &str) -> Option<Regex> {
    let anchored = pattern.starts_with('/');
    let body = if anchored { &pattern[1..] } else { pattern };
    let dir_only = body.ends_with('/');
    let clean = if dir_only { &body[..body.len() - 1] } else { body };

    let mut out = String::with_capacity(clean.len() * 2);
    for (i, segment) in clean.split("**").enumerate() {
        if i > 0 {
            out.push_str(".*");
        }
        for ch in segment.chars() {
            match ch {
                '*' => out.push_str("[^/]*"),
                '?' => out.push_str("[^/]"),
                '.' | '+' | '^' | '$' | '{' | '}' | '(' | ')' | '|' | '[' | ']' | '\\' => {
                    out.push('\\');
                    out.push(ch);
                }
                _ => out.push(ch),
            }
        }
    }

    let source = if anchored {
        format!("^{out}(/|$)")
    } else {
        format!("(^|/){out}(/|$)")
    };
    Regex::new(&source).ok()
}

impl Ignore {
    pub fn new(patterns: &[String]) -> Self {
        Self {
            rules: patterns
                .iter()
                .filter_map(|raw| {
                    let negate = raw.starts_with('!');
                    let pattern = if negate { &raw[1..] } else { raw.as_str() };
                    to_regex(pattern).map(|matcher| Rule { matcher, negate })
                })
                .collect(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.rules.is_empty()
    }

    /// Every rule is tried in order and the last one that matches wins, which
    /// is what makes `!keep.log` after `*.log` mean what it looks like.
    pub fn matches(&self, rel: &str) -> bool {
        let mut ignored = false;
        for rule in &self.rules {
            if rule.matcher.is_match(rel) {
                ignored = !rule.negate;
            }
        }
        ignored
    }

    /// A directory pattern (`generated/`) has to be matched against the
    /// directory's own path with a trailing slash, so the whole subtree is
    /// skipped instead of every file under it being tested one at a time.
    pub fn matches_dir(&self, rel: &str) -> bool {
        self.matches(&format!("{rel}/"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ig(lines: &[&str]) -> Ignore {
        Ignore::new(&lines.iter().map(|s| s.to_string()).collect::<Vec<_>>())
    }

    #[test]
    fn comments_and_blanks_are_not_rules() {
        assert_eq!(parse("# a comment\n\n  \nreal\n"), vec!["real".to_string()]);
    }

    #[test]
    fn plain_names_match_at_any_depth() {
        let i = ig(&["secrets.env"]);
        assert!(i.matches("secrets.env"));
        assert!(i.matches("config/secrets.env"));
        assert!(!i.matches("secrets.env.example"));
    }

    #[test]
    fn a_leading_slash_anchors_to_the_root() {
        let i = ig(&["/build"]);
        assert!(i.matches("build"));
        assert!(i.matches("build/out.js"));
        assert!(!i.matches("src/build"));
    }

    #[test]
    fn a_trailing_slash_marks_a_directory() {
        let i = ig(&["generated/"]);
        assert!(i.matches_dir("generated"));
        assert!(i.matches("generated/huge.ts"));
    }

    #[test]
    fn a_star_stops_at_a_slash_and_double_star_does_not() {
        assert!(ig(&["*.log"]).matches("debug.log"));
        assert!(ig(&["*.log"]).matches("logs/debug.log"));
        // `a/*/c` is one segment; `a/**/c` is any number.
        assert!(ig(&["a/*/c"]).matches("a/b/c"));
        assert!(!ig(&["a/*/c"]).matches("a/b/x/c"));
        assert!(ig(&["a/**/c"]).matches("a/b/x/c"));
    }

    #[test]
    fn the_last_matching_rule_wins_so_negation_works() {
        let i = ig(&["*.log", "!keep.log"]);
        assert!(i.matches("debug.log"));
        assert!(!i.matches("keep.log"));
        // Order matters: reversed, the negation is overridden again.
        assert!(ig(&["!keep.log", "*.log"]).matches("keep.log"));
    }

    #[test]
    fn a_pattern_that_will_not_compile_is_dropped_not_guessed() {
        // Nothing here should panic, and the valid rule must still apply.
        let i = ig(&["[", "*.log"]);
        assert!(i.matches("debug.log"));
    }
}
