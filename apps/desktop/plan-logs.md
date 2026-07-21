# Plan: Node log rotation, size cap, cleanup & viewer performance

**Scope:** the Calimero Desktop app (`apps/desktop`) and how it captures, stores, reads
and displays a merod node's logs.

**Goal (from the request):** _"Cleanup and cap the logs — logs should be rotated and
also cleaned up."_ Concretely:

1. Hard-cap on-disk logs at **~100 MB per node** (configurable).
2. **Rotate** the active log into numbered segments instead of one unbounded file.
3. **Delete** old segments (and stale per-node log dirs) automatically.
4. Make the **Nodes-tab log viewer** fast even when a node has logged a lot.

> **Status (this PR):** the core of the plan is now **implemented** — 100 MB cap,
> rotation, startup cleanup, a bounded tail read, a `clear_merod_logs` command, and a
> faster viewer. What's implemented vs. deferred is called out inline with
> **✅ Implemented** / **⏭️ Deferred** tags. The deferred items (incremental
> `get_merod_logs_since` live-tail, DOM virtualization library, Settings knobs,
> Download-full-log) are follow-ups, not required for the cap/cleanup goal.

### Implemented in this PR
- `src-tauri/src/log_rotation.rs` — `RollingLogWriter` (10 MB segments × up to 10 files
  ≈ 100 MB), `cleanup_logs`, `clear_logs`, bounded `read_tail`; 6 unit tests.
- `start_merod` now pipes merod stdout/stderr and drains them into the rotating writer,
  and runs `cleanup_logs` before starting.
- `get_merod_logs` uses the bounded reverse tail (no more whole-file read).
- New `clear_merod_logs` Tauri command (+ `clearMerodLogs` in `utils/merod.ts`).
- `LogsViewer.tsx`: single split, debounced filter, DOM capped to the last 3 000 lines,
  ANSI conversion of only the rendered slice, pin-to-bottom auto-scroll, **Clear** button.

---

## 1. Current state (why it's a problem)

### 1a. Write path — one unbounded append file
- `start_merod` (`src-tauri/src/main.rs` ~L1143) creates
  `~/.calimero/<node>/logs/merod.log` with
  `OpenOptions::new().create(true).append(true)` (~L1310–1330) and hands the **raw
  file descriptor** to the child: `cmd.stdout(Stdio::from(log_file_stdout))` /
  `cmd.stderr(... try_clone())` (~L1355–1362), then `cmd.spawn()` (~L1365).
- Verbosity is set by the `debugLogs` setting → `RUST_LOG=debug|info` (~L1339–1344).
  Debug mode fills the file **much** faster.
- **There is no rotation, size check, or cleanup anywhere** (confirmed: no
  `set_len`/`metadata(size)`/`rotate` logic touches `merod.log`). The file only ever
  disappears when the whole data dir is nuked (`delete_calimero_data_dir`, ~L2533).

> **Key constraint:** merod owns the FD and writes to it directly. The app never sees
> the byte stream. Any rotation strategy has to account for a live writer holding the
> file open (see §2).

### 1b. Read path — reads the entire file to return 500 lines
- `get_merod_logs(node_name, home_dir, lines)` (`main.rs` ~L2376–2421):
  ```rust
  let lines = lines.unwrap_or(500).min(10_000);
  let content = tokio::fs::read_to_string(&log_path).await?;   // WHOLE file into RAM
  let all_lines: Vec<&str> = content.lines().collect();         // Vec of every line
  let start = all_lines.len().saturating_sub(lines as usize);
  Ok(all_lines[start..].join("\n"))
  ```
  At 100 MB this reads 100 MB into memory and allocates a vector of every line just to
  keep the last 500. This is the main backend scaling pain.

### 1c. Frontend viewer — full blob, not virtualized, manual refresh
- `src/pages/NodeManagement.tsx`: `handleViewLogs` / `handleRefreshLogs` (~L265–297)
  call `getMerodLogs(node, homeDir, 500)` and store the whole string in `logsContent`;
  rendered by `<LogsViewer content={logsContent} />` (~L585). **No polling.**
- `src/components/LogsViewer.tsx`:
  - `content.split("\n")` + `.filter()` on **every render / keystroke** (~L40–55).
  - Converts the entire joined text to one HTML string via `ansi-to-html` (~L57–71)
    and dumps it with `dangerouslySetInnerHTML` into a single scroll div (~L169–177) —
    **every line lives in the DOM, no virtualization**.
  - Counts lines with a third `split("\n")` in the footer (~L180).
