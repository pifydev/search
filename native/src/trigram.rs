//! Trigram index over file contents.
//!
//! Every overlapping three-byte window of a file is packed into a `u32` —
//! `(a << 16) | (b << 8) | c` — which is injective, so a trigram is its own
//! hash and no two distinct windows collide. The index maps each trigram to
//! the files containing it, and a search intersects the posting lists of the
//! trigrams its pattern must contain. Only the files that survive are read.
//!
//! The index only ever *narrows*. Every candidate is matched for real
//! afterwards, so a wrong candidate costs time and never correctness — which
//! is what makes it safe to narrow aggressively.

use std::collections::{HashMap, HashSet};

pub type Trigram = u32;

/// A trigram key *is* its own hash, so the default SipHash is pure overhead on
/// a path that runs once per input byte. One multiply-xorshift replaces it;
/// the xorshift is not optional, because hashbrown takes the bucket index from
/// the low bits and the low bits of `value * K` depend only on the last byte.
#[derive(Default, Clone, Copy)]
pub struct TrigramHasher(u64);

impl std::hash::Hasher for TrigramHasher {
    #[inline]
    fn finish(&self) -> u64 {
        self.0
    }
    #[inline]
    fn write(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.0 = (self.0 ^ u64::from(b)).wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    #[inline]
    fn write_u32(&mut self, value: u32) {
        let mixed = (u64::from(value)).wrapping_mul(0x9E37_79B9_7F4A_7C15);
        self.0 = mixed ^ (mixed >> 29);
    }
}

#[derive(Default, Clone, Copy)]
pub struct BuildTrigramHasher;

impl std::hash::BuildHasher for BuildTrigramHasher {
    type Hasher = TrigramHasher;
    #[inline]
    fn build_hasher(&self) -> TrigramHasher {
        TrigramHasher::default()
    }
}

type TrigramMap<V> = HashMap<Trigram, V, BuildTrigramHasher>;

/// Every distinct trigram in `bytes`, ASCII-folded so the index and the query
/// agree on case without storing both.
pub fn extract(bytes: &[u8], out: &mut HashSet<Trigram, BuildTrigramHasher>) {
    out.clear();
    if bytes.len() < 3 {
        return;
    }
    for window in bytes.windows(3) {
        let a = window[0].to_ascii_lowercase() as u32;
        let b = window[1].to_ascii_lowercase() as u32;
        let c = window[2].to_ascii_lowercase() as u32;
        out.insert((a << 16) | (b << 8) | c);
    }
}

pub fn of(text: &str) -> Vec<Trigram> {
    let mut set = HashSet::with_hasher(BuildTrigramHasher);
    extract(text.as_bytes(), &mut set);
    let mut list: Vec<Trigram> = set.into_iter().collect();
    list.sort_unstable();
    list
}

/// What the index can be asked. `All` means the pattern gave nothing
/// indexable, so no candidate set is safe and everything must be read —
/// a different answer from "nothing matched", and conflating the two is how
/// an index silently starts hiding results.
#[derive(Debug, Clone)]
pub enum Plan {
    And(Vec<Trigram>),
    Or(Vec<Plan>),
    All,
}

#[derive(Default)]
pub struct Index {
    postings: TrigramMap<Vec<u32>>,
    indexed: HashSet<u32>,
}

impl Index {
    pub fn new() -> Self {
        Self {
            postings: HashMap::with_hasher(BuildTrigramHasher),
            indexed: HashSet::new(),
        }
    }

    pub fn len(&self) -> usize {
        self.indexed.len()
    }

    /// Whether a file's contents are in the index. A listed file that is not is
    /// text kept out of it (too big, empty) and still a grep candidate.
    pub fn contains(&self, file: u32) -> bool {
        self.indexed.contains(&file)
    }

    pub fn add(&mut self, file: u32, trigrams: &[Trigram]) {
        if self.indexed.contains(&file) {
            self.remove(file);
        }
        for &t in trigrams {
            let list = self.postings.entry(t).or_default();
            // Postings stay sorted so intersection is a merge, not a scan.
            //
            // Bulk builds add files in ascending id order, so the new id
            // belongs at the end and one comparison settles it. Falling
            // through to a binary search here would cost fifteen scattered
            // probes on a list held by every file — which measured as most of
            // the time spent building the index.
            match list.last() {
                Some(&last) if last >= file => match list.binary_search(&file) {
                    Ok(_) => {}
                    Err(at) => list.insert(at, file),
                },
                _ => list.push(file),
            }
        }
        self.indexed.insert(file);
    }

