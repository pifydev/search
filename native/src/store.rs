//! Making the index outlive the process.
//!
//! An in-memory index is rebuilt every time pi starts. On this suite that
//! costs 33ms and nobody notices; on a hundred-thousand-file monorepo it is
//! seconds, paid again at every session, for a tree that has barely changed.
//! tgrep's answer is the whole reason it is fast in practice — build once,
//! persist, and on the next start reload and reconcile instead of rebuilding.
//!
//! The format is deliberately dull: a header, the file table, then the posting
//! lists, all little-endian. No mmap, because a memory-mapped file is a
//! different set of failure modes on every platform and the load is already
//! bounded by the disk read.
//!
//! Correctness rests on one rule. A stored entry is trusted only while its
//! size and mtime still match what is on disk; anything that differs, or is
//! new, or has vanished, is re-read before a query can see it. A stale index
//! that answers confidently is worse than no index at all.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::Path;

/// Bumped whenever the layout changes. A mismatch is not an error — it means
/// the cache is from another version and the tree is simply re-indexed.
const MAGIC: &[u8; 8] = b"PIFYSRC2";

pub struct StoredFile {
    pub rel: String,
    pub size: u64,
    pub mtime_ms: i64,
    pub trigrams: Vec<u32>,
}

fn write_u32(out: &mut impl Write, value: u32) -> std::io::Result<()> {
    out.write_all(&value.to_le_bytes())
}

/// Trigram lists are sorted, so the gaps between neighbours are far smaller
/// than the values themselves and a varint spends one or two bytes where a
/// fixed `u32` spends four. This is what decides whether persisting is worth
/// it at all: a cache that is larger than the source it summarises costs more
/// to read back than the rebuild it was meant to avoid.
fn write_varint(out: &mut impl Write, mut value: u32) -> std::io::Result<()> {
    let mut buf = [0u8; 5];
    let mut len = 0;
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        if value == 0 {
            buf[len] = byte;
            len += 1;
            break;
        }
        buf[len] = byte | 0x80;
        len += 1;
    }
    out.write_all(&buf[..len])
}

/// Decoding reads from a slice rather than a `Read`. The index is millions of
/// varints, and one `read_exact` per byte through a `BufReader` spends more
/// time in the reader than in the decode; the whole file is a handful of
/// megabytes, so it is simply read once and walked in memory.
struct Cursor<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Cursor<'a> {
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        let end = self.at.checked_add(n)?;
        let slice = self.bytes.get(self.at..end)?;
        self.at = end;
        Some(slice)
    }

    fn u32(&mut self) -> Option<u32> {
        Some(u32::from_le_bytes(self.take(4)?.try_into().ok()?))
    }

    fn u64(&mut self) -> Option<u64> {
        Some(u64::from_le_bytes(self.take(8)?.try_into().ok()?))
    }

    fn i64(&mut self) -> Option<i64> {
        Some(i64::from_le_bytes(self.take(8)?.try_into().ok()?))
    }

    fn varint(&mut self) -> Option<u32> {
        let mut value = 0u32;
        let mut shift = 0;
        loop {
            let byte = *self.bytes.get(self.at)?;
            self.at += 1;
            // Five groups of seven bits is the most a u32 can occupy; anything
            // longer is corruption, not a large number.
            if shift > 28 {
                return None;
            }
            value |= u32::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 {
                return Some(value);
            }
            shift += 7;
        }
    }
}

fn write_u64(out: &mut impl Write, value: u64) -> std::io::Result<()> {
    out.write_all(&value.to_le_bytes())
}

/// Write atomically: a half-written index that still has a valid header would
/// be loaded and believed, so the rename is what makes it safe.
pub fn save(path: &Path, files: &[StoredFile]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temp = path.with_extension("tmp");
    {
        let mut out = BufWriter::new(File::create(&temp)?);
        out.write_all(MAGIC)?;
        write_u32(&mut out, files.len() as u32)?;
        for file in files {
            let bytes = file.rel.as_bytes();
            write_u32(&mut out, bytes.len() as u32)?;
            out.write_all(bytes)?;
            write_u64(&mut out, file.size)?;
            out.write_all(&file.mtime_ms.to_le_bytes())?;
            write_u32(&mut out, file.trigrams.len() as u32)?;
            let mut previous = 0u32;
            for &t in &file.trigrams {
                write_varint(&mut out, t - previous)?;
                previous = t;
            }
        }
        out.flush()?;
    }
    std::fs::rename(&temp, path)
}

/// Load, or `None` for anything unreadable, truncated or from another version.
/// A cache is an optimisation; a broken one costs a rebuild and never a result.
pub fn load(path: &Path) -> Option<Vec<StoredFile>> {
    let bytes = std::fs::read(path).ok()?;
    let mut input = Cursor { bytes: &bytes, at: 0 };
    if input.take(MAGIC.len())? != MAGIC {
        return None;
    }

    let count = input.u32()? as usize;
    // A corrupt length field must not turn into a huge allocation.
    if count > 5_000_000 {
        return None;
    }
    let mut files = Vec::with_capacity(count.min(65_536));
    for _ in 0..count {
        let name_len = input.u32()? as usize;
        if name_len > 4096 {
            return None;
        }
        let rel = std::str::from_utf8(input.take(name_len)?).ok()?.to_string();
        let size = input.u64()?;
        let mtime_ms = input.i64()?;
        let trigram_count = input.u32()? as usize;
        if trigram_count > 4_000_000 {
            return None;
        }
        let mut trigrams = Vec::with_capacity(trigram_count.min(8192));
        let mut previous = 0u32;
        for _ in 0..trigram_count {
            previous = previous.checked_add(input.varint()?)?;
            trigrams.push(previous);
        }
        files.push(StoredFile { rel, size, mtime_ms, trigrams });
    }
    Some(files)
}

/// What a stored index still knows, keyed by path, so a walk can ask whether
/// each file it finds needs re-reading.
pub fn index_by_path(files: Vec<StoredFile>) -> HashMap<String, StoredFile> {
    let mut map = HashMap::with_capacity(files.len());
    for file in files {
        map.insert(file.rel.clone(), file);
    }
    map
}

/// A stored entry is only trusted while the file on disk still looks the same.
pub fn still_valid(stored: &StoredFile, size: u64, mtime_ms: i64) -> bool {
    stored.size == size && stored.mtime_ms == mtime_ms
}
