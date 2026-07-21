//! Size-capped, rotating log storage for a merod node.
//!
//! merod's stdout/stderr are drained by the app (see `start_merod`) and written
//! here line-by-line. The active file `merod.log` rolls to numbered segments
//! (`merod.log.1` .. `merod.log.N`) once it exceeds [`SEGMENT_BYTES`]; the oldest
//! segment beyond [`MAX_SEGMENTS`] is deleted, so total on-disk logs per node stay
//! at roughly `SEGMENT_BYTES * (MAX_SEGMENTS + 1)` ≈ 100 MB.
//!
//! Reads use a bounded tail so displaying logs never loads the whole history into
//! memory, even if a legacy pre-rotation `merod.log` is huge.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// Roll the active file once it grows past this size.
pub const SEGMENT_BYTES: u64 = 10 * 1024 * 1024; // 10 MB
/// Keep at most this many rotated segments (`merod.log.1` .. `merod.log.N`).
/// With the active file that is `MAX_SEGMENTS + 1` files ≈ 100 MB total.
pub const MAX_SEGMENTS: u32 = 9;
/// Rotated segments older than this are removed on cleanup.
pub const RETENTION_DAYS: u64 = 14;
/// Upper bound on bytes read from any single file when tailing. Kept at the
/// segment size so a properly-rotated segment (≤ SEGMENT_BYTES) is always read in
/// full — reading less than a whole file would skip its older half and leave a
/// silent chronological gap before the next (older) segment. A legacy
/// pre-rotation `merod.log` larger than this is still bounded to its last slice
/// (and gets brought under the cap on the next node start); since no older
/// segments exist in that case there is no misleading interleaving.
const TAIL_READ_CAP_BYTES: u64 = SEGMENT_BYTES; // 10 MB — one full segment

const ACTIVE_NAME: &str = "merod.log";

fn active_path(dir: &Path) -> PathBuf {
    dir.join(ACTIVE_NAME)
}

fn seg_path(dir: &Path, n: u32) -> PathBuf {
    dir.join(format!("{}.{}", ACTIVE_NAME, n))
}

/// Append-only writer for `merod.log` that rotates by size and enforces the cap.
pub struct RollingLogWriter {
    dir: PathBuf,
    // Option so roll() can drop the handle before renaming the active file —
    // Windows refuses to rename a file that still has an open handle.
    file: Option<File>,
    len: u64,
    segment_bytes: u64,
    max_segments: u32,
}

impl RollingLogWriter {
    /// Open (creating if needed) the active log file in `dir` with default limits.
    pub fn open(dir: &Path) -> io::Result<Self> {
        Self::open_with(dir, SEGMENT_BYTES, MAX_SEGMENTS)
    }

    pub fn open_with(dir: &Path, segment_bytes: u64, max_segments: u32) -> io::Result<Self> {
        fs::create_dir_all(dir)?;
        let path = active_path(dir);
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        let len = file.metadata().map(|m| m.len()).unwrap_or(0);
        Ok(Self {
            dir: dir.to_path_buf(),
            file: Some(file),
            len,
            segment_bytes,
            max_segments,
        })
    }

    /// The active file handle, reopening it if a prior roll left it closed.
    fn file_mut(&mut self) -> io::Result<&mut File> {
        if self.file.is_none() {
            self.file = Some(
                OpenOptions::new().create(true).append(true).open(active_path(&self.dir))?,
            );
        }
        Ok(self.file.as_mut().expect("just set"))
    }

    /// Append a chunk of raw log bytes, rotating first if it would push the active
    /// file over the segment size. A chunk larger than a whole segment (e.g. a
    /// newline-less blob) is split across segments so none exceeds the cap.
    pub fn write_line(&mut self, bytes: &[u8]) -> io::Result<()> {
        // Reconcile the cached length with the file's real size before any
        // rotation decision: `clear_logs` (the "Clear" button) may have
        // truncated the active file (set_len(0)) out from under us, which would
        // otherwise leave `self.len` stale-high and trigger a spurious early
        // roll. Only stat when we're at/over the limit, so the common path stays
        // syscall-free.
        if self.len + bytes.len() as u64 > self.segment_bytes {
            if let Ok(meta) = self.file_mut()?.metadata() {
                self.len = meta.len();
            }
        }

        let mut rest = bytes;
        while !rest.is_empty() {
            // Roll a non-empty segment before it would spill past the cap.
            // (Never roll an empty active file — that just makes empty segments.)
            if self.len > 0 && self.len + rest.len() as u64 > self.segment_bytes {
                self.roll()?;
            }
            let room = self.segment_bytes.saturating_sub(self.len);
            // If a single write is bigger than a whole segment, take one
            // segment's worth and loop (the next iteration rolls); otherwise
            // write it all.
            let take = if room > 0 && rest.len() as u64 > room {
                room as usize
            } else {
                rest.len()
            };
            self.file_mut()?.write_all(&rest[..take])?;
            self.len += take as u64;
            rest = &rest[take..];
        }
        Ok(())
    }