- Util layer: `src/utils/merod.ts` — `startMerod(...)` (~L31) and
  `getMerodLogs(nodeName, homeDir?, lines?)` (~L116). No clear/download/rotate helpers.

---

## 2. Backend: rotation + 100 MB cap + cleanup

Two viable strategies. **Recommended: Strategy B** (pipe interposition) because it gives
true rotation without racing a live writer; **Strategy A** (copytruncate) is a smaller
change if we want a first cut.

### Strategy A — copytruncate (smallest change)
Keep giving merod the FD, and run a periodic capper.

- Add a Tauri-side background task (per running node) that every ~30 s checks
  `fs::metadata(merod.log).len()`. When it exceeds the segment size (e.g. 10 MB):
  1. copy the current tail to `merod.log.1` (shift existing `.1→.2 … .N-1→.N`, drop `.N`),
  2. `File::options().write(true).open(merod.log)?.set_len(0)` to truncate in place.
- Because merod holds an `O_APPEND` fd, after `set_len(0)` the next write lands at
  offset 0 — **no node restart needed**.
- Retention = keep `merod.log` + up to 9 rotated segments × 10 MB ≈ **100 MB**.
- **Downside:** a tiny race — log lines written between "copy" and "truncate" can be
  lost. Acceptable for diagnostics; keep the window small (truncate immediately after
  copy). Document it.

### Strategy B — interpose a rotating writer (recommended) — ✅ Implemented
_This is the strategy that shipped (`log_rotation::RollingLogWriter` + `spawn_log_drain`)._

Stop handing merod the file FD; drain its streams and write through a size-capped
rotating sink.

- Spawn with `Stdio::piped()` for stdout+stderr instead of `Stdio::from(file)`
  (`main.rs` ~L1355–1362).
- Spawn one async drain task per stream (`tokio::io::BufReader::lines()`), forwarding
  into a shared `LogRotator` (behind a `Mutex`/`mpsc`):
  ```rust
  struct LogRotator { dir: PathBuf, active: File, active_len: u64,
                      segment_bytes: u64 /*10MB*/, max_segments: u8 /*10*/ }
  impl LogRotator {
      fn write_line(&mut self, line: &str) -> io::Result<()> {
          let buf = /* line + '\n' */;
          if self.active_len + buf.len() as u64 > self.segment_bytes { self.roll()?; }
          self.active.write_all(buf)?; self.active_len += buf.len() as u64; Ok(())
      }
      fn roll(&mut self) -> io::Result<()> {
          // merod.log.(N-1) -> merod.log.N (drop oldest), merod.log -> merod.log.1,
          // reopen a fresh merod.log; enforce max_segments (= 100MB / segment_bytes).
      }
  }
  ```
- Total cap = `segment_bytes * max_segments` = **100 MB** (10 × 10 MB).
- **Trade-off:** the app must keep draining or a full pipe can block merod. Mitigate:
  bounded channel + drop-oldest on overflow, and ensure the drain task lives as long as
  the child. This is the same pattern `tracing-appender`'s rolling file appender uses;
  we can also just depend on `tracing-appender` (`RollingFileAppender` + a size guard)
  rather than hand-rolling `roll()`.

### Cleanup (both strategies)
- **On `start_merod`:** before spawning, scan `~/.calimero/<node>/logs/`:
  - delete rotated segments beyond `max_segments`,
  - delete any `merod.log*` older than a retention window (e.g. 14 days),
  - enforce the 100 MB total (delete oldest segments until under cap).
- **New Tauri command `clear_merod_logs(node_name, home_dir)`** — truncate the active
  file and remove rotated segments (wired to a "Clear logs" button, §4).
- Optional: a global sweep on app startup across all `~/.calimero/*/logs` dirs.

### Config — ⏭️ Deferred
- Currently the cap/retention are constants in `log_rotation.rs` (`SEGMENT_BYTES` 10 MB,
  `MAX_SEGMENTS` 9 ⇒ ~100 MB, `RETENTION_DAYS` 14). Optional follow-up: surface
  `logMaxMb` / `logRetentionDays` in `Settings` (`src/utils/settings.ts`) and thread them
  into `start_merod`. Not required for the cap/cleanup goal.

---

## 3. Backend read path: tail without reading the whole file — ✅ tail / ⏭️ since-API

Replace the `read_to_string`-everything in `get_merod_logs` (`main.rs` ~L2403–2418) with
a **bounded reverse tail**:

- ✅ Implemented as `log_rotation::read_tail`: reads at most `TAIL_READ_CAP_BYTES` (4 MB)
  from the **end** of each file, walking segments newest→oldest until it has `lines`
  lines. Cost is O(tail), and it's safe against a legacy huge `merod.log`.
