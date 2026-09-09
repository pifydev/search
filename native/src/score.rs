//! Fuzzy path matching and ranking.
//!
//! `find` answers with everything matching a glob, in filesystem order. The
//! question people actually ask is "the auth route file — you know the one",
//! which needs two things a glob cannot give: a match that tolerates how
//! people type, and an order that puts the likely file first.
//!
//! The model is fff's — match quality, plus frecency, recency and git state —
//! and the constants are kept identical to the TypeScript fallback so the two
//! engines rank the same way. A user who loses the native binary should get a
//! slower search, not a differently-ordered one.

pub const BONUS_EXACT_FILENAME: i32 = 300;
pub const BONUS_EXACT_STEM: i32 = 200;
pub const BONUS_FILENAME_PREFIX: i32 = 120;
pub const BONUS_IN_FILENAME: i32 = 60;
pub const BONUS_CONSECUTIVE: i32 = 12;
pub const BONUS_BOUNDARY: i32 = 18;
pub const PENALTY_LEADING: i32 = 2;
pub const PENALTY_TYPO: i32 = 40;
pub const PENALTY_DEPTH: i32 = 3;

/// One wrong letter in four is a different mistake from one in twenty.
pub fn max_typos(query: &str) -> usize {
    (query.chars().count() / 4).clamp(2, 6)
}

pub fn recency_boost(mtime_ms: i64, now_ms: i64) -> i32 {
    if mtime_ms <= 0 {
        return 0;
    }
    let age = (now_ms - mtime_ms) / 1000;
    match age {
        a if a < 120 => 16,
        a if a < 900 => 8,
        a if a < 3_600 => 4,
        a if a < 86_400 => 2,
        a if a < 604_800 => 1,
        _ => 0,
    }
}

pub fn git_boost(status: &str) -> i32 {
    match status {
        "modified" => 24,
        "staged" => 20,
        "untracked" => 12,
        _ => 0,
    }
}

struct Match {
    positions: Vec<usize>,
    typos: usize,
}

/// Subsequence match within a typo budget. A skipped query character is the
/// typo — a slip or a transposition — and spending more than the budget means
/// this is simply not the file.
fn match_positions(haystack: &str, needle: &str, budget: usize) -> Option<Match> {
    let hay: Vec<char> = haystack.chars().flat_map(|c| c.to_lowercase()).collect();
    let need: Vec<char> = needle.chars().flat_map(|c| c.to_lowercase()).collect();
    let mut positions = Vec::with_capacity(need.len());
    let mut typos = 0usize;
    let mut at = 0usize;

    for &want in &need {
        match hay[at.min(hay.len())..].iter().position(|&c| c == want) {
            Some(offset) => {
                let found = at + offset;
                positions.push(found);
                at = found + 1;
            }
            None => {
                typos += 1;
                if typos > budget {
                    return None;
                }
            }
        }
    }
    if positions.is_empty() {
        return None;
    }
    Some(Match { positions, typos })
}

fn is_boundary(chars: &[char], index: usize) -> bool {
    if index == 0 {
        return true;
    }
    let prev = chars[index - 1];
    prev == '/' || prev == '_' || prev == '-' || prev == '.' || (prev.is_lowercase() && chars[index].is_uppercase())
}

pub struct Candidate<'a> {
    pub path: &'a str,
    pub frecency: i32,
    pub git: &'a str,
    pub mtime_ms: i64,
}

/// Score one candidate, or `None` when the query does not match it at all.
pub fn score(candidate: &Candidate, query: &str, now_ms: i64) -> Option<i32> {
    let base = candidate.frecency + git_boost(candidate.git) + recency_boost(candidate.mtime_ms, now_ms);
    if query.is_empty() {
        return Some(base);
    }

    let m = match_positions(candidate.path, query, max_typos(query))?;
    let chars: Vec<char> = candidate.path.chars().collect();

    let filename = candidate.path.rsplit('/').next().unwrap_or(candidate.path);
    let lower_name = filename.to_lowercase();
    let lower_query = query.to_lowercase();
    let stem = match lower_name.rfind('.') {
        Some(dot) if dot > 0 => &lower_name[..dot],
        _ => lower_name.as_str(),
    };

    let mut total = 0i32;
    if lower_name == lower_query {
        total += BONUS_EXACT_FILENAME;
    } else if stem == lower_query {
        total += BONUS_EXACT_STEM;
    } else if lower_name.starts_with(&lower_query) {
        total += BONUS_FILENAME_PREFIX;
    } else if lower_name.contains(&lower_query) {
        total += BONUS_IN_FILENAME;
    }

    for (i, &at) in m.positions.iter().enumerate() {
        if i > 0 && at == m.positions[i - 1] + 1 {
            total += BONUS_CONSECUTIVE;
        }
        if at < chars.len() && is_boundary(&chars, at) {
            total += BONUS_BOUNDARY;
        }
        if i == 0 {
            total -= (at.min(40) as i32) * PENALTY_LEADING;
        }
    }

    total -= (m.typos as i32) * PENALTY_TYPO;
    total -= (candidate.path.matches('/').count() as i32) * PENALTY_DEPTH;
    Some(total + base)
}
