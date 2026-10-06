import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { computePopoverPosition, type Rect, type TutorialStep } from "../utils/tutorial";
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

/** How long a step waits for its target: pages load lazily and fetch their data first. */
const TARGET_TIMEOUT_MS = 3000;
const TARGET_POLL_MS = 100;

interface TutorialProps {
  steps: readonly TutorialStep[];
  index: number;
  /** Move to another step; App opens the page or Settings tab the step is `at`. */
  onIndexChange: (index: number) => void;
  /** An optional step whose target never appeared: move on in the same direction. */
  onSkip: () => void;
  onClose: () => void;
}

/**
 * The guided tour over the app: everything but the current step's element is
 * dimmed, and a popover beside it explains what it is. App owns which step is
 * showing and navigates to it, so the tour survives moving between the shell
 * and Settings, which are separate trees.
 *
 * Renders in a portal so no shell ancestor (scroll containers, backdrop-filter)
 * can clip the fixed overlay - see the note on Lightbox. Escape, the close button
 * and "Skip tour" all end it; the dimmed area swallows clicks so a stray one
 * cannot navigate the app out from under the tour.
 */
export function Tutorial({ steps, index, onIndexChange, onSkip, onClose }: TutorialProps) {
  // The step whose target has been waited for: until then nothing is positioned,
  // so the popover never points at the page being navigated away from.
  const [readyStep, setReadyStep] = useState<string | null>(null);
  const [targetRect, setTargetRect] = useState<Rect | null>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const step = steps[index];
  const isLast = index === steps.length - 1;
  const ready = !!step && readyStep === step.id;

  // Wait for the step's target to render. A required step whose target never
  // shows up is still worth reading, so it is shown centered; an optional one is
  // skipped.
  const onSkipRef = useRef(onSkip);
  onSkipRef.current = onSkip;
  useEffect(() => {
    if (!step) return;
    setReadyStep(null);
    setPosition(null);
    if (!step.target || findTarget(step)) {
      setReadyStep(step.id);
      return;
    }
    const started = Date.now();
    const timer = setInterval(() => {
      if (findTarget(step)) {
        clearInterval(timer);
        setReadyStep(step.id);
      } else if (Date.now() - started >= TARGET_TIMEOUT_MS) {
        clearInterval(timer);
        if (step.optional) onSkipRef.current();
        else setReadyStep(step.id);
      }
    }, TARGET_POLL_MS);
    return () => clearInterval(timer);
  }, [step]);

  // Re-queried on every call: a page re-rendering replaces the element.
  const layout = useCallback(() => {
    if (!step || !ready) return;
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
  }, [step, ready]);

  // Layout effect so the popover never paints a frame at the previous step's spot.
  useLayoutEffect(() => {
    if (!ready) return;
    findTarget(step)?.scrollIntoView({ block: "center" });
    layout();
  }, [layout, ready, step]);

  useEffect(() => {
    if (!ready) return;
    window.addEventListener("resize", layout);
    // Capture: the pages scroll inside their own containers, not the window.
    window.addEventListener("scroll", layout, true);
    const observer = new ResizeObserver(layout);
    observer.observe(document.body);
    const target = findTarget(step);
    if (target) observer.observe(target);
    return () => {
      window.removeEventListener("resize", layout);
      window.removeEventListener("scroll", layout, true);
      observer.disconnect();
    };
  }, [layout, ready, step]);

  const next = useCallback(() => {
    if (isLast) onClose();
    else onIndexChange(index + 1);
  }, [isLast, onClose, onIndexChange, index]);
  const back = useCallback(() => {
    if (index > 0) onIndexChange(index - 1);
  }, [onIndexChange, index]);

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
    if (ready) popoverRef.current?.focus();
  }, [ready]);

  if (!step) return null;

  return createPortal(
    <div className="tutorial-root" data-testid="tutorial">
      <div className="tutorial-blocker" onClick={(e) => e.stopPropagation()} />
      {ready && targetRect ? (
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
        style={ready && position ? { top: position.top, left: position.left } : { visibility: "hidden" }}
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
