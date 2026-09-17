//! The native core of `@pify/search`.
//!
//! An in-memory file index with a trigram index over contents, exposed to
//! Node through napi. It answers the same two questions as the TypeScript
//! fallback and gives the same answers — the scoring constants are copied
//! across deliberately, so losing the binary changes how fast a search is and
//! never how it is ordered.

#![deny(clippy::all)]

mod ignore;
mod score;
mod store;
mod trigram;
mod walk;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use rayon::prelude::*;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use trigram::{Index, Plan};

struct Entry {
    path: String,
    absolute: PathBuf,
    size: u64,
    mtime_ms: i64,
    /// A forgotten row is tombstoned rather than removed, so ids stay stable
    /// and `refresh` can revive the same slot instead of pushing a duplicate.
    /// find/grep/persist skip dead rows; reconcile can bring them back.
    alive: bool,
}

#[napi(object)]
pub struct FileHit {
    pub path: String,
    pub score: i32,
    pub size: f64,
    pub modified_ms: f64,
}

#[napi(object)]
pub struct ContentHit {
    pub path: String,
    pub line: u32,
    pub text: String,
}

#[napi(object)]
pub struct FindPage {
    pub items: Vec<FileHit>,
    pub total: u32,
    /// Offset for the next page, or -1 when this was the last.
    pub next: i32,
}

#[napi(object)]
pub struct GrepPage {
    pub items: Vec<ContentHit>,
    pub total: u32,
    pub next: i32,
    /// Files actually opened, so a caller can see the index doing its job.
    pub scanned: u32,
}

#[napi]
pub struct SearchIndex {
    root: PathBuf,
    entries: RwLock<Vec<Entry>>,
    by_path: RwLock<HashMap<String, u32>>,
    content: RwLock<Index>,
    frecency: RwLock<HashMap<String, i32>>,
    cache: Option<PathBuf>,
    /// The file cap, kept so reconcile() can re-walk with the same bound.
    max_files: usize,
    reused: u32,
    rebuilt: u32,
}

#[napi]
impl SearchIndex {
    /// Build the index. Walking and content extraction run in parallel;
    /// nothing is memory-mapped, so this behaves the same on every platform.
    #[napi(constructor)]
    pub fn new(root: String, max_files: Option<u32>, cache_path: Option<String>) -> Result<Self> {
        let root_path = PathBuf::from(&root);
        let cap = max_files.unwrap_or(200_000) as usize;
        let t0 = std::time::Instant::now();
        let found = walk::collect(&root_path, cap);
        let t_walk = t0.elapsed();

        // Anything the last run already extracted and that still looks the
        // same on disk is reused; only genuinely changed files are re-read.
        // That is the whole point of persisting — a session on a large tree
        // should pay for what changed, not for the tree.
        let cache = cache_path.as_ref().map(PathBuf::from);
        let t1 = std::time::Instant::now();
        let loaded = cache.as_ref().and_then(|p| store::load(p));
        let t_load = t1.elapsed();
        let had_cache = loaded.is_some();
        let mut known = loaded.map(store::index_by_path).unwrap_or_default();

        let mut entries = Vec::with_capacity(found.len());
        let mut by_path = HashMap::with_capacity(found.len());
        for (i, file) in found.iter().enumerate() {
            by_path.insert(file.rel.clone(), i as u32);
            entries.push(Entry {
                path: file.rel.clone(),
                absolute: file.absolute.clone(),
                size: file.size,
                mtime_ms: file.mtime_ms,
                alive: true,
            });
        }

        let mut reused = 0usize;
        let mut carried: Vec<(u32, Vec<u32>)> = Vec::new();
        let mut stale: Vec<(u32, &walk::Found)> = Vec::new();
        for (i, file) in found.iter().enumerate() {
            match known.remove(&file.rel) {
                Some(entry) if store::still_valid(&entry, file.size, file.mtime_ms) => {
                    reused += 1;
                    carried.push((i as u32, entry.trigrams));
                }
                _ => stale.push((i as u32, file)),
            }
        }

        // Reading and extracting is the expensive half and is embarrassingly
        // parallel; building the map from the results is not, so it is done
        // once at the end rather than behind a lock per file.
        let extracted: Vec<(u32, Vec<u32>)> = stale
            .par_iter()
            .filter_map(|(id, file)| {
                if !walk::index_content(&file.rel, file.size) {
                    return None;
                }
                let bytes = std::fs::read(&file.absolute).ok()?;
                if walk::looks_binary(&bytes) {
                    return None;
                }
                let mut set = std::collections::HashSet::with_hasher(trigram::BuildTrigramHasher);
                trigram::extract(&bytes, &mut set);
                let mut list: Vec<u32> = set.into_iter().collect();
                list.sort_unstable();
                Some((*id, list))
            })
            .collect();

        // Merged and sorted by id before insertion, which is not cosmetic:
        // posting lists are kept sorted, so adding files in ascending order
        // appends to each list, while the interleaved order that `carried` and
        // `extracted` arrive in would insert into the middle and memmove the
        // tail of every list it touches.
        let rebuilt = extracted.len() as u32;
        let mut all: Vec<(u32, Vec<u32>)> = carried;
        all.extend(extracted);
        all.sort_unstable_by_key(|(id, _)| *id);

        let t2 = std::time::Instant::now();
        let mut index = Index::new();
        for (id, trigrams) in &all {
            index.add(*id, trigrams);
        }
        let t_index = t2.elapsed();
        // Off unless asked for. The three phases have very different costs and
        // guessing which one dominates is how the first version of this spent
        // most of its time rebuilding an index it had just loaded.
        if std::env::var_os("PIFY_SEARCH_TIMING").is_some() {
            eprintln!("  walk {t_walk:?}  load {t_load:?}  invert {t_index:?}");
        }

        // Rewriting an unchanged index costs a full re-inversion and a
        // multi-megabyte write on every start, which on a large tree is most
        // of what reloading was supposed to save. Write only when the tree
        // actually moved: something re-read, something gone, or no cache yet.
        let vanished = !known.is_empty();
        let dirty = !had_cache || rebuilt > 0 || vanished;

        let this = Self {
            root: root_path,
            entries: RwLock::new(entries),
            by_path: RwLock::new(by_path),
            content: RwLock::new(index),
            frecency: RwLock::new(HashMap::new()),
            cache,
            max_files: cap,
            reused: reused as u32,
            rebuilt,
        };
        if dirty {
            this.persist();
        }
        Ok(this)
    }

