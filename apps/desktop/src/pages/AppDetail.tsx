import React, { useEffect, useState } from "react";
import {
  ArrowLeft,
  BookOpen,
  CheckCircle2,
  Code2,
  Download,
  ExternalLink,
  ImageOff,
  Monitor,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import AppIcon from "../components/AppIcon";
import VersionSelect from "../components/VersionSelect";
import { VerifiedMark } from "../components/AppCard";
import { formatBytes, formatCategory, formatRelativeDate, shortenKey } from "../utils/appCards";
import { fetchPackageAssets, type AppSummary, type PackageAsset, type VersionInfo } from "../utils/registry";
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
  // Preview images. ⚠️ Every published package returns an empty list today —
  // the asset bucket is still open infrastructure — so this renders a stated
  // empty case rather than an empty region.
  const [assets, setAssets] = useState<PackageAsset[]>([]);
  const [assetsLoading, setAssetsLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setAssetsLoading(true);
    void fetchPackageAssets(app.registry, app.id).then((list) => {
      if (cancelled) return;
      setAssets(list);
      setAssetsLoading(false);
    });
    return () => { cancelled = true; };
  }, [app.registry, app.id]);

  const title = app.alias || app.name;
  const author = app.author ?? shortenKey(app.developer_pubkey);
  const category = formatCategory(app.category);
  // ⚠️ `installSize ?? wasm.size` — see AppCard. `installSize` is null on every
  // published bundle; `wasm.size` is populated on every one.
  const bytes = formatBytes(app.installSize ?? app.wasm?.size);
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
  if (app.minRuntimeVersion) {
    rows.push({
      label: "Requires node",
      value: <span className="app-detail-mono">{app.minRuntimeVersion}</span>,
    });
  }
  if (when) rows.push({ label: "Published", value: when });
  if (app.signerId) {
    rows.push({
      label: "Signed by",
      value: (
        <span className="app-detail-signer">
          <ShieldCheck size={13} aria-hidden="true" />
          <span className="app-detail-mono">{app.signerId}</span>
        </span>
      ),
    });
  }

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
          {/* A plain label: the picker is a button + listbox now, not a form
              control, so `htmlFor` would point at nothing. The trigger carries
              its own aria-label. */}
          <span className="app-detail-version-label">Version</span>
          {versionsLoading ? (
            <span className="app-detail-versions-loading">
              <RefreshCw size={12} className="spinning" /> Loading…
            </span>
          ) : versions.length > 0 ? (
            <VersionSelect
              versions={versions}
              value={selectedVersion}
              onChange={onSelectVersion}
              disabled={installing}
            />
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

      {/* ⚠️ A STATED EMPTY CASE, NOT A HIDDEN SECTION. Every published package
          returns `assets: []` right now (the bucket is still open infra), so a
          section that simply vanished would make every app page look
          unfinished and give nobody a reason to upload one. */}
      <section className="app-detail-section" aria-label="Preview">
        <p className="app-detail-section-heading">Preview</p>
        {assetsLoading ? (
          <div className="app-detail-preview-empty">
            <RefreshCw size={16} className="spinning" /> Loading preview…
          </div>
        ) : assets.length > 0 ? (
          <div className="app-detail-preview-strip">
            {assets.map((a, i) => (
              <button
                key={a.id ?? a.url ?? i}
                type="button"
                className="app-detail-shot"
                onClick={() => a.url && void invoke("open_url_in_browser", { url: a.url })}
              >
                <img
                  src={a.thumbnailUrl ?? a.url}
                  alt={a.alt ?? `${title} screenshot ${i + 1}`}
                  loading="lazy"
                  decoding="async"
                />
              </button>
            ))}
          </div>
        ) : (
          <div className="app-detail-preview-empty">
            <ImageOff size={18} aria-hidden="true" />
            <span>
              No preview images published for this app yet. Publishers add them
              on the registry.
            </span>
          </div>
        )}
      </section>

      {(app.links?.github || app.links?.docs || app.links?.frontend) && (
        <section className="app-detail-section" aria-label="Links">
          <p className="app-detail-section-heading">Links</p>
          <div className="app-detail-links">
            {app.links?.frontend && (
              <LinkCard icon={Monitor} label="Try it out on web" href={app.links.frontend} />
            )}
            {app.links?.github && (
              <LinkCard icon={Code2} label="Source code" href={app.links.github} />
            )}
            {app.links?.docs && (
              <LinkCard icon={BookOpen} label="Documentation" href={app.links.docs} />
            )}
          </div>
        </section>
      )}

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

/** One outbound link, opened in the user's browser rather than in the app. */
function LinkCard({ icon: Icon, label, href }: { icon: typeof Monitor; label: string; href: string }) {
  return (
    <button type="button" className="app-detail-link-card" title={href}
      onClick={() => void invoke("open_url_in_browser", { url: href })}>
      <Icon size={15} aria-hidden="true" />
      <span className="app-detail-link-label">{label}</span>
      <ExternalLink size={12} aria-hidden="true" />
    </button>
  );
}
