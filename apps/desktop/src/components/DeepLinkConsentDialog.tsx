import { useCallback, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ShieldAlert, X } from "lucide-react";
import type { Consent, DeepLinkConsentRequest } from "../hooks/useAppDeepLink";
import "./AccountPanel.css";
import "./DeepLinkConsentDialog.css";

interface Pending {
  request: DeepLinkConsentRequest;
  resolve: (agreed: boolean) => void;
}

/**
 * The user's answer to a deep-link, as a `Consent` for `useAppDeepLink` plus the
 * dialog that asks it.
 *
 * One question at a time: a request arriving while another is on screen is
 * declined outright rather than queued, so a page flooding fake `app-deep-link`
 * events cannot stack dialogs until the user clicks through one by reflex.
 */
export function useDeepLinkConsent(): { consent: Consent; dialog: ReactNode } {
  const [pending, setPending] = useState<Pending | null>(null);
  const busy = useRef(false);

  const consent = useCallback<Consent>(
    (request) =>
      new Promise<boolean>((resolve) => {
        if (busy.current) {
          resolve(false);
          return;
        }
        busy.current = true;
        setPending({ request, resolve });
      }),
    [],
  );

  const answer = useCallback(
    (agreed: boolean) => {
      if (!pending) return;
      busy.current = false;
      setPending(null);
      pending.resolve(agreed);
    },
    [pending],
  );

  const dialog = pending ? (
    <DeepLinkConsentDialog request={pending.request} onAnswer={answer} />
  ) : null;
  return { consent, dialog };
}

function DeepLinkConsentDialog({
  request,
  onAnswer,
}: {
  request: DeepLinkConsentRequest;
  onAnswer: (agreed: boolean) => void;
}) {
  const installing = request.kind === "install";
  const unverified = installing && !request.verified;
  const params = [...new URLSearchParams(request.params).entries()];
  const title = installing ? "Install app from link?" : "Open app from link?";

  return createPortal(
    <div className="account-modal-backdrop" onClick={() => onAnswer(false)}>
      <div
        className="account-modal"
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="account-modal-header">
          <h2>{title}</h2>
          <button
            type="button"
            className="account-modal-close"
            aria-label="Cancel"
            onClick={() => onAnswer(false)}
          >
            <X size={16} />
          </button>
        </div>
        <div className="account-modal-body deep-link-consent">
          <p>
            A link wants to {installing ? "install and open" : "open"}{" "}
            <strong>{request.appName}</strong>. The app will be signed in to your node
            with full access to it.
          </p>

          <dl className="deep-link-consent-facts">
            <dt>Package</dt>
            <dd>
              <code>{request.pkg}</code>
              {installing && request.version ? ` ${request.version}` : ""}
            </dd>
            <dt>Opens</dt>
            <dd>
              <code>{request.frontendOrigin ?? "unknown"}</code>
            </dd>
            <dt>Action</dt>
            <dd>
              <code>{request.action}</code>
            </dd>
            {params.length > 0 && (
              <>
                <dt>Parameters</dt>
                <dd>
                  {params.map(([k, v]) => (
                    <div key={k}>
                      <code>
                        {k}={v}
                      </code>
                    </div>
                  ))}
                </dd>
              </>
            )}
          </dl>

          {unverified && (
            <p className="deep-link-consent-warning" role="note">
              <ShieldAlert size={16} aria-hidden="true" />
              <span>
                This package is <strong>not verified</strong> by the registry
                {request.publisherVerified ? "" : ", and neither is its publisher"}. Only
                continue if you trust whoever sent you this link.
              </span>
            </p>
          )}

          <p className="field-hint">If you did not just click a link, cancel.</p>

          <div className="deep-link-consent-actions">
            {/* Cancel first and focused: Enter on a surprise dialog must not agree. */}
            <button
              type="button"
              className="button button-secondary"
              autoFocus
              onClick={() => onAnswer(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button button-primary"
              onClick={() => onAnswer(true)}
            >
              {installing ? "Install and open" : "Open"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