    /// Write the index back, best effort. A cache that cannot be written costs
    /// the next session a rebuild, never this one a result.
    fn persist(&self) {
        let Some(path) = self.cache.as_ref() else { return };
        let (Ok(entries), Ok(index)) = (self.entries.read(), self.content.read()) else {
            return;
        };
        let mut by_file = index.by_file();
        let mut files = Vec::with_capacity(by_file.len());
        for (id, entry) in entries.iter().enumerate() {
            if !entry.alive {
                continue;
            }
            if let Some(trigrams) = by_file.remove(&(id as u32)) {
                files.push(store::StoredFile {
                    rel: entry.path.clone(),
                    size: entry.size,
                    mtime_ms: entry.mtime_ms,
                    trigrams,
                });
            }
        }
        let _ = store::save(path, &files);
    }

    /// How much of the last index survived, so the saving is observable.
    #[napi]
    pub fn reused_count(&self) -> u32 {
        self.reused
    }

    #[napi]
    pub fn rebuilt_count(&self) -> u32 {
        self.rebuilt
    }

    /// Flush the index to its cache file.
    #[napi]
    pub fn save(&self) {
        self.persist();
    }

    #[napi]
    pub fn file_count(&self) -> u32 {
        self.entries
            .read()
            .map(|e| e.iter().filter(|entry| entry.alive).count() as u32)
            .unwrap_or(0)
    }

    #[napi]
    pub fn indexed_count(&self) -> u32 {
        self.content.read().map(|c| c.len() as u32).unwrap_or(0)
    }

    /// Note that a path was used, so frecency can favour it later.
    #[napi]
    pub fn touch(&self, path: String) {
        let key = walk::normalize(&path);
        if let Ok(mut frecency) = self.frecency.write() {
            let entry = frecency.entry(key).or_insert(0);
            *entry = (*entry + 25).min(200);
        }
    }

    /// Re-read one path: a create or a modify. Removing is `forget`.
    #[napi]
    pub fn refresh(&self, path: String) -> Result<()> {
        let absolute = self.root.join(&path);
        let rel = walk::relative(&self.root, &absolute);
        let Ok(meta) = std::fs::metadata(&absolute) else {
            return Ok(());
        };
        if !meta.is_file() {
            return Ok(());
        }

        let id = {
            let mut by_path = self.by_path.write().map_err(lock_err)?;
            let mut entries = self.entries.write().map_err(lock_err)?;
            match by_path.get(&rel) {
                Some(&id) => {
                    if let Some(entry) = entries.get_mut(id as usize) {
                        entry.size = meta.len();
                        entry.mtime_ms = walk::mtime_ms(&meta);
                        // Reviving a row a forget() tombstoned, or refreshing a
                        // live one: either way this path is back on disk.
                        entry.alive = true;
                    }
                    id
                }
                None => {
                    let id = entries.len() as u32;
                    entries.push(Entry {
                        path: rel.clone(),
                        absolute: absolute.clone(),
                        size: meta.len(),
                        mtime_ms: walk::mtime_ms(&meta),
                        alive: true,
                    });
                    by_path.insert(rel.clone(), id);
                    id
                }
            }
        };

        let mut index = self.content.write().map_err(lock_err)?;
        if !walk::index_content(&rel, meta.len()) {
            index.remove(id);
            return Ok(());
        }
        match std::fs::read(&absolute) {
            Ok(bytes) if !walk::looks_binary(&bytes) => {
                let mut set = std::collections::HashSet::with_hasher(trigram::BuildTrigramHasher);
                trigram::extract(&bytes, &mut set);
                let mut list: Vec<u32> = set.into_iter().collect();
                list.sort_unstable();
                index.add(id, &list);
            }
            _ => index.remove(id),
        }
        Ok(())
    }

