import { useState, useMemo, useRef, useEffect } from "react";
import { Search, Copy, Check, RefreshCw, X, Trash2, Download, Clock } from "lucide-react";
import Convert from "ansi-to-html";
import { useTheme } from "../contexts/ThemeContext";
import {
  type LogTimeRange,
  RELATIVE_RANGES,
  toDateTimeLocal,
} from "../utils/logTimeRange";
import "./LogsViewer.css";

interface LogsViewerProps {
  content: string;
  title: string;
  loading?: boolean;
  onRefresh: () => void;
  onClose: () => void;
  onClear?: () => void;
  /** Save the node's full on-disk history (not just the fetched tail) to a file. */
  onDownload?: () => void;
  /** True while the export is streaming, so the button can't be double-fired. */
  downloading?: boolean;
  /** Time window being shown; omit to hide the time-range picker. */
  timeRange?: LogTimeRange;
  /** Called with a new window; the parent re-fetches for it. */
  onTimeRangeChange?: (range: LogTimeRange) => void;
  /** Extra status about the fetched window, e.g. that it was cut to the newest lines. */
  rangeNote?: string;
}

const TAIL_OPTION = "tail";
const CUSTOM_OPTION = "custom";

function rangeOptionValue(range: LogTimeRange): string {
  if (range.kind === "relative") return String(range.minutes);
  return range.kind === "custom" ? CUSTOM_OPTION : TAIL_OPTION;
}

// Cap how many lines are ever put in the DOM at once. The backend already tails
// (default 500), but a large fetch or an unfiltered view could still push
// thousands of nodes into one scroll container; rendering only the most recent
// slice keeps the viewer responsive regardless of how much was fetched.
const MAX_RENDERED_LINES = 3000;

