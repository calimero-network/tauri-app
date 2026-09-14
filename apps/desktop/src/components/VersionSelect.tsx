import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import type { VersionInfo } from "../utils/registry";
import "./VersionSelect.css";

/**
 * The version picker on an application page.
 *
 * ⚠️ NOT A NATIVE <select>, AND THAT IS THE POINT. A native select in a Tauri
 * webview renders the OS's own menu — a macOS popup in a window that is
 * otherwise entirely our design system, with its own font, metrics and
 * highlight colour, and no way to style the option rows. This draws the list
 * itself so the control matches the page it sits on.
 *
 * What a native select gives away for free, and is therefore rebuilt here:
 *  - keyboard operation (Up/Down/Home/End to move, Enter to choose, Escape to
 *    dismiss, Tab to leave),
 *  - `role="listbox"` / `role="option"` with `aria-selected`, so it is still
 *    announced as a picker rather than as a pile of buttons,
 *  - dismissal on an outside click or a scroll.
 *
 * ⚠️ THE MENU IS POSITIONED `fixed` FROM THE TRIGGER'S MEASURED RECT. The
 * install panel it lives in has `backdrop-filter`, which makes it a containing
 * block for fixed descendants AND clips them — the same trap the installed-app
 * card's dropdown hit. Measuring and rendering at the top level is what keeps
 * the list visible.
 */
export default function VersionSelect({
  versions,
  value,
  onChange,
  disabled = false,
}: {
  versions: VersionInfo[];
  value: string;
  onChange: (semver: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const place = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setRect({ top: r.bottom + 4, left: r.left, width: Math.max(r.width, 190) });
  }, []);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (triggerRef.current?.contains(e.target as Node)) return;
      if (listRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    // `true` — capture. A click that lands on something which stops
    // propagation would otherwise leave the menu open over the page.
    document.addEventListener("mousedown", close, true);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      document.removeEventListener("mousedown", close, true);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, place]);

  const openAt = () => {
    const i = versions.findIndex((v) => v.semver === value);
    setActive(i < 0 ? 0 : i);
    setOpen(true);
  };

  const choose = (i: number) => {
    const v = versions[i];
    if (v) onChange(v.semver);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (!open) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
        e.preventDefault();
        openAt();
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, versions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(versions.length - 1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      choose(active);
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  };

  const selectedIndex = versions.findIndex((v) => v.semver === value);
  const label = value || versions[0]?.semver || "—";

  return (
    <div className="version-select">
      <button
        ref={triggerRef}
        type="button"
        className={`version-select-trigger${open ? " is-open" : ""}`}
        data-testid="version-picker"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Version, ${label} selected`}
        onClick={() => (open ? setOpen(false) : openAt())}
        onKeyDown={onKeyDown}
      >
        <span className="version-select-value">{label}</span>
        {selectedIndex === 0 && <span className="version-select-latest">latest</span>}
        <ChevronDown size={14} className="version-select-chevron" aria-hidden="true" />
      </button>

      {open && rect && (
        <ul
          ref={listRef}
          className="version-select-menu"
          role="listbox"
          tabIndex={-1}
          aria-label="Version"
          style={{ top: rect.top, left: rect.left, minWidth: rect.width }}
          onKeyDown={onKeyDown}
        >
          {versions.map((v, i) => (
            <li
              key={v.semver}
              role="option"
              aria-selected={v.semver === value}
              className={`version-select-option${i === active ? " is-active" : ""}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(i)}
            >
              <span className="version-select-check">
                {v.semver === value && <Check size={13} aria-hidden="true" />}
              </span>
              <span className="version-select-semver">{v.semver}</span>
              {i === 0 && <span className="version-select-latest">latest</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
