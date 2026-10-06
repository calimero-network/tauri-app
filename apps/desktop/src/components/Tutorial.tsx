import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { TUTORIAL_STEPS, computePopoverPosition, type Rect, type TutorialStep } from "../utils/tutorial";
import "./Tutorial.css";

/** Breathing room between the highlighted element and the edge of the spotlight. */
const SPOTLIGHT_PADDING = 6;

function findTarget(step: TutorialStep): Element | null {
  return step.target ? document.querySelector(`[data-tutorial="${step.target}"]`) : null;
}

function measure(el: Element | null): Rect | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return {
    top: r.top - SPOTLIGHT_PADDING,
    left: r.left - SPOTLIGHT_PADDING,
    width: r.width + SPOTLIGHT_PADDING * 2,
    height: r.height + SPOTLIGHT_PADDING * 2,
  };
}

/**
 * The first-run guided tour over the app shell: everything but the current step's
 * element is dimmed, and a popover beside it explains what it is.
 *
 * Renders in a portal so no shell ancestor (scroll containers, backdrop-filter)
 * can clip the fixed overlay - see the note on Lightbox. Escape, the close button
 * and "Skip tour" all end it; the dimmed area swallows clicks so a stray one
 * cannot navigate the app out from under the tour.
 */
export function Tutorial({ onClose }: { onClose: () => void }) {
  // Resolved once on open: which steps have something on screen to point at.
  const steps = useMemo(
    () => TUTORIAL_STEPS.filter((step) => !step.target || findTarget(step)),
    [],
  );
  const [index, setIndex] = useState(0);
  const [targetRect, setTargetRect] = useState<Rect | null>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const step = steps[index];
  const isLast = index === steps.length - 1;

  const layout = useCallback(() => {
    if (!step) return;
    const rect = measure(findTarget(step));
    setTargetRect(rect);
    const pop = popoverRef.current;
    if (!pop) return;
    const { top, left } = computePopoverPosition(
      rect,
      { width: pop.offsetWidth, height: pop.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
    );
    setPosition({ top, left });
  }, [step]);

  // Layout effect so the popover never paints a frame at the previous step's spot.
  useLayoutEffect(() => {
    findTarget(step)?.scrollIntoView({ block: "nearest" });
    layout();
  }, [layout, step]);

  useEffect(() => {
    window.addEventListener("resize", layout);
    const observer = new ResizeObserver(layout);
    observer.observe(document.body);
    return () => {
      window.removeEventListener("resize", layout);
      observer.disconnect();
    };
  }, [layout]);

  const next = useCallback(() => {
    if (isLast) onClose();
    else setIndex((i) => i + 1);
  }, [isLast, onClose]);
  const back = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        next();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        back();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, next, back]);

  // Focus the dialog so the arrow keys and Escape reach it without a click first.
  useEffect(() => {
    popoverRef.current?.focus();
  }, [index]);

  if (!step) return null;

  return createPortal(
    <div className="tutorial-root" data-testid="tutorial">
      <div className="tutorial-blocker" onClick={(e) => e.stopPropagation()} />
      {targetRect ? (
        <div
          className="tutorial-spotlight"
          style={{
            top: targetRect.top,
            left: targetRect.left,
            width: targetRect.width,
            height: targetRect.height,
          }}
        />
      ) : (
        <div className="tutorial-dim" />
      )}

      <div
        ref={popoverRef}
        className="tutorial-popover"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tutorial-title"
        aria-describedby="tutorial-body"
        tabIndex={-1}
        style={position ? { top: position.top, left: position.left } : { visibility: "hidden" }}
      >
        <button
          type="button"
          className="tutorial-close"
          onClick={onClose}
          aria-label="Close tutorial"
          title="Close tutorial"
        >
          <X size={16} />
        </button>
        <span className="tutorial-progress">
          {index + 1} / {steps.length}
        </span>
        <h3 id="tutorial-title" className="tutorial-title">{step.title}</h3>
        <p id="tutorial-body" className="tutorial-body">{step.body}</p>
        <div className="tutorial-actions">
          <button type="button" className="tutorial-skip" onClick={onClose}>
            Skip tour
          </button>
          <div className="tutorial-nav">
            {index > 0 && (
              <button type="button" className="button button-secondary button-small" onClick={back}>
                Back
              </button>
            )}
            <button
              type="button"
              className="button button-primary button-small"
              onClick={next}
              data-testid="tutorial-next"
            >
              {isLast ? "Finish" : index === 0 ? "Start tour" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
