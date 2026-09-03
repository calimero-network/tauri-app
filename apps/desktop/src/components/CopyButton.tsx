import { useState, useEffect, useRef } from "react";
import { Copy, Check } from "lucide-react";

/** Wears the Settings copy-button styling (.agent-config-copy). */
export default function CopyButton({ id, value }: { id: string; value: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("failed");
    }
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setState("idle"), 2000);
  };

  return (
    <button
      type="button"
      id={id}
      className={`agent-config-copy${state === "copied" ? " agent-config-copy--copied" : ""}`}
      onClick={copy}
    >
      {state === "copied" ? <Check size={13} /> : <Copy size={13} />}
      {state === "copied" ? "Copied!" : state === "failed" ? "Copy failed" : "Copy"}
    </button>
  );
}
