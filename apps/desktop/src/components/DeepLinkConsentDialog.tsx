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
  const installing = request.kind === "install" || request.kind === "add";
  const deleting = request.kind === "delete";
  const unverified = installing && !request.verified;
  const params = [...new URLSearchParams(request.params).entries()];
  const { title, ask, confirm } = wording(request);

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
          <p>{ask}</p>

          <dl className="deep-link-consent-facts">
            <dt>Package</dt>
            <dd>
              <code>{request.pkg}</code>
              {installing && request.version ? ` ${request.version}` : ""}
            </dd>
            {deleting ? (
              <>
                <dt>Deletes</dt>
                <dd>
                  <code>{request.contextId}</code>
                  {request.namespace ? " and its namespace" : ""}
                </dd>
              </>
            ) : (
              <>
                <dt>{request.kind === "add" ? "Frontend" : "Opens"}</dt>
                <dd>
                  <code>{request.frontendOrigin ?? "unknown"}</code>
                </dd>
                <dt>Action</dt>
                <dd>
                  <code>{request.action}</code>
                </dd>
              </>
            )}
            {!deleting && params.length > 0 && (
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
              className={deleting ? "button button-danger" : "button button-primary"}
              onClick={() => onAnswer(true)}
            >
              {confirm}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** What the dialog asks, by what the link would do. */
function wording(request: DeepLinkConsentRequest): { title: string; ask: ReactNode; confirm: string } {
  const app = <strong>{request.appName}</strong>;
  switch (request.kind) {
    case "install":
      return {
        title: "Install app from link?",
        ask: <>A link wants to install and open {app}. The app will be signed in to your node with full access to it.</>,
        confirm: "Install and open",
      };
    case "add":
      return {
        title: "Install app?",
        ask: <>An app or link wants to install {app} on your node. Nothing opens; you can open it later from Apps.</>,
        confirm: "Install",
      };
    case "delete":
      return {
        title: "Delete from app?",
        ask: (
          <>
            {app} wants to delete one of its contexts{request.namespace ? " and its namespace" : ""}, with
            everything in it. This can't be undone.
          </>
        ),
        confirm: "Delete",
      };
    default:
      return {
        title: "Open app from link?",
        ask: <>A link wants to open {app}. The app will be signed in to your node with full access to it.</>,
        confirm: "Open",
      };
  }
}
