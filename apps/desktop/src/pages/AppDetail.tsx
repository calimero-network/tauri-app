import React from "react";
import { ArrowLeft, CheckCircle2, Download, ExternalLink, RefreshCw } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import AppIcon from "../components/AppIcon";
import { VerifiedMark } from "../components/AppCard";
import { formatBytes, formatCategory, formatRelativeDate, shortenKey } from "../utils/appCards";
import type { AppSummary, VersionInfo } from "../utils/registry";
import "./AppDetail.css";

export interface DetailApp extends AppSummary {
  registry: string;
  installed?: boolean;
}

/**
 * One application, as a full page inside the Marketplace.
 *
 * This replaces a modal that floated over the grid. It is a page and not a
 * dialog because the version picker and the Install button are the point of the
 * screen rather than a detail of the listing, and because a modal over a grid of
 * twenty cards gives the reader nowhere to put their attention.
 *
 * ⚠️ A VIEW, NOT A ROUTE — the desktop shell has no router. App.tsx switches on
 * a `Page` union, so this is rendered in place of the grid by Marketplace and
 * leaves via `onBack`. The admin dashboard's equivalent IS a route
 * (`/marketplace/:packageId`), which is why the two look alike but are wired
 * differently.
 */
export default function AppDetail({
  app,
  installing,
  versions,
  versionsLoading,
  selectedVersion,
  onSelectVersion,
  onInstall,
  onBack,
}: {
  app: DetailApp;
  installing: boolean;
  versions: VersionInfo[];
  versionsLoading: boolean;
  selectedVersion: string;
  onSelectVersion: (v: string) => void;
  onInstall: () => void;
  onBack: () => void;
}) {
  const title = app.alias || app.name;
  const author = app.author ?? shortenKey(app.developer_pubkey);
  const category = formatCategory(app.category);
  const bytes = formatBytes(app.installSize);
  const when = formatRelativeDate(app.publishedAt);
  const tags = (app.tags ?? []).filter((t) => t && t !== app.category);

  const registryUrl = (() => {
    const base = (() => {
      try {
        return new URL(app.registry).origin;
      } catch {
        return app.registry.replace(/\/+$/, "");
      }
    })();
    return `${base}/apps/${encodeURIComponent(app.id)}`;
  })();

  // Rows that only exist when the data does. `installSize` is null on 21 of 21
  // published bundles and `publishedAt` on 20 of 21, so these are rows that
  // appear rather than rows that get filled in.
  const rows: { label: string; value: React.ReactNode }[] = [];
  if (author) {
    rows.push({
      label: "Author",
      value: (
        <span className="app-detail-author">
          {author}
          {app.publisherVerified && <VerifiedMark label="Verified author" />}
        </span>
      ),
    });
  }
  if (category) rows.push({ label: "Category", value: category });
  rows.push({ label: "Downloads", value: (app.downloads ?? 0).toLocaleString() });
  if (bytes) rows.push({ label: "Size", value: bytes });
  if (when) rows.push({ label: "Published", value: when });

  return (
    <div className="app-detail-page" data-testid="app-detail-page">
      <button type="button" className="app-detail-back" onClick={onBack}>
        <ArrowLeft size={15} /> Marketplace
      </button>

      <header className="app-detail-header">
        <AppIcon icon={app.icon} name={title} seed={app.id} size={72} />
        <div className="app-detail-identity">
          <h1 className="app-detail-title">{title}</h1>
          <p className="app-detail-package">
            <span className="app-detail-mono">{app.id}</span>
            {app.verified && <VerifiedMark label="Verified package" />}
          </p>
          {app.description && <p className="app-detail-description">{app.description}</p>}
        </div>
        {app.installed && (
          <span className="app-detail-installed-flag">
            <CheckCircle2 size={16} aria-hidden="true" /> Installed
          </span>
        )}
      </header>

      <section className="app-detail-install" aria-label="Install">
        <div className="app-detail-version">
          <label htmlFor="app-version">Version</label>
          {versionsLoading ? (
            <span className="app-detail-versions-loading">
              <RefreshCw size={12} className="spinning" /> Loading…
            </span>
          ) : versions.length > 0 ? (
            <select
              id="app-version"
              className="app-detail-version-select"
              data-testid="version-picker"
              value={selectedVersion}
              onChange={(e) => onSelectVersion(e.target.value)}
              disabled={installing}
            >
              {versions.map((v, i) => (
                <option key={v.semver} value={v.semver}>
                  {i === 0 ? `${v.semver} (latest)` : v.semver}
                </option>
              ))}
            </select>
          ) : (
            <span className="app-detail-version-static">{selectedVersion || app.latest_version}</span>
          )}
        </div>

        <button
          className="button button-primary"
          data-testid="detail-install"
          onClick={onInstall}
          disabled={installing || versionsLoading}
        >
          {installing ? (
            <>
              <RefreshCw size={16} className="spinning" /> Installing…
            </>
          ) : app.installed ? (
            <>
              <Download size={16} /> Install again
            </>
          ) : (
            <>
              <Download size={16} /> Install
            </>
          )}
        </button>

        <button
          className="button button-secondary"
          onClick={() => void invoke("open_url_in_browser", { url: registryUrl })}
        >
          <ExternalLink size={14} /> View on Registry
        </button>
      </section>

      <section className="app-detail-meta" aria-label="Details">
        {rows.map((row) => (
          <div className="app-detail-meta-row" key={row.label}>
            <span className="app-detail-meta-label">{row.label}</span>
            <span className="app-detail-meta-value">{row.value}</span>
          </div>
        ))}
      </section>

      {tags.length > 0 && (
        <section className="app-detail-tags" aria-label="Tags">
          {tags.map((t) => (
            <span className="app-detail-tag" key={t}>
              {t}
            </span>
          ))}
        </section>
      )}
    </div>
  );
}
