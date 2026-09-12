//! What belongs in the index.
//!
//! An index holding `node_modules` answers slowly and wrongly — the file you
//! meant is buried under ten thousand you did not. The rules are deliberately
//! the same list the TypeScript fallback uses, so the two engines index the
//! same tree and a search cannot find a file under one engine and miss it
//! under the other.

use std::path::{Path, PathBuf};
use walkdir::WalkDir;

use crate::ignore::{parse, Ignore};

pub const MAX_INDEXABLE_BYTES: u64 = 2 * 1024 * 1024;
pub const MAX_SEARCHABLE_BYTES: u64 = 10 * 1024 * 1024;

const SKIP_DIRS: &[&str] = &[
    ".git", ".hg", ".svn", "node_modules", ".venv", "venv", "__pycache__", ".mypy_cache",
    ".pytest_cache", ".ruff_cache", "dist", "build", "out", "target", ".next", ".nuxt",
    ".svelte-kit", ".turbo", ".cache", ".gradle", ".idea", ".vscode-test", "coverage",
    ".nyc_output", "vendor", "Pods", ".terraform",
];

const BINARY_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "avif", "tiff", "psd", "mp3", "mp4", "wav",
    "ogg", "flac", "avi", "mov", "mkv", "webm", "zip", "gz", "tgz", "bz2", "xz", "7z", "rar", "jar",
    "war", "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "exe", "dll", "so", "dylib", "bin",
    "o", "a", "lib", "obj", "pdb", "class", "pyc", "pyo", "wasm", "node", "ttf", "otf", "woff",
    "woff2", "eot", "db", "sqlite", "sqlite3", "pack", "idx",
];

#[derive(Debug)]
pub struct Found {
    pub rel: String,
    pub absolute: PathBuf,
    pub size: u64,
    pub mtime_ms: i64,
}

pub fn normalize(path: &str) -> String {
    path.replace('\\', "/").trim_start_matches("./").to_string()
}

pub fn relative(root: &Path, absolute: &Path) -> String {
    match absolute.strip_prefix(root) {
        Ok(rel) => normalize(&rel.to_string_lossy()),
        Err(_) => normalize(&absolute.to_string_lossy()),
    }
}

pub fn mtime_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn extension_of(path: &str) -> &str {
    let name = path.rsplit('/').next().unwrap_or(path);
    match name.rfind('.') {
        Some(dot) if dot > 0 => &name[dot + 1..],
        _ => "",
    }
}

/// Whether this file's *content* is worth putting in the trigram index.
pub fn index_content(rel: &str, size: u64) -> bool {
    if size == 0 || size > MAX_INDEXABLE_BYTES {
        return false;
    }
    let ext = extension_of(rel).to_ascii_lowercase();
    !BINARY_EXTENSIONS.contains(&ext.as_str())
}

/// A NUL byte in the first few kilobytes: cheaper and more reliable than
/// trusting an extension, since a `.dat` may be text and a `.txt` may not.
pub fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8192).any(|&b| b == 0)
}

pub fn collect(root: &Path, max_files: usize) -> Vec<Found> {
    // The repository's own rules, on top of the hard-coded list. Read once at
    // the root; see ignore.rs for why nested files are deliberately not.
    let ignore = Ignore::new(&std::fs::read_to_string(root.join(".gitignore"))
        .map(|text| parse(&text))
        .unwrap_or_default());

    let mut out = Vec::new();
    let walker = WalkDir::new(root)
        .max_depth(24)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            if entry.depth() == 0 {
                return true;
            }
            let name = entry.file_name().to_string_lossy();
            if entry.file_type().is_dir() {
                if SKIP_DIRS.contains(&name.as_ref()) {
                    return false;
                }
                // Refusing the directory here prunes the whole subtree, which
                // is both faster and the only way a `generated/` rule can mean
                // what it says.
                return ignore.is_empty() || !ignore.matches_dir(&relative(root, entry.path()));
            }
            name != ".DS_Store"
                && (ignore.is_empty() || !ignore.matches(&relative(root, entry.path())))
        });

    for entry in walker.flatten() {
        if out.len() >= max_files {
            break;
        }
        if !entry.file_type().is_file() {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let absolute = entry.path().to_path_buf();
        out.push(Found {
            rel: relative(root, &absolute),
            absolute,
            size: meta.len(),
            mtime_ms: mtime_ms(&meta),
        });
    }
    out
}