    /// Truncate the active file in place and delete rotated segments, resetting
    /// the in-memory length. Called on the *live* writer (under its lock) so a
    /// "Clear" can't race the drain tasks or desync the cached length. Returns
    /// how many rotated segments were removed.
    pub fn clear(&mut self) -> io::Result<usize> {
        {
            let f = self.file_mut()?;
            let _ = f.flush();
            f.set_len(0)?;
        }
        self.len = 0;
        Ok(remove_rotated_segments(&self.dir))
    }

    fn roll(&mut self) -> io::Result<()> {
        if let Some(f) = self.file.as_mut() {
            let _ = f.flush();
        }
        // Drop the oldest segment that would otherwise fall off the end.
        let oldest = seg_path(&self.dir, self.max_segments);
        if oldest.exists() {
            let _ = fs::remove_file(&oldest);
        }
        // Shift merod.log.k -> merod.log.(k+1), highest first.
        for k in (1..self.max_segments).rev() {
            let from = seg_path(&self.dir, k);
            if from.exists() {
                fs::rename(&from, seg_path(&self.dir, k + 1))?;
            }
        }
        // Close the active handle BEFORE renaming it: Windows refuses to rename a
        // file that still has an open handle, which would otherwise make the
        // rename fail and stall the drain once the segment fills.
        self.file = None;
        // merod.log -> merod.log.1, then reopen a fresh active file.
        let active = active_path(&self.dir);
        if active.exists() {
            fs::rename(&active, seg_path(&self.dir, 1))?;
        }
        self.file = Some(OpenOptions::new().create(true).append(true).open(&active)?);
        self.len = 0;
        Ok(())
    }
}

/// Delete `merod.log.1`, `.2`, … in order; returns how many were removed.
fn remove_rotated_segments(dir: &Path) -> usize {
    let mut removed = 0;
    let mut k = 1;
    loop {
        let p = seg_path(dir, k);
        if p.exists() {
            if fs::remove_file(&p).is_ok() {
                removed += 1;
            }
            k += 1;
        } else {
            break;
        }
    }
    removed
}

/// Delete rotated segments beyond `MAX_SEGMENTS`, drop rotated segments older than
/// `RETENTION_DAYS`, and enforce the total-size cap. Never touches the active file.
pub fn cleanup_logs(dir: &Path) -> io::Result<()> {
    cleanup_logs_with(dir, MAX_SEGMENTS, RETENTION_DAYS)
}

