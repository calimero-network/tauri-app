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
use std::io::{self, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// Roll the active file once it grows past this size.
pub const SEGMENT_BYTES: u64 = 10 * 1024 * 1024; // 10 MB
/// Keep at most this many rotated segments (`merod.log.1` .. `merod.log.N`).
/// With the active file that is `MAX_SEGMENTS + 1` files ≈ 100 MB total.
pub const MAX_SEGMENTS: u32 = 9;
/// Rotated segments older than this are removed on cleanup.
pub const RETENTION_DAYS: u64 = 14;
/// Upper bound on bytes read from any single file when tailing.
const TAIL_READ_CAP_BYTES: u64 = SEGMENT_BYTES; // one full segment, so an older segment is never read half-way

const ACTIVE_NAME: &str = "merod.log";

fn active_path(dir: &Path) -> PathBuf {
    dir.join(ACTIVE_NAME)
}

fn seg_path(dir: &Path, n: u32) -> PathBuf {
    dir.join(format!("{}.{}", ACTIVE_NAME, n))
}

fn parse_segment_index(name: &str) -> Option<u32> {
    name.strip_prefix(&format!("{}.", ACTIVE_NAME)).and_then(|rest| rest.parse::<u32>().ok())
}

/// Whether `path` is named like a log file this module manages (`merod.log` or
/// `merod.log.<N>`), matched case-insensitively since APFS/NTFS treat `MEROD.LOG` as `merod.log`.
fn is_log_file_name(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
        return false;
    };
    let name = name.to_ascii_lowercase(); // ACTIVE_NAME is already lowercase
    name == ACTIVE_NAME || parse_segment_index(&name).is_some()
}

/// `dest` resolved the way `File::create` would see it, or an error if it is a
/// symlink — refused outright since a dangling link can't be canonicalized safely.
fn resolved_dest(dest: &Path) -> io::Result<PathBuf> {
    // symlink_metadata does not follow the link, so this sees dangling ones too.
    if dest
        .symlink_metadata()
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "cannot export to a symlink — pick a regular file",
        ));
    }
    Ok(dest.canonicalize().unwrap_or_else(|_| dest.to_path_buf()))
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
        let mut file = OpenOptions::new().create(true).append(true).open(&path)?;
        let mut len = file.metadata().map(|m| m.len()).unwrap_or(0);
        // A legacy, pre-rotation merod.log may already exceed the cap. Trim it to
        // its last segment on open so the active file honors segment_bytes right
        // away — otherwise the first roll would rename the whole oversized file to
        // merod.log.1, leaving disk use far above the advertised ~100 MB until it
        // ages out over many rotations.
        if len > segment_bytes {
            let _ = file.flush();
            let kept = tail_bytes_raw(&path, segment_bytes)?;
            let mut wf = OpenOptions::new().write(true).truncate(true).open(&path)?;
            wf.write_all(&kept)?;
            wf.flush()?;
            file = OpenOptions::new().create(true).append(true).open(&path)?;
            len = kept.len() as u64;
        }
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

/// Every `merod.log[.N]` entry in `dir`, with `None` marking the active file.
fn segments(dir: &Path) -> io::Result<Vec<(Option<u32>, PathBuf)>> {
    let mut out = Vec::new();
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        if name == ACTIVE_NAME {
            out.push((None, path));
        } else if let Some(idx) = parse_segment_index(name) {
            out.push((Some(idx), path));
        }
    }
    Ok(out)
}

/// Delete every rotated segment in `dir`; returns how many were removed.
fn remove_rotated_segments(dir: &Path) -> usize {
    let Ok(found) = segments(dir) else {
        return 0;
    };
    found
        .into_iter()
        .filter(|(idx, _)| idx.is_some())
        .filter(|(_, path)| fs::remove_file(path).is_ok())
        .count()
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

    for (idx, path) in segments(dir)? {
        // Segments past the retained count go immediately.
        if let Some(idx) = idx {
            if idx > max_segments {
                let _ = fs::remove_file(&path);
                continue;
            }
        }
        // Age out old rotated segments (never the live file).
        if idx.is_some() {
            if let Ok(modified) = path.metadata().and_then(|m| m.modified()) {
                if now.duration_since(modified).map(|age| age > retention).unwrap_or(false) {
                    let _ = fs::remove_file(&path);
                }
            }
        }
    }
    Ok(())
}

/// Truncate the active file and remove rotated segments; returns the count removed.
/// Use only when no live writer exists for this node — a running node should clear through [`RollingLogWriter::clear`] instead, to stay serialized with its drain task.
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

/// Every `merod.log[.N]` file in `dir`, oldest -> newest (active last). Errors
/// rather than returning an empty list, since `export_logs` treats this as authoritative.
fn ordered_paths_oldest_first(dir: &Path) -> io::Result<Vec<PathBuf>> {
    let mut segs = segments(dir)?;
    // Descending index == ascending age-of-newest-line: merod.log.9 is oldest;
    // `None` (active) sorts last, since it has no index to compare.
    segs.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(segs.into_iter().map(|(_, p)| p).collect())
}