    #[napi]
    pub fn forget(&self, path: String) -> Result<()> {
        let rel = walk::normalize(&path);
        let id = { self.by_path.read().map_err(lock_err)?.get(&rel).copied() };
        if let Some(id) = id {
            // Drop the contents from the index, but tombstone the row rather
            // than deleting it: the id stays valid, and the by_path mapping is
            // kept so a later refresh of the same path revives this slot instead
            // of appending a second row that find() would then list twice.
            self.content.write().map_err(lock_err)?.remove(id);
            if let Some(entry) = self.entries.write().map_err(lock_err)?.get_mut(id as usize) {
                entry.alive = false;
            }
        }
        Ok(())
    }

    /// Re-walk the tree and reconcile the index against it: read files that are
    /// new or changed (by size+mtime, the rule the cache already trusts) and
    /// forget files that have vanished. This is how changes made by bash, a
    /// subagent or an external editor — none of which emit a per-file signal —
    /// reach the index without waiting for the next session's fresh walk.
    #[napi]
    pub fn reconcile(&self) -> Result<()> {
        let found = walk::collect(&self.root, self.max_files);
        let mut seen: HashSet<String> = HashSet::with_capacity(found.len());

        let mut to_refresh: Vec<String> = Vec::new();
        {
            let entries = self.entries.read().map_err(lock_err)?;
            let by_path = self.by_path.read().map_err(lock_err)?;
            for file in &found {
                seen.insert(file.rel.clone());
                let fresh = match by_path.get(&file.rel) {
                    Some(&id) => entries
                        .get(id as usize)
                        .map(|e| e.alive && e.size == file.size && e.mtime_ms == file.mtime_ms)
                        .unwrap_or(false),
                    None => false,
                };
                if !fresh {
                    to_refresh.push(file.rel.clone());
                }
            }
        }

        let to_forget: Vec<String> = {
            let entries = self.entries.read().map_err(lock_err)?;
            entries
                .iter()
                .filter(|e| e.alive && !seen.contains(&e.path))
                .map(|e| e.path.clone())
                .collect()
        };

        // Locks are released before these, since refresh/forget take their own.
        for rel in to_refresh {
            self.refresh(rel)?;
        }
        for rel in to_forget {
            self.forget(rel)?;
        }
        Ok(())
    }