pub fn cleanup_logs_with(dir: &Path, max_segments: u32, retention_days: u64) -> io::Result<()> {
    if !dir.exists() {
        return Ok(());
    }
    let retention = Duration::from_secs(retention_days.saturating_mul(24 * 60 * 60));
    let now = SystemTime::now();

    for entry in fs::read_dir(dir)?.flatten() {
        let path = entry.path();
        let name = match path.file_name().and_then(|s| s.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        // Only ever manage our own files.
        let idx = match name.strip_prefix(&format!("{}.", ACTIVE_NAME)) {
            Some(rest) => rest.parse::<u32>().ok(),
            None => None,
        };
        let is_active = name == ACTIVE_NAME;
        if !is_active && idx.is_none() {
            continue; // not a merod.log[.N] file
        }
        // Segments past the retained count go immediately.
        if let Some(idx) = idx {
            if idx > max_segments {
                let _ = fs::remove_file(&path);
                continue;
            }
        }
        // Age out old rotated segments (never the live file).
        if !is_active {
            if let Ok(modified) = entry.metadata().and_then(|m| m.modified()) {
                if now.duration_since(modified).map(|age| age > retention).unwrap_or(false) {
                    let _ = fs::remove_file(&path);
                }
            }
        }
    }
    Ok(())
}

/// Truncate the active file and remove all rotated segments. Returns how many
/// rotated segments were removed. Safe to call whether or not a node is running:
/// the active file is truncated in place so a live writer keeps appending at 0.
/// Clear logs on disk when there is NO live writer for this node (node not
/// running). When a node IS running, clear through the live
/// [`RollingLogWriter::clear`] instead so the operation is serialized with the
/// drain tasks (no TOCTOU on the log dir, no cached-length desync).
pub fn clear_logs(dir: &Path) -> io::Result<usize> {
    if !dir.exists() {
        return Ok(0);
    }
    let active = active_path(dir);
    if active.exists() {
        OpenOptions::new().write(true).open(&active)?.set_len(0)?;
    }
    Ok(remove_rotated_segments(dir))
}

/// Read up to `max_lines` trailing lines across the active file and rotated
/// segments (newest first), reading at most `TAIL_READ_CAP_BYTES` from any single
/// file. Returns the lines joined oldest→newest.
pub fn read_tail(dir: &Path, max_lines: usize) -> io::Result<String> {
    if max_lines == 0 {
        return Ok(String::new());
    }
    // Newest -> oldest: merod.log, merod.log.1, merod.log.2, ...
    let mut paths: Vec<PathBuf> = Vec::new();
    let active = active_path(dir);
    if active.exists() {
        paths.push(active);
    }
    let mut k = 1;
    loop {
        let p = seg_path(dir, k);
        if p.exists() {
            paths.push(p);
            k += 1;
        } else {
            break;
        }
    }

    // Collect lines newest-first until we have enough.
    let mut rev: Vec<String> = Vec::with_capacity(max_lines.min(4096));
    for path in paths {
        let chunk = read_tail_bytes(&path, TAIL_READ_CAP_BYTES)?;
        for line in chunk.lines().rev() {
            rev.push(line.to_string());
            if rev.len() >= max_lines {
                break;
            }
        }
        if rev.len() >= max_lines {
            break;
        }
    }
    rev.reverse();
    Ok(rev.join("\n"))
}

/// Read at most `max_bytes` from the end of `path`, dropping a leading partial
/// line when we started mid-file so callers only ever see whole lines.
fn read_tail_bytes(path: &Path, max_bytes: u64) -> io::Result<String> {
    let mut f = File::open(path)?;
    let len = f.metadata()?.len();
    let start = len.saturating_sub(max_bytes);
    f.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::with_capacity((len - start) as usize);
    f.read_to_end(&mut buf)?;
    let text = String::from_utf8_lossy(&buf).into_owned();
    if start > 0 {
        // We began mid-file: discard the truncated first line.
        if let Some(nl) = text.find('\n') {
            return Ok(text[nl + 1..].to_string());
        }
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    fn tmp() -> PathBuf {
        let mut p = std::env::temp_dir();
        // Unique-ish without Date/rand: use a static counter.
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        p.push(format!("merod_logtest_{}_{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn writes_and_tails_lines() {
        let dir = tmp();
        let mut w = RollingLogWriter::open(&dir).unwrap();
        for i in 0..10 {
            w.write_line(format!("line {}\n", i).as_bytes()).unwrap();
        }
        let tail = read_tail(&dir, 3).unwrap();
        assert_eq!(tail, "line 7\nline 8\nline 9");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rolls_at_segment_boundary_and_caps_segments() {
        let dir = tmp();
        // Tiny limits: 100-byte segments, keep 2 rotated segments (+active = 3 files).
        let mut w = RollingLogWriter::open_with(&dir, 100, 2).unwrap();
        // Each line ~20 bytes; 60 lines => forces several rolls.
        for i in 0..60 {
            w.write_line(format!("log-entry-{:04}\n", i).as_bytes()).unwrap();
        }
        // Active + at most MAX_SEGMENTS rotated files exist; nothing beyond .2.
        assert!(active_path(&dir).exists());
        assert!(!seg_path(&dir, 3).exists(), "segment beyond cap must be deleted");
        // The most recent lines survive.
        let tail = read_tail(&dir, 1).unwrap();
        assert_eq!(tail, "log-entry-0059");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn tail_spans_rotated_segments() {
        let dir = tmp();
        let mut w = RollingLogWriter::open_with(&dir, 60, 5).unwrap();
        for i in 0..20 {
            w.write_line(format!("n{:02}\n", i).as_bytes()).unwrap();
        }
        // Ask for more lines than fit in the active segment — must read into .1/.2.
        let tail = read_tail(&dir, 8).unwrap();
        let got: Vec<&str> = tail.lines().collect();
        assert_eq!(got.len(), 8);
        assert_eq!(*got.last().unwrap(), "n19");
        assert_eq!(got[0], "n12");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn cleanup_removes_overflow_segments() {
        let dir = tmp();
        // Hand-create merod.log.1 .. merod.log.5
        for k in 1..=5 {
            let mut f = File::create(seg_path(&dir, k)).unwrap();
            writeln!(f, "seg {}", k).unwrap();
        }
        File::create(active_path(&dir)).unwrap();
        cleanup_logs_with(&dir, 2, 3650).unwrap(); // keep 2, no age-out
        assert!(seg_path(&dir, 1).exists());
        assert!(seg_path(&dir, 2).exists());
        assert!(!seg_path(&dir, 3).exists());
        assert!(!seg_path(&dir, 4).exists());
        assert!(!seg_path(&dir, 5).exists());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn clear_truncates_active_and_removes_segments() {
        let dir = tmp();
        let mut w = RollingLogWriter::open_with(&dir, 40, 5).unwrap();
        for i in 0..20 {
            w.write_line(format!("x{:02}\n", i).as_bytes()).unwrap();
        }
        assert!(seg_path(&dir, 1).exists());
        let removed = clear_logs(&dir).unwrap();
        assert!(removed >= 1);
        assert!(!seg_path(&dir, 1).exists());
        assert_eq!(active_path(&dir).metadata().unwrap().len(), 0);
        assert_eq!(read_tail(&dir, 100).unwrap(), "");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn tail_of_missing_dir_is_empty() {
        let dir = tmp();
        fs::remove_dir_all(&dir).ok();
        assert_eq!(read_tail(&dir, 10).unwrap(), "");
    }

    #[test]
    fn single_write_larger_than_segment_is_split_and_capped() {
        let dir = tmp();
        let mut w = RollingLogWriter::open_with(&dir, 10, 5).unwrap();
        // One 25-byte write, no newline, into 10-byte segments → must span
        // multiple files, none exceeding the cap, with no bytes lost.
        w.write_line(b"0123456789ABCDEFGHIJKLMNO").unwrap();
        assert!(active_path(&dir).metadata().unwrap().len() <= 10);
        let mut total = active_path(&dir).metadata().unwrap().len();
        let mut k = 1;
        loop {
            let p = seg_path(&dir, k);
            if p.exists() {
                let l = p.metadata().unwrap().len();
                assert!(l <= 10, "segment {k} exceeds cap: {l}");
                total += l;
                k += 1;
            } else {
                break;
            }
        }
        assert_eq!(total, 25, "no bytes may be lost across the split");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn writer_clear_resets_length_and_segments() {
        let dir = tmp();
        let mut w = RollingLogWriter::open_with(&dir, 30, 5).unwrap();
        for i in 0..10 {
            w.write_line(format!("line{:02}\n", i).as_bytes()).unwrap();
        }
        assert!(seg_path(&dir, 1).exists());
        let removed = w.clear().unwrap();
        assert!(removed >= 1);
        assert!(!seg_path(&dir, 1).exists());
        assert_eq!(active_path(&dir).metadata().unwrap().len(), 0);
        // A normal write right after clear must not spuriously roll (len reset).
        w.write_line(b"fresh\n").unwrap();
        assert!(!seg_path(&dir, 1).exists());
        assert_eq!(read_tail(&dir, 10).unwrap(), "fresh");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn write_after_external_clear_does_not_spuriously_roll() {
        let dir = tmp();
        let mut w = RollingLogWriter::open_with(&dir, 50, 5).unwrap();
        w.write_line(&vec![b'a'; 45]).unwrap(); // near the limit
        // The "Clear" button truncates the active file out from under the writer.
        clear_logs(&dir).unwrap();
        // A normal write must NOT roll — the file is actually empty now, so the
        // stale cached len (45) must be reconciled first.
        w.write_line(b"hello\n").unwrap();
        assert!(!seg_path(&dir, 1).exists(), "must not roll after an external clear");
        assert_eq!(read_tail(&dir, 10).unwrap(), "hello");
        fs::remove_dir_all(&dir).ok();
    }
}