/// Concatenate a node's entire retained log history into `dest`, oldest line
/// first, streamed in chunks so a ~100 MB export never buffers in memory.
pub fn export_logs(dir: &Path, dest: &Path) -> io::Result<u64> {
    // `File::create` truncates, so refuse a destination matching any node's log
    // name (case-insensitively) or falling inside this node's own logs dir.
    let probe = resolved_dest(dest)?;
    if is_log_file_name(&probe) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "cannot export over a merod log file — pick a different name",
        ));
    }
    // Anything inside the source node's own logs dir, whatever it is named: that
    // is the file set we are about to read.
    if let Some(parent) = probe.parent() {
        let same_dir = match (parent.canonicalize(), dir.canonicalize()) {
            (Ok(a), Ok(b)) => a == b,
            _ => parent == dir,
        };
        if same_dir {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "cannot export into the node's own logs directory",
            ));
        }
    }

    // Scan before creating `dest`, so a failed scan doesn't leave a stray empty
    // file where the user expected their logs.
    let paths = ordered_paths_oldest_first(dir)?;
    let mut out = BufWriter::new(File::create(dest)?);
    let mut total: u64 = 0;

    for path in &paths {
        let mut f = match File::open(path) {
            Ok(f) => f,
            // Rotated out from under us between listing and open — skip it.
            Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e),
        };
        let name = path.file_name().and_then(|s| s.to_str()).unwrap_or(ACTIVE_NAME);
        let size = f.metadata().map(|m| m.len()).unwrap_or(0);
        // `#` so the banner is obviously not a merod log line and greps skip it.
        let banner = format!("# ===== {} ({} bytes) =====\n", name, size);
        out.write_all(banner.as_bytes())?;
        total += banner.len() as u64;
        total += io::copy(&mut f, &mut out)?;
        // Segments are byte streams, not guaranteed to end on a line boundary;
        // separate them so the next banner can't be glued onto a partial line.
        if size > 0 {
            out.write_all(b"\n")?;
            total += 1;
        }
    }

    if paths.is_empty() {
        let note = b"# (no logs recorded for this node)\n";
        out.write_all(note)?;
        total += note.len() as u64;
    }

    out.flush()?;
    Ok(total)
}

