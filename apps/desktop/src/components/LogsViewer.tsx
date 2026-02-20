import { useState, useMemo, useRef, useEffect } from "react";
import { Search, Copy, RefreshCw, X } from "lucide-react";
import Convert from "ansi-to-html";
import { useTheme } from "../contexts/ThemeContext";
import "./LogsViewer.css";

interface LogsViewerProps {
  content: string;
  title: string;
  loading?: boolean;
  onRefresh: () => void;
  onClose: () => void;
}

export function LogsViewer({
  content,
  title,
  loading = false,
  onRefresh,
  onClose,
}: LogsViewerProps) {
  const { theme } = useTheme();
  const [filter, setFilter] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [levelFilter, setLevelFilter] = useState<string>("");
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  const levels = [
    { id: "", label: "All" },
    { id: "ERROR", label: "Error" },
    { id: "WARN", label: "Warn" },
    { id: "INFO", label: "Info" },
    { id: "DEBUG", label: "Debug" },
    { id: "TRACE", label: "Trace" },
  ];

  const filteredLines = useMemo(() => {
    const lines = content.split("\n");
    return lines.filter((line) => {
      const matchFilter =
        !filter ||
        (caseSensitive
          ? line.includes(filter)
          : line.toLowerCase().includes(filter.toLowerCase()));
      const matchLevel =
        !levelFilter ||
        line.includes(`[${levelFilter}]`) ||
        line.includes(` ${levelFilter} `) ||
        line.toUpperCase().includes(levelFilter);
      return matchFilter && matchLevel;
    });
  }, [content, filter, caseSensitive, levelFilter]);

  const convert = useMemo(
    () =>
      new Convert({
        newline: true,
        escapeXML: true,
        fg: theme === "dark" ? "#a1a1aa" : "#27272a",
        bg: theme === "dark" ? "#09090b" : "#fafafa",
      }),
    [theme]
  );

  const renderedContent = useMemo(() => {
    const text = filteredLines.join("\n");
    return text ? convert.toHtml(text) : "";
  }, [filteredLines, convert]);

  const handleCopy = () => {
    navigator.clipboard.writeText(filteredLines.join("\n"));
  };

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [filteredLines, autoScroll]);

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
              className="logs-viewer-btn"
              title="Copy to clipboard"
            >
              <Copy size={14} />
              Copy
            </button>
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
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
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
          <label className="logs-viewer-checkbox">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
            />
            Auto-scroll
          </label>
        </div>

        <div ref={scrollRef} className="logs-viewer-content">
          {loading ? (
            "Loading logs..."
          ) : renderedContent ? (
            <div dangerouslySetInnerHTML={{ __html: renderedContent }} />
          ) : (
            "(No log output)"
          )}
        </div>
        {(filter || levelFilter) && (
          <div className="logs-viewer-footer">
            Showing {filteredLines.length} of {content.split("\n").length} lines
          </div>
        )}
      </div>
    </div>
  );
}