    pub fn remove(&mut self, file: u32) {
        if !self.indexed.remove(&file) {
            return;
        }
        self.postings.retain(|_, list| {
            if let Ok(at) = list.binary_search(&file) {
                list.remove(at);
            }
            !list.is_empty()
        });
    }

    /// The index turned back the other way up: every trigram, grouped by the
    /// file it came from, for writing the index out.
    ///
    /// One pass over the postings rather than one pass *per file* — asking each
    /// file separately would rescan the entire index for every file, which on a
    /// large tree is quadratic and would cost more than rebuilding from source.
    pub fn by_file(&self) -> HashMap<u32, Vec<Trigram>> {
        let mut out: HashMap<u32, Vec<Trigram>> = HashMap::with_capacity(self.indexed.len());
        for &file in &self.indexed {
            out.insert(file, Vec::new());
        }
        for (&t, files) in &self.postings {
            for file in files {
                if let Some(list) = out.get_mut(file) {
                    list.push(t);
                }
            }
        }
        for list in out.values_mut() {
            list.sort_unstable();
        }
        out
    }

    /// Candidate file ids, or `None` meaning every file must be read.
    pub fn candidates(&self, plan: &Plan) -> Option<Vec<u32>> {
        match plan {
            Plan::All => None,
            Plan::Or(branches) => {
                let mut union: Vec<u32> = Vec::new();
                for branch in branches {
                    let part = self.candidates(branch)?;
                    union.extend_from_slice(&part);
                }
                union.sort_unstable();
                union.dedup();
                Some(union)
            }
            Plan::And(trigrams) => {
                if trigrams.is_empty() {
                    return None;
                }
                let mut lists: Vec<&Vec<u32>> = Vec::with_capacity(trigrams.len());
                for t in trigrams {
                    match self.postings.get(t) {
                        // A trigram nobody has means nothing can match — an
                        // empty answer, emphatically not "read everything".
                        None => return Some(Vec::new()),
                        Some(list) => lists.push(list),
                    }
                }
                // Smallest first, so the working set only ever shrinks.
                lists.sort_by_key(|l| l.len());
                let mut result = lists[0].clone();
                for list in &lists[1..] {
                    if result.is_empty() {
                        break;
                    }
                    result = intersect(&result, list);
                }
                Some(result)
            }
        }
    }
}

/// Both sides are sorted, so this is a linear merge rather than a lookup loop.
fn intersect(a: &[u32], b: &[u32]) -> Vec<u32> {
    let mut out = Vec::with_capacity(a.len().min(b.len()));
    let (mut i, mut j) = (0usize, 0usize);
    while i < a.len() && j < b.len() {
        match a[i].cmp(&b[j]) {
            std::cmp::Ordering::Equal => {
                out.push(a[i]);
                i += 1;
                j += 1;
            }
            std::cmp::Ordering::Less => i += 1,
            std::cmp::Ordering::Greater => j += 1,
        }
    }
    out
}

/// Literal runs of three or more characters — the only parts of a pattern
/// that imply required trigrams.
///
/// The rule that matters: a run may only contain characters the pattern
/// *requires*, in the order it requires them. Emitting anything else asks the
/// index for trigrams the pattern never promised, and the index then excludes
/// files that genuinely match — a false negative, the one failure an index
/// must never produce.
///
/// Delimited spans (`[…]`, `{…}`) are skipped, not broken at. Groups get the
/// same treatment one level up: a quantifier after `)` makes the whole group
/// optional, so nothing pushed since its `(` is required — which needs a
/// stack, because by the time `)?` is seen the group's runs are already in
/// the list. The first fix here handled classes and braces and missed exactly
/// this: `(abcd)?xyz` still demanded the trigrams of `abcd`, and a file
/// containing only `xyz` matched the regex while the index excluded it.
/// Lookarounds are dropped conservatively — a negative `(?!abcd)` must never
/// require what it forbids. Kept deliberately identical to the TypeScript
/// fallback's `literalRuns`.
pub fn literal_runs(pattern: &str) -> Vec<String> {
    let chars: Vec<char> = pattern.chars().collect();
    let mut runs: Vec<String> = Vec::new();
    let mut groups: Vec<(usize, bool)> = Vec::new();
    let mut current = String::new();
    let mut i = 0usize;
    while i < chars.len() {
        let ch = chars[i];
        if ch == '\\' {
            if let Some(&next) = chars.get(i + 1) {
                if !next.is_ascii_alphanumeric() {
                    current.push(next);
                    i += 2;
                    continue;
                }
            }
            runs.push(std::mem::take(&mut current));
            i += 2;
            continue;
        }
        // A character class is an alternation: nothing it holds is required.
        if ch == '[' {
            runs.push(std::mem::take(&mut current));
            i = skip_to(&chars, i, ']');
            continue;
        }
        if ch == '(' {
            runs.push(std::mem::take(&mut current));
            let mut discard = false;
            if chars.get(i + 1) == Some(&'?') {
                if chars.get(i + 2) == Some(&':') {
                    // (?:…) is an ordinary group in disguise; without
                    // consuming the marker, `?` reads as a quantifier and
                    // `:` as text.
                    i += 2;
                } else {
                    // Lookarounds: only the positive forms truly require
                    // their contents, and requiring a negative one's contents
                    // excludes exactly the files that match.
                    discard = true;
                    i += 1;
                }
            }
            groups.push((runs.len(), discard));
            i += 1;
            continue;
        }
        if ch == ')' {
            let group = groups.pop();
            let next = chars.get(i + 1).copied();
            // `+` is deliberately absent: (abc)+ requires at least one abc.
            let optional = matches!(next, Some('?') | Some('*') | Some('{'));
            match group {
                Some((start, discard)) if discard || optional => {
                    runs.truncate(start);
                    current.clear();
                }
                _ => runs.push(std::mem::take(&mut current)),
            }
            i += 1;
            continue;
        }
        // A quantifier applies to the character before it, which is therefore
        // not required — and the count inside the braces is not text to match.
        if ch == '{' {
            current.pop();
            runs.push(std::mem::take(&mut current));
            i = skip_to(&chars, i, '}');
            continue;
        }
        if matches!(ch, '?' | '*' | '+') {
            current.pop();
            runs.push(std::mem::take(&mut current));
            i += 1;
            continue;
        }
        if matches!(ch, '}' | ']' | '|' | '.' | '^' | '$') {
            runs.push(std::mem::take(&mut current));
            i += 1;
            continue;
        }
        current.push(ch);
        i += 1;
    }
    runs.push(current);
    runs.retain(|r| r.chars().count() >= 3);
    runs
}

/// One past the closing delimiter, or the end of the pattern when there is
/// none. An unterminated `[` is a malformed regex the matcher will reject; the
/// planner's only job is to avoid inventing requirements from it.
fn skip_to(chars: &[char], from: usize, close: char) -> usize {
    let mut i = from + 1;
    while i < chars.len() {
        if chars[i] == '\\' {
            i += 2;
            continue;
        }
        if chars[i] == close {
            return i + 1;
        }
        i += 1;
    }
    chars.len()
}

pub fn plan_for_literal(literal: &str) -> Plan {
    let trigrams = of(literal);
    if trigrams.is_empty() {
        Plan::All
    } else {
        Plan::And(trigrams)
    }
}

pub fn plan_for_regex(pattern: &str) -> Plan {
    if pattern.contains('|') {
        let branches: Vec<Plan> = pattern.split('|').map(plan_for_regex).collect();
        // One branch that can match anywhere makes the whole union unbounded.
        if branches.iter().any(|b| matches!(b, Plan::All)) {
            return Plan::All;
        }
        return Plan::Or(branches);
    }
    let runs = literal_runs(pattern);
    match runs.iter().max_by_key(|r| r.len()) {
        None => Plan::All,
        Some(longest) => plan_for_literal(longest),
    }
}