/// Read up to `max_lines` trailing lines across the active file and rotated
/// segments (newest first), reading at most `TAIL_READ_CAP_BYTES` from any single
/// file. Returns the lines joined oldest→newest.
pub fn read_tail(dir: &Path, max_lines: usize) -> io::Result<String> {
    if max_lines == 0 || !dir.exists() {
        return Ok(String::new());
    }
    // Newest -> oldest: merod.log, merod.log.1, merod.log.2, ...
    let mut segs = segments(dir)?;
    segs.sort_by(|a, b| a.0.cmp(&b.0));
    let paths = segs.into_iter().map(|(_, p)| p);

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

/// Read at most `max_bytes` from the end of `path`, decoded lossily, dropping a
/// leading partial line when we started mid-file.
fn read_tail_bytes(path: &Path, max_bytes: u64) -> io::Result<String> {
    Ok(String::from_utf8_lossy(&tail_bytes_raw(path, max_bytes)?).into_owned())
}

/// Read at most `max_bytes` of raw bytes from the end of `path`, dropping a
/// leading partial line when we started mid-file. Byte-exact (no lossy decode) —
/// used to trim an oversized active file in place on open.
fn tail_bytes_raw(path: &Path, max_bytes: u64) -> io::Result<Vec<u8>> {
    let mut f = File::open(path)?;
    let len = f.metadata()?.len();
    let start = len.saturating_sub(max_bytes);
    f.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::with_capacity((len - start) as usize);
    f.read_to_end(&mut buf)?;
    if start > 0 {
        if let Some(nl) = buf.iter().position(|&b| b == b'\n') {
            buf.drain(..=nl);
        }
    }
    Ok(buf)
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
    fn oversized_legacy_active_file_is_trimmed_on_open() {
        let dir = tmp();
        // A pre-rotation merod.log larger than a segment.
        {
            let mut f = File::create(active_path(&dir)).unwrap();
            f.write_all(&vec![b'x'; 250]).unwrap();
            f.write_all(b"\nKEEP\n").unwrap();
        }
        let _w = RollingLogWriter::open_with(&dir, 100, 5).unwrap();
        let active_len = active_path(&dir).metadata().unwrap().len();
        assert!(active_len <= 100, "legacy active file should be trimmed to <= segment, got {active_len}");
        // The most recent content survives, older overflow is dropped.
        assert_eq!(read_tail(&dir, 10).unwrap(), "KEEP");
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
    fn export_concatenates_every_segment_oldest_first() {
        let dir = tmp();
        let mut w = RollingLogWriter::open_with(&dir, 40, 5).unwrap();
        for i in 0..30 {
            w.write_line(format!("line{:02}\n", i).as_bytes()).unwrap();
        }
        assert!(seg_path(&dir, 1).exists(), "test needs at least one rotation");

        let dest = dir.parent().unwrap().join(format!("export_{}.txt", std::process::id()));
        let written = export_logs(&dir, &dest).unwrap();
        let text = fs::read_to_string(&dest).unwrap();
        assert_eq!(written, text.len() as u64);

        // Every line survives the export, in write order — unlike read_tail, which
        // only ever returns the trailing slice.
        let logged: Vec<&str> = text.lines().filter(|l| !l.starts_with('#')).filter(|l| !l.is_empty()).collect();
        assert_eq!(logged.len(), 30, "all 30 lines must be exported, got {:?}", logged);
        assert_eq!(logged[0], "line00");
        assert_eq!(*logged.last().unwrap(), "line29");
        // Banners name each source file.
        assert!(text.contains("# ===== merod.log.1"));
        assert!(text.contains("# ===== merod.log ("));

        fs::remove_file(&dest).ok();
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn export_of_empty_dir_writes_a_note_not_an_error() {
        let dir = tmp();
        let dest = dir.parent().unwrap().join(format!("export_empty_{}.txt", std::process::id()));
        export_logs(&dir, &dest).unwrap();
        assert!(fs::read_to_string(&dest).unwrap().contains("no logs recorded"));
        fs::remove_file(&dest).ok();
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn export_refuses_to_write_into_the_log_dir() {
        let dir = tmp();
        let mut w = RollingLogWriter::open(&dir).unwrap();
        w.write_line(b"keep me\n").unwrap();
        // Picking the active log itself as the destination must not truncate it.
        let err = export_logs(&dir, &active_path(&dir)).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
        assert_eq!(read_tail(&dir, 10).unwrap(), "keep me");
        // Any other path in the same dir is refused too.
        assert!(export_logs(&dir, &dir.join("dump.txt")).is_err());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn export_of_an_unscannable_dir_errors_instead_of_writing_a_partial_file() {
        let dir = tmp();
        fs::remove_dir_all(&dir).ok(); // dir cannot be scanned
        let dest = dir.parent().unwrap().join(format!("export_bad_{}.txt", std::process::id()));
        fs::remove_file(&dest).ok();
        // A silently-empty export is the worst outcome here: it looks like a
        // successful save of a node that happened to have no logs.
        assert!(export_logs(&dir, &dest).is_err());
        assert!(!dest.exists(), "a failed scan must not leave a stray file behind");
    }

    #[test]
    fn export_refuses_a_differently_cased_log_name() {
        // APFS and NTFS are case-insensitive by default, so MEROD.LOG opens the
        // same file as merod.log. The name check has to match that, or the guard
        // is absent on the two platforms this app actually ships to.
        let source = tmp();
        let other = tmp();
        let mut w = RollingLogWriter::open(&other).unwrap();
        w.write_line(b"other node\n").unwrap();

        for name in ["MEROD.LOG", "Merod.Log", "merod.LOG.1", "MEROD.log.2"] {
            let err = export_logs(&source, &other.join(name)).unwrap_err();
            assert_eq!(err.kind(), io::ErrorKind::InvalidInput, "name {name}");
        }
        assert_eq!(read_tail(&other, 10).unwrap(), "other node");
        fs::remove_dir_all(&source).ok();
        fs::remove_dir_all(&other).ok();
    }

    #[cfg(unix)]
    #[test]
    fn export_refuses_a_symlink_pointing_at_a_log() {
        // File::create follows symlinks, so an innocuous *name* is no guarantee:
        // judging the literal path would truncate the target the link resolves to.
        let source = tmp();
        let other = tmp();
        let mut w = RollingLogWriter::open(&other).unwrap();
        w.write_line(b"precious history\n").unwrap();

        let link = source.parent().unwrap().join(format!("export_link_{}.txt", std::process::id()));
        fs::remove_file(&link).ok();
        std::os::unix::fs::symlink(active_path(&other), &link).unwrap();

        let err = export_logs(&source, &link).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
        assert_eq!(read_tail(&other, 10).unwrap(), "precious history");

        fs::remove_file(&link).ok();
        fs::remove_dir_all(&source).ok();
        fs::remove_dir_all(&other).ok();
    }

    #[test]
    fn export_survives_a_gap_in_segment_numbering() {
        let dir = tmp();
        // Age-based cleanup can delete .2 while leaving .3 — walking 1..N upward
        // would stop at the gap and silently drop the older half of the history.
        for k in [1u32, 3] {
            let mut f = File::create(seg_path(&dir, k)).unwrap();
            writeln!(f, "seg{}", k).unwrap();
        }
        let mut f = File::create(active_path(&dir)).unwrap();
        writeln!(f, "active").unwrap();
        drop(f);

        let dest = dir.parent().unwrap().join(format!("export_gap_{}.txt", std::process::id()));
        export_logs(&dir, &dest).unwrap();
        let text = fs::read_to_string(&dest).unwrap();
        let logged: Vec<&str> = text.lines().filter(|l| !l.starts_with('#') && !l.is_empty()).collect();
        assert_eq!(logged, vec!["seg3", "seg1", "active"]);
        fs::remove_file(&dest).ok();
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