    #[napi]
    pub fn find(&self, query: String, limit: u32, offset: u32, now_ms: f64) -> Result<FindPage> {
        let entries = self.entries.read().map_err(lock_err)?;
        let frecency = self.frecency.read().map_err(lock_err)?;
        let now = now_ms as i64;

        let mut scored: Vec<(i32, usize)> = entries
            .par_iter()
            .enumerate()
            .filter_map(|(i, entry)| {
                if !entry.alive {
                    return None;
                }
                let candidate = score::Candidate {
                    path: &entry.path,
                    frecency: frecency.get(&entry.path).copied().unwrap_or(0),
                    git: "",
                    mtime_ms: entry.mtime_ms,
                };
                score::score(&candidate, &query, now).map(|s| (s, i))
            })
            .collect();

        // Ties break on path so two runs of the same query agree.
        scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| entries[a.1].path.cmp(&entries[b.1].path)));

        let total = scored.len();
        let start = (offset as usize).min(total);
        let end = (start + limit as usize).min(total);
        let items = scored[start..end]
            .iter()
            .map(|&(s, i)| FileHit {
                path: entries[i].path.clone(),
                score: s,
                size: entries[i].size as f64,
                modified_ms: entries[i].mtime_ms as f64,
            })
            .collect();

        Ok(FindPage {
            items,
            total: total as u32,
            next: if end < total { end as i32 } else { -1 },
        })
    }

    /// `mode` is "literal", "regex" or "fuzzy".
    #[napi]
    pub fn grep(
        &self,
        pattern: String,
        mode: String,
        limit: u32,
        offset: u32,
        case_insensitive: bool,
    ) -> Result<GrepPage> {
        if pattern.is_empty() {
            return Ok(GrepPage { items: vec![], total: 0, next: -1, scanned: 0 });
        }
        let entries = self.entries.read().map_err(lock_err)?;
        let index = self.content.read().map_err(lock_err)?;

        // Fuzzy has no required substring, so the index cannot narrow it.
        // Saying so beats narrowing wrongly and losing matches.
        let plan = match mode.as_str() {
            "fuzzy" => Plan::All,
            "regex" => trigram::plan_for_regex(&pattern),
            _ => trigram::plan_for_literal(&pattern),
        };

        let ids: Vec<u32> = match index.candidates(&plan) {
            Some(mut list) => {
                // A text file kept out of the trigram index (too big to index,
                // or empty) is still searchable — the index may only narrow,
                // never hide. Union in every alive, non-binary-by-extension file
                // that is not indexed. Bounded, and the totals stay exact.
                for (i, entry) in entries.iter().enumerate() {
                    let id = i as u32;
                    if entry.alive && !index.contains(id) && !walk::is_binary_ext(&entry.path) {
                        list.push(id);
                    }
                }
                list.sort_unstable();
                list.dedup();
                list
            }
            None => (0..entries.len() as u32).collect(),
        };

        let needle = if case_insensitive { pattern.to_lowercase() } else { pattern.clone() };
        let budget = score::max_typos(&pattern);

        // Regex mode must actually run a regex. Falling back to `contains`
        // made `declared\w+` match nothing at all while reporting a clean
        // zero, which reads exactly like "this does not exist".
        let compiled = if mode == "regex" {
            match regex::RegexBuilder::new(&pattern)
                .case_insensitive(case_insensitive)
                .build()
            {
                Ok(re) => Some(re),
                Err(e) => return Err(Error::from_reason(format!("invalid regex: {e}"))),
            }
        } else {
            None
        };

        let mut hits: Vec<ContentHit> = ids
            .par_iter()
            .filter_map(|&id| {
                let entry = entries.get(id as usize)?;
                if !entry.alive || entry.size > walk::MAX_SEARCHABLE_BYTES {
                    return None;
                }
                let bytes = std::fs::read(&entry.absolute).ok()?;
                if walk::looks_binary(&bytes) {
                    return None;
                }
                let text = String::from_utf8_lossy(&bytes);
                let mut found = Vec::new();
                for (n, line) in text.lines().enumerate() {
                    let matched = match &compiled {
                        Some(re) => re.is_match(line),
                        None => {
                            let hay = if case_insensitive { line.to_lowercase() } else { line.to_string() };
                            if mode == "fuzzy" {
                                fuzzy_line(&hay, &needle, budget)
                            } else {
                                hay.contains(&needle)
                            }
                        }
                    };
                    if matched {
                        found.push(ContentHit {
                            path: entry.path.clone(),
                            line: (n + 1) as u32,
                            text: line.chars().take(400).collect(),
                        });
                    }
                }
                if found.is_empty() { None } else { Some(found) }
            })
            .flatten()
            .collect();

        hits.sort_by(|a, b| a.path.cmp(&b.path).then_with(|| a.line.cmp(&b.line)));

        let total = hits.len();
        let start = (offset as usize).min(total);
        let end = (start + limit as usize).min(total);
        Ok(GrepPage {
            items: hits.drain(..).skip(start).take(end - start).collect(),
            total: total as u32,
            next: if end < total { end as i32 } else { -1 },
            scanned: ids.len() as u32,
        })
    }
}

/// Characters in order, within the typo budget and close enough together to be
/// one word rather than three scattered letters.
fn fuzzy_line(hay: &str, needle: &str, budget: usize) -> bool {
    let hay: Vec<char> = hay.chars().collect();
    let need: Vec<char> = needle.chars().collect();
    if need.is_empty() {
        return false;
    }
    let span = (need.len() * 3).max(need.len() + 8);
    for start in 0..hay.len() {
        let mut typos = 0usize;
        let mut at = start;
        let mut matched = 0usize;
        for &want in &need {
            match hay[at.min(hay.len())..].iter().position(|&c| c == want) {
                Some(offset) if at + offset - start <= span => {
                    at += offset + 1;
                    matched += 1;
                }
                _ => {
                    typos += 1;
                    if typos > budget {
                        break;
                    }
                }
            }
        }
        if typos <= budget && matched + budget >= need.len() && matched > 0 {
            return true;
        }
    }
    false
}

fn lock_err<T>(_: T) -> Error {
    Error::from_reason("search index lock poisoned")
}

/// Exposed so the JavaScript side can assert the two engines agree.
#[napi]
pub fn literal_runs(pattern: String) -> Vec<String> {
    trigram::literal_runs(&pattern)
}

#[napi]
pub fn max_typos(query: String) -> u32 {
    score::max_typos(&query) as u32
}

#[allow(dead_code)]
fn unused(_: &Path) {}
