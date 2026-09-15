/**
 * Turn macOS's text substitutions off for every field in the app.
 *
 * ⚠️ THE WEBVIEW CAPITALISES THE FIRST LETTER OF EVERY FIELD, and almost
 * nothing this app asks for is a sentence: usernames, node names, package ids,
 * aliases, ports, registry URLs, public keys. "Set Up Authentication" is the
 * worst case — the admin username you type is the one you will log in with, so
 * an invisible capital at the front is a credential you cannot reproduce.
 *
 * ⚠️ AND IT IS NOT A PER-FIELD BUG, SO IT DOES NOT GET A PER-FIELD FIX. The
 * sign-in form already carried `autoCorrect`/`autoCapitalize`/`spellCheck`
 * props — they were added the last time this bit someone — and the ~40 other
 * inputs in the app did not, which is exactly how it came back. Applying them
 * centrally means a field added tomorrow is covered on the day it is written
 * rather than the day someone complains.
 *
 * The MutationObserver is the load-bearing half: most of these fields live in
 * modals and lazily-mounted pages that do not exist when the app boots.
 *
 * A field that genuinely wants prose behaviour opts out with
 * `data-allow-autocorrect` — nothing does today.
 */

const OPT_OUT_ATTR = "data-allow-autocorrect";

/**
 * Input types where the attributes mean anything. A checkbox or a color picker
 * has no text to correct, and stamping attributes on them would just make the
 * DOM noisier to read in devtools.
 *
 * ⚠️ `number` IS IN THE LIST. Chrome and WKWebView disagree on whether a
 * number field is spellchecked, and the ports on the onboarding screen are
 * number fields.
 */
const TEXTUAL_TYPES = new Set([
  "",
  "text",
  "search",
  "url",
  "email",
  "tel",
  "password",
  "number",
]);

type Field = HTMLInputElement | HTMLTextAreaElement;

function isTextual(el: Element): el is Field {
  if (el.hasAttribute(OPT_OUT_ATTR)) return false;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) {
    // `getAttribute`, not `.type`: the property normalises an unknown type to
    // "text", which would pull date/color pickers into the set.
    return TEXTUAL_TYPES.has((el.getAttribute("type") ?? "").toLowerCase());
  }
  return false;
}

/** The three attributes, set only where they are missing. */
export function cleanField(el: Field): void {
  if (!el.hasAttribute("autocapitalize")) el.setAttribute("autocapitalize", "off");
  if (!el.hasAttribute("autocorrect")) el.setAttribute("autocorrect", "off");
  // ⚠️ SPELLCHECK TOO, NOT JUST AUTOCORRECT. On macOS "Correct spelling
  // automatically" is what rewrites a word after you leave it, and it reads
  // `spellcheck`; `autocorrect` alone leaves package ids underlined in red and
  // still rewritable.
  if (!el.hasAttribute("spellcheck")) el.setAttribute("spellcheck", "false");
}

/** Apply to everything already in a tree. */
export function cleanTree(root: ParentNode): void {
  if (root instanceof Element && isTextual(root)) cleanField(root);
  for (const el of root.querySelectorAll("input, textarea")) {
    if (isTextual(el)) cleanField(el);
  }
}

/**
 * Start watching. Safe to call more than once; returns a disposer so tests can
 * stop the observer.
 */
export function installInputHygiene(
  root: ParentNode = document.body ?? document.documentElement,
): () => void {
  cleanTree(root);

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) cleanTree(node as Element);
      }
      // React can re-render an input and drop attributes it does not own, so
      // a removed attribute has to be put back rather than assumed permanent.
      if (
        record.type === "attributes" &&
        record.target instanceof Element &&
        isTextual(record.target)
      ) {
        cleanField(record.target);
      }
    }
  });

  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["type", "autocapitalize", "autocorrect", "spellcheck"],
  });

  return () => observer.disconnect();
}
