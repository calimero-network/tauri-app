import React from "react";
import { MoreHorizontal } from "lucide-react";
import AppIcon from "./AppIcon";
import { formatBytes } from "../utils/appCards";
import { decodeMetadata } from "../utils/appUtils";
import "./AppCard.css";
import "./InstalledAppCard.css";

export interface InstalledApplicationRow {
  id: string;
  name?: string;
  version?: string;
  metadata: number[] | string;
  size?: number;
  source?: string;
}

/**
 * One installed application, as a card.
 *
 * This was a table of name, version, size, description and buttons. The bundles
 * it lists have carried a launcher icon in their own metadata all along —
 * `handleCreateLauncher` already passes `metadata.icon` straight to
 * `create_desktop_shortcut` — so the table was rendering a wall of near-
 * identical text for apps that had pictures available the whole time.
 *
 * ⚠️ NOT A <button> LIKE THE MARKETPLACE CARD. This one holds its own controls,
 * and nesting a button inside a button is invalid HTML that browsers recover
 * from by dropping the inner one, which would make the whole card one click
 * target and Uninstall unreachable.
 *
 * ⚠️ THE DROPDOWN IS NOT A CHILD OF THIS CARD, and cannot be. `.app-card`
 * carries `backdrop-filter`, which makes it a containing block for
 * fixed-position descendants — so a `position: fixed` menu inside the card is
 * laid out against the CARD and then clipped by its `overflow: hidden`. It
 * opens; it simply cannot be seen or clicked. The page renders it as a sibling
 * of the grid.
 *
 * Home renders the same card without `onToggleMenu`: the More button (and so
 * Uninstall) is left out, and Open is the only action.
 */
export default function InstalledAppCard({
  app,
  menuOpen,
  onToggleMenu,
  onContextMenu,
  onOpen,
  nodeSelect,
}: {
  app: InstalledApplicationRow;
  menuOpen?: boolean;
  /** Omitted on Home, where the card only opens the app. */
  onToggleMenu?: (e: React.MouseEvent) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  onOpen: (frontendUrl: string) => void;
  /** The developer-mode "which node does this run against" picker, when shown. */
  nodeSelect?: React.ReactNode;
}) {
  const metadata = decodeMetadata(app.metadata);
  const name = metadata?.name || app.name || app.id;
  const frontendUrl = metadata?.links?.frontend;
  const version = metadata?.version ?? app.version ?? null;
  const size = formatBytes(app.size);
  // The bundle's own package id when it has one; the node's application id is a
  // content hash and means nothing to a reader, so it is only the fallback.
  const subtitle =
    metadata?.package ?? (app.id.length > 20 ? `${app.id.slice(0, 10)}…${app.id.slice(-6)}` : app.id);

  return (
    <div
      className="app-card installed-app-card"
      data-testid="installed-app-card"
      data-app-id={app.id}
      onContextMenu={onContextMenu}
    >
      <div className="app-card-top">
        <AppIcon
          icon={metadata?.icon}
          name={name}
          seed={metadata?.package ?? app.id}
          size={48}
        />
        <div className="app-card-headings">
          <h3 className="app-card-title" title={name}>
            {name}
          </h3>
          <p className="app-card-package">
            <span className="app-card-package-id" title={app.id}>
              {subtitle}
            </span>
          </p>
        </div>
      </div>

      <p className="app-card-description">
        {metadata?.description ?? "No description available."}
      </p>

      <div className="app-card-meta">
        {version && (
          <span className="app-card-meta-item">
            <span className="installed-app-version">v{version}</span>
          </span>
        )}
        {size && (
          <>
            <span aria-hidden="true" className="app-card-dot">
              ·
            </span>
            <span className="app-card-meta-item">{size}</span>
          </>
        )}
      </div>

      <div className="installed-app-actions">
        <div className="installed-app-actions-left">
          {nodeSelect}
          {frontendUrl ? (
            <button
              className="button installed-app-open"
              data-testid="open-app"
              title={`Open ${name}`}
              onClick={(e) => {
                e.stopPropagation();
                onOpen(frontendUrl);
              }}
            >
              Open
            </button>
          ) : (
            // A bundle with no declared frontend is normal, not broken — the
            // slot is held so the More button does not jump left.
            <span className="installed-app-no-frontend">No web frontend</span>
          )}
        </div>

        {onToggleMenu && (
          <div className="installed-app-more" onClick={(e) => e.stopPropagation()}>
            <button
              className="button button-secondary installed-app-more-btn"
              title="More options"
              aria-label={`More options for ${name}`}
              aria-expanded={menuOpen ?? false}
              onClick={onToggleMenu}
            >
              <MoreHorizontal size={15} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