- ⏭️ **Deferred** — incremental API for live-tail: `get_merod_logs_since(node, home_dir, offset)`
  returning `{ bytes, next_offset }` (only data written since `offset`). This is what the
  viewer polls (§4) instead of re-pulling the whole tail. Handle truncation/rotation by
  detecting `current_len < offset` → reset to a fresh tail.

---

## 4. Frontend viewer optimization (`LogsViewer.tsx` + `NodeManagement.tsx`)

- ✅ **Hard-cap the DOM** to the last `MAX_RENDERED_LINES` (3 000) with a "N older lines
  hidden" banner. (⏭️ full windowed virtualization via a library is a further follow-up.)
- ✅ **Split once, memoize:** `allLines` is derived from `content` a single time and reused
  by the filter, the render slice and the footer count (was three separate `split("\n")`).
- ✅ **Debounce** the filter input (150 ms).
- ✅ **ANSI conversion of only the rendered slice**, not the whole blob each render.
- ✅ **Auto-scroll only when pinned to bottom** (tracked via an `onScroll` handler) so it
  no longer yanks the view when the user scrolls up.
- ✅ **"Clear logs"** button → `clear_merod_logs` (via `clearMerodLogs` in `utils/merod.ts`).
- ⏭️ **Deferred** — live-tail polling of the incremental API (§3); **"Download full log"**
  button.

---

## 5. File-by-file change list

| Area | File | Change |
|------|------|--------|
| Spawn / rotation | `src-tauri/src/main.rs` (`start_merod` ~L1143–1365) | Strategy A capper task or Strategy B piped drain + `LogRotator`; startup cleanup |
| Read/tail | `src-tauri/src/main.rs` (`get_merod_logs` ~L2376–2421) | Bounded reverse tail; add `get_merod_logs_since`; add `clear_merod_logs`; register in `invoke_handler` (~L2034) |
| Utils | `src/utils/merod.ts` (~L116) | Add `getMerodLogsSince`, `clearMerodLogs`; pass log-cap args to `startMerod` |
| Viewer | `src/components/LogsViewer.tsx` | Virtualize, single split, debounce, per-line memo, live-tail, pin-to-bottom, Clear/Download |
| Page | `src/pages/NodeManagement.tsx` (~L265–297, L585) | Wire live-tail polling + Clear/Download; stop refetching full tail |
| Settings | `src/utils/settings.ts` (~L12/L89), `src/pages/Settings.tsx` | Optional `logMaxMb` / `logRetentionDays` + note that debug logs fill faster |

---

## 6. Risks & decisions

- **Live writer vs rotation** (§2): Strategy A can lose a few lines at truncation;
  Strategy B is clean but the drain task must never stall merod (bounded channel,
  drop-oldest). **Recommendation: Strategy B** for correctness; fall back to A if the
  drain plumbing proves fiddly.
- **Cross-platform:** `set_len`/rename semantics differ on Windows (can't rename a file
  with an open handle). Strategy B avoids this entirely because the app owns the file
  handles, not merod — another reason to prefer B.
- **Existing giant `merod.log`:** the startup cleanup + first rotation will bring legacy
  100 MB+ files under cap; make sure the first `get_merod_logs` after upgrade uses the
  bounded tail so it doesn't choke on a pre-existing huge file.
- **debugLogs** stays a spawn-time `RUST_LOG` switch; the cap protects disk regardless.

---

## 7. Testing

- **Rust unit tests:** `LogRotator` rolls at the boundary, enforces `max_segments`,
  never exceeds 100 MB; reverse-tail returns the correct last-N across a segment
  boundary; `get_merod_logs_since` returns only new bytes and resets after rotation.
- **Manual/integration:** run a node in debug mode, generate >100 MB, confirm disk stays
  capped, segments rotate, oldest are deleted; open the viewer and confirm it stays
  responsive and live-tails.
- **Frontend:** LogsViewer renders a 50k-line fixture without freezing; filter debounces;
  auto-scroll only when pinned; Clear/Download work.
- **Regression:** existing `e2e/` suite (nodes / node-lifecycle / navigation) stays green.

---

## 8. Suggested rollout order

1. Backend bounded reverse tail for `get_merod_logs` (immediate viewer speed-up, low risk).
2. Rotation + 100 MB cap + startup cleanup (Strategy B) with defaults.
3. `clear_merod_logs` + `get_merod_logs_since` commands.
4. Frontend viewer: virtualize + single split + debounce.
5. Frontend live-tail polling + Clear/Download; optional Settings knobs.