export function LogsViewer({
  content,
  title,
  loading = false,
  onRefresh,
  onClose,
  onClear,
  onDownload,
  downloading = false,
  timeRange,
  onTimeRangeChange,
  rangeNote,
}: LogsViewerProps) {
  const { theme } = useTheme();
  const [filterInput, setFilterInput] = useState("");
  const [filter, setFilter] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [levelFilter, setLevelFilter] = useState<string>("");
  const [autoScroll, setAutoScroll] = useState(true);
  const [copied, setCopied] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Whether the user is scrolled to (near) the bottom. Auto-scroll only nudges
  // the view when they haven't deliberately scrolled up to read older lines.
  const pinnedToBottomRef = useRef(true);
  // The custom picker is shown as soon as "Custom range" is chosen, but nothing
  // is fetched until Apply - half-typed bounds would each trigger a full scan.
  const [customOpen, setCustomOpen] = useState(timeRange?.kind === "custom");
  const [customFrom, setCustomFrom] = useState(
    timeRange?.kind === "custom" ? timeRange.from : ""
  );
  const [customTo, setCustomTo] = useState(timeRange?.kind === "custom" ? timeRange.to : "");

  const handleRangeSelect = (value: string) => {
    if (value === CUSTOM_OPTION) {
      // Seed a sensible window (the last hour, open-ended) the first time.
      if (!customFrom && !customTo) {
        setCustomFrom(toDateTimeLocal(Date.now() - 60 * 60_000));
      }
      setCustomOpen(true);
      return;
    }
    setCustomOpen(false);
    onTimeRangeChange?.(
      value === TAIL_OPTION ? { kind: "tail" } : { kind: "relative", minutes: Number(value) }
    );
  };

  const levels = [
    { id: "", label: "All" },
    { id: "ERROR", label: "Error" },
    { id: "WARN", label: "Warn" },
    { id: "INFO", label: "Info" },
    { id: "DEBUG", label: "Debug" },
    { id: "TRACE", label: "Trace" },
  ];

  // Debounce the filter so we don't re-scan every line on each keystroke.
  useEffect(() => {
    const t = setTimeout(() => setFilter(filterInput), 150);
    return () => clearTimeout(t);
  }, [filterInput]);

  // Split the raw content exactly once; every derived value reuses this.
  const allLines = useMemo(() => content.split("\n"), [content]);

  const filteredLines = useMemo(() => {
    if (!filter && !levelFilter) return allLines;
    const needle = caseSensitive ? filter : filter.toLowerCase();
    return allLines.filter((line) => {
      const matchFilter =
        !filter ||
        (caseSensitive ? line.includes(needle) : line.toLowerCase().includes(needle));
      const matchLevel =
        !levelFilter ||
        line.includes(`[${levelFilter}]`) ||
        line.includes(` ${levelFilter} `) ||
        line.toUpperCase().includes(levelFilter);
      return matchFilter && matchLevel;
    });
  }, [allLines, filter, caseSensitive, levelFilter]);

  // Only the most recent slice is rendered; older lines stay out of the DOM.
  const hiddenCount = Math.max(0, filteredLines.length - MAX_RENDERED_LINES);
  const visibleLines = useMemo(
    () => (hiddenCount > 0 ? filteredLines.slice(-MAX_RENDERED_LINES) : filteredLines),
    [filteredLines, hiddenCount]
  );

  const convert = useMemo(
    () =>
      new Convert({
        newline: true,
        escapeXML: true,
        fg: theme === "dark" ? "#b8b8b8" : "#2d2c30",
        bg: theme === "dark" ? "#131215" : "#fafaf7",
      }),
    [theme]
  );

  const renderedContent = useMemo(() => {
    const text = visibleLines.join("\n");
    return text ? convert.toHtml(text) : "";
  }, [visibleLines, convert]);

  const handleCopy = async () => {
    try {
      // Copy the full filtered set, not just the rendered slice.
      await navigator.clipboard.writeText(filteredLines.join("\n"));
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
      setCopied(true);
      copyTimeoutRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard write failed — don't show feedback
    }
  };

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
    if (autoScroll && pinnedToBottomRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [visibleLines, autoScroll]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    // "Near bottom" tolerance so tiny rounding doesn't unpin the view.
    pinnedToBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  return (
    <div className="logs-viewer-overlay" onClick={onClose}>
      <div className="logs-viewer-modal" onClick={(e) => e.stopPropagation()}>
        <div className="logs-viewer-header">
          <h3>Logs: {title}</h3>
          <div className="logs-viewer-actions">
            <button
              onClick={onRefresh}
              className="logs-viewer-btn"
              disabled={loading}
              title="Refresh"
            >
              <RefreshCw size={14} />
              {loading ? "Loading..." : "Refresh"}
            </button>
            <button
              onClick={handleCopy}
              className={`logs-viewer-btn${copied ? " logs-viewer-btn--copied" : ""}`}
              title="Copy to clipboard"
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? "Copied!" : "Copy"}
            </button>
            {onDownload && (
              <button
                onClick={onDownload}
                className="logs-viewer-btn"
                disabled={downloading}
                title="Save the node's full log history to a .txt file"
              >
                <Download size={14} />
                {downloading ? "Saving..." : "Download"}
              </button>
            )}
            {onClear && (
              <button
                onClick={onClear}
                className="logs-viewer-btn"
                disabled={loading}
                title="Clear logs on disk"
              >
                <Trash2 size={14} />
                Clear
              </button>
            )}
            <button
              onClick={onClose}
              className="logs-viewer-btn logs-viewer-close"
              aria-label="Close"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="logs-viewer-toolbar">
          <div className="logs-viewer-search">
            <Search size={14} className="logs-viewer-search-icon" />
            <input
              type="text"
              placeholder="Filter logs..."
              value={filterInput}
              onChange={(e) => setFilterInput(e.target.value)}
              className="logs-viewer-search-input"
            />
          </div>
          <label className="logs-viewer-checkbox">
            <input
              type="checkbox"
              checked={caseSensitive}
              onChange={(e) => setCaseSensitive(e.target.checked)}
            />
            Case sensitive
          </label>
          <select
            value={levelFilter}
            onChange={(e) => setLevelFilter(e.target.value)}
            className="logs-viewer-level-select"
          >
            {levels.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
          {timeRange && onTimeRangeChange && (
            <div className="logs-viewer-range">
              <Clock size={14} className="logs-viewer-range-icon" />
              <select
                value={customOpen ? CUSTOM_OPTION : rangeOptionValue(timeRange)}
                onChange={(e) => handleRangeSelect(e.target.value)}
                className="logs-viewer-level-select"
                aria-label="Time range"
                disabled={loading}
              >
                <option value={TAIL_OPTION}>Latest lines</option>
                {RELATIVE_RANGES.map((r) => (
                  <option key={r.minutes} value={String(r.minutes)}>
                    {r.label}
                  </option>
                ))}
                <option value={CUSTOM_OPTION}>Custom range…</option>
              </select>
            </div>
          )}
          <label className="logs-viewer-checkbox">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
            />
            Auto-scroll
          </label>
        </div>

        {customOpen && onTimeRangeChange && (
          <form
            className="logs-viewer-toolbar logs-viewer-custom-range"
            onSubmit={(e) => {
              e.preventDefault();
              onTimeRangeChange({ kind: "custom", from: customFrom, to: customTo });
            }}
          >
            <label className="logs-viewer-checkbox">
              From
              <input
                type="datetime-local"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                className="logs-viewer-datetime"
                aria-label="From"
              />
            </label>
            <label className="logs-viewer-checkbox">
              To
              <input
                type="datetime-local"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                className="logs-viewer-datetime"
                aria-label="To"
              />
            </label>
            <span className="logs-viewer-range-hint">Leave To empty for “until now”.</span>
            <button
              type="submit"
              className="logs-viewer-btn"
              disabled={loading || (!customFrom && !customTo)}
            >
              Apply
            </button>
          </form>
        )}

        <div ref={scrollRef} className="logs-viewer-content" onScroll={handleScroll}>
          {loading ? (
            "Loading logs..."
          ) : renderedContent ? (
            <>
              {hiddenCount > 0 && (
                <div className="logs-viewer-truncated">
                  {hiddenCount.toLocaleString()} older line(s) hidden — showing the
                  most recent {MAX_RENDERED_LINES.toLocaleString()}. Use the filter to
                  narrow down, or Copy to export everything fetched
                  {onDownload ? " — Download saves the node's full on-disk history." : "."}
                </div>
              )}
              <div dangerouslySetInnerHTML={{ __html: renderedContent }} />
            </>
          ) : (
            "(No log output)"
          )}
        </div>
        {(filter || levelFilter || rangeNote) && (
          <div className="logs-viewer-footer">
            {(filter || levelFilter) && (
              <>
                Showing {filteredLines.length.toLocaleString()} of{" "}
                {allLines.length.toLocaleString()} lines
              </>
            )}
            {(filter || levelFilter) && rangeNote && " · "}
            {rangeNote}
          </div>
        )}
      </div>
    </div>
  );
}
