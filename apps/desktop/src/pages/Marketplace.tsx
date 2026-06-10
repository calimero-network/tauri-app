import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { getSettings } from "../utils/settings";
import { fetchAppsFromAllRegistries, fetchAppVersions, fetchAppManifest, recordDownload, type AppSummary, type VersionInfo } from "../utils/registry";
import { apiClient } from "../lib/mero-client";
import { decodeMetadata } from "../utils/appUtils";
import {
  getMarketplaceCache,
  setMarketplaceCache,
  touchMarketplaceCache,
  invalidateMarketplaceCache,
} from "../utils/marketplaceCache";
import { truncateText } from "../utils/string";
import { useToast } from "../contexts/ToastContext";
import Skeleton from "../components/Skeleton";
import { Search, RefreshCw, Package, Download, CheckCircle2, X, ExternalLink } from "lucide-react";
import bs58 from "bs58";
import "./Marketplace.css";

interface MarketplaceApp extends AppSummary {
  registry: string;
  installed?: boolean;
}

interface MarketplaceProps {
  clientReady?: boolean;
}

export default function Marketplace({ clientReady = true }: MarketplaceProps) {
  const toast = useToast();
  const [apps, setApps] = useState<MarketplaceApp[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [installedAppIds, setInstalledAppIds] = useState<Set<string>>(new Set());
  const [filterInstalled, setFilterInstalled] = useState<'all' | 'installed' | 'not-installed'>('all');
  const [installingAppId, setInstallingAppId] = useState<string | null>(null);
  // Track whether a background refresh is in progress (no skeleton shown)
  const [refreshing, setRefreshing] = useState(false);
  const [selectedApp, setSelectedApp] = useState<MarketplaceApp | null>(null);
  // Version picker for the detail modal: the versions the registry offers for
  // the open app, and which one Install will fetch (defaults to latest).
  const [availableVersions, setAvailableVersions] = useState<VersionInfo[]>([]);
  const [selectedVersion, setSelectedVersion] = useState<string>("");
  const [versionsLoading, setVersionsLoading] = useState(false);
  const mountedRef = useRef(true);

  // Cleanup on unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Load installed apps when client becomes ready
  useEffect(() => {
    if (clientReady) {
      loadInstalledApps();
    }
  }, [clientReady]);

  // Load the open app's published versions for the picker; default the
  // selection to its latest. Cleared when the modal closes.
  // Depends on id+registry (not the full object) so patching installed:true
  // after an install doesn't re-run this and reset the user's version pick.
  // Registry is included so the same package id from a different registry
  // gets a fresh version list.
  useEffect(() => {
    if (!selectedApp) {
      setAvailableVersions([]);
      setSelectedVersion("");
      setVersionsLoading(false);
      return;
    }
    setAvailableVersions([]);
    setSelectedVersion(selectedApp.latest_version);
    setVersionsLoading(true);
    let cancelled = false;
    fetchAppVersions(selectedApp.registry, selectedApp.id)
      .then((vs) => {
        if (!cancelled) {
          setAvailableVersions(vs);
          // Use the newest non-yanked version from the registry (may differ from
          // the listing row's latest_version if that version is yanked).
          setSelectedVersion(vs[0]?.semver ?? selectedApp.latest_version);
          setVersionsLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAvailableVersions([]);
          setVersionsLoading(false);
          toast.error("Failed to load version list");
        }
      });
    return () => { cancelled = true; };
  }, [selectedApp?.id, selectedApp?.registry]);

  // -----------------------------------------------------------------------
  // Helper: build MarketplaceApp[] from raw registry results + installed set
  // -----------------------------------------------------------------------
  const buildApps = useCallback(
    (results: { registry: string; apps: AppSummary[] }[], installed: Set<string>): MarketplaceApp[] => {
      const allApps: MarketplaceApp[] = [];
      results.forEach(({ registry, apps: registryApps }) => {
        registryApps.forEach((app) => {
          allApps.push({
            ...app,
            registry,
            installed: installed.has(app.name) || installed.has(app.id),
          });
        });
      });
      return allApps;
    },
    []
  );

  // -----------------------------------------------------------------------
  // Load installed apps (returns the set of installed names)
  // -----------------------------------------------------------------------
  const loadInstalledApps = useCallback(async (): Promise<Set<string>> => {
    try {
      const response = await apiClient.node.listApplications();
      if (response.error) {
        if (response.error.code === '401') {
          console.warn("📦 Marketplace: 401 Unauthorized - token may be expired");
          window.location.reload();
          return new Set();
        }
        console.error("Failed to load installed apps:", response.error.message);
        return new Set();
      }

      if (response.data) {
        const appsList = Array.isArray(response.data) ? response.data : [];
        // Build a set of installed app names from decoded metadata.
        // The node-assigned app.id (a hash) does NOT match the registry package id,
        // so we extract the name from metadata (set during install) to correlate.
        const installedNames = new Set<string>();
        for (const app of appsList as any[]) {
          const meta = decodeMetadata(app.metadata);
          if (meta?.name) {
            installedNames.add(meta.name);
          }
          if (app.name) {
            installedNames.add(app.name);
          }
          if (app.source) {
            installedNames.add(app.source);
          }
        }
        if (mountedRef.current) setInstalledAppIds(installedNames);
        return installedNames;
      }
    } catch (err: any) {
      if (err?.status === 401 || err?.code === '401') {
        console.warn("📦 Marketplace: 401 Unauthorized - reloading to trigger login");
        window.location.reload();
        return new Set();
      }
      console.error("Failed to load installed apps:", err);
    }
    return new Set();
  }, []);

  // -----------------------------------------------------------------------
  // Fetch marketplace apps from registries (network call)
  // -----------------------------------------------------------------------
  const fetchMarketplaceApps = useCallback(async (
    registries: string[],
    installed: Set<string>
  ): Promise<MarketplaceApp[]> => {
    const results = await fetchAppsFromAllRegistries(registries);
    // Persist to cache
    setMarketplaceCache(registries, results);
    return buildApps(results, installed);
  }, [buildApps]);

  // -----------------------------------------------------------------------
  // Full load: try cache first, then network
  // -----------------------------------------------------------------------
  const loadMarketplaceApps = useCallback(async (
    knownInstalled?: Set<string>,
    forceRefresh = false
  ) => {
    const installed = knownInstalled ?? installedAppIds;
    const settings = getSettings();
    const registries = settings.registries || [];

    if (registries.length === 0) {
      if (mountedRef.current) {
        setError("No registries configured. Please add registries in Settings.");
      }
      return;
    }

    // 1. Try serving from cache (instant UI)
    if (!forceRefresh) {
      const cached = getMarketplaceCache(registries);
      if (cached) {
        const cachedApps = buildApps(cached.results, installed);
        if (mountedRef.current) {
          setApps(cachedApps);
          setError(null);
        }

        // If stale, do a background refresh (no skeleton)
        if (cached.isStale) {
          if (mountedRef.current) setRefreshing(true);
          try {
            const freshApps = await fetchMarketplaceApps(registries, installed);
            if (mountedRef.current) setApps(freshApps);
          } catch (err) {
            console.warn("📦 Marketplace: Background refresh failed, using cached data:", err);
            // Cache data is still valid, just touch timestamp to avoid retry spam
            touchMarketplaceCache();
          } finally {
            if (mountedRef.current) setRefreshing(false);
          }
        }
        return;
      }
    }

    // 2. No cache or force refresh → full network fetch with skeleton
    if (mountedRef.current) {
      setLoading(true);
      setError(null);
    }

    try {
      const freshApps = await fetchMarketplaceApps(registries, installed);
      if (mountedRef.current) setApps(freshApps);
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : "Failed to load applications");
      }
      console.error("Failed to load marketplace apps:", err);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [installedAppIds, buildApps, fetchMarketplaceApps]);

  // -----------------------------------------------------------------------
  // Initialization: load installed apps then marketplace apps
  // -----------------------------------------------------------------------
  useEffect(() => {
    const init = async () => {
      const installed = await loadInstalledApps();
      await loadMarketplaceApps(installed);
    };
    init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -----------------------------------------------------------------------
  // Sync installed status whenever installedAppIds changes
  // (e.g. after installing/uninstalling an app)
  // installedAppIds contains app names (from metadata), not node-assigned IDs
  // -----------------------------------------------------------------------
  useEffect(() => {
    setApps((prev) => {
      if (prev.length === 0) return prev;
      const updated = prev.map((app) => ({
        ...app,
        installed: installedAppIds.has(app.name) || installedAppIds.has(app.id),
      }));
      const hasChanged = updated.some((app, i) => app.installed !== prev[i].installed);
      return hasChanged ? updated : prev;
    });
  }, [installedAppIds]);

  // -----------------------------------------------------------------------
  // Force refresh handler (refresh button)
  // -----------------------------------------------------------------------
  const handleForceRefresh = useCallback(async () => {
    invalidateMarketplaceCache();
    const installed = await loadInstalledApps();
    await loadMarketplaceApps(installed, true);
  }, [loadInstalledApps, loadMarketplaceApps]);

  // Filter and sort apps
  const filteredAndSortedApps = useMemo(() => {
    let filtered = apps;

    // Apply search query filter (client-side for better UX)
    if (searchQuery && searchQuery.trim()) {
      const query = searchQuery.trim().toLowerCase();
      filtered = filtered.filter(app => {
        const appName = (app.alias || app.name || '').toLowerCase();
        const appDescription = (app.description || '').toLowerCase();
        const appId = (app.id || '').toLowerCase();
        const appAuthor = (app.author || app.developer_pubkey || '').toLowerCase();
        // Match if query appears in name, description, id, or author
        return appName.includes(query) ||
               appDescription.includes(query) ||
               appId.includes(query) ||
               appAuthor.includes(query);
      });
    }

    // Apply installed filter
    if (filterInstalled === 'installed') {
      filtered = filtered.filter(app => app.installed);
    } else if (filterInstalled === 'not-installed') {
      filtered = filtered.filter(app => !app.installed);
    }

    // Sort by name
    const sorted = [...filtered].sort((a, b) => {
      return (a.alias || a.name).localeCompare(b.alias || b.name);
    });

    return sorted;
  }, [apps, filterInstalled, searchQuery]);

  const handleInstall = async (app: MarketplaceApp, version: string = app.latest_version) => {
    if (!/^[\w.+-]+$/.test(version)) {
      toast.error("Invalid version string");
      return;
    }
    setInstallingAppId(app.id);
    try {
      const manifest = await fetchAppManifest(app.registry, app.id, version);

      // Handle both v1 format (artifact) and v2 format (artifacts array)
      let wasmUrl: string;
      let wasmHashHex: string | null = null;
      
      if (manifest.artifact) {
        // V1 format: single artifact object
        if (!manifest.artifact.uri) {
          toast.error("Invalid manifest: artifact URI is missing");
          return;
        }
        wasmUrl = manifest.artifact.uri;
        // Extract hash from digest (format: "sha256:...")
        wasmHashHex = manifest.artifact.digest?.replace('sha256:', '') || null;
      } else if (manifest.artifacts && manifest.artifacts.length > 0) {
        // V2 format: artifacts array
        // V2 bundles use MPK files, but also check for WASM for backward compatibility
        const mpkArtifact = manifest.artifacts.find(a => a.type === 'mpk');
        const wasmArtifact = manifest.artifacts.find(a => a.type === 'wasm');
        
        if (mpkArtifact) {
          // V2 bundle: MPK file
          wasmUrl = mpkArtifact.mirrors?.[0] || `https://ipfs.io/ipfs/${mpkArtifact.cid}`;
          wasmHashHex = mpkArtifact.sha256?.replace('sha256:', '') || null;
          // If no sha256, try using cid if it looks like a hex hash (64 chars)
          if (!wasmHashHex && mpkArtifact.cid && /^[0-9a-f]{64}$/i.test(mpkArtifact.cid)) {
            wasmHashHex = mpkArtifact.cid;
          }
        } else if (wasmArtifact) {
          // Fallback: WASM artifact (v1 or legacy v2)
          wasmUrl = wasmArtifact.mirrors?.[0] || `https://ipfs.io/ipfs/${wasmArtifact.cid}`;
          wasmHashHex = wasmArtifact.sha256?.replace('sha256:', '') || null;
          // If no sha256, try using cid if it looks like a hex hash (64 chars)
          if (!wasmHashHex && wasmArtifact.cid && /^[0-9a-f]{64}$/i.test(wasmArtifact.cid)) {
            wasmHashHex = wasmArtifact.cid;
          }
        } else {
          console.error("📦 Marketplace: No MPK or WASM artifact found in:", manifest.artifacts);
          toast.error("No MPK or WASM artifact found in application manifest");
          return;
        }
      } else {
        console.error("📦 Marketplace: No artifacts found in manifest:", manifest);
        toast.error("No WASM artifact found in application manifest");
        return;
      }
      
      // Convert hex hash to base58 if available
      let wasmHashBase58: string | undefined = undefined;
      if (wasmHashHex && wasmHashHex.length === 64) {
        // Convert hex string to bytes, then to base58
        try {
          const hashBytes = Uint8Array.from(
            wasmHashHex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16))
          );
          wasmHashBase58 = bs58.encode(hashBytes);
        } catch (error) {
          console.warn("Failed to convert hash to base58:", error);
          // Continue without hash - server can compute it
        }
      }
      
      // Create metadata without alias
      const metadata = {
        name: app.name,
        description: manifest.metadata?.description || "",
        version,
        developer: app.developer_pubkey,
        minRuntimeVersion: manifest.minRuntimeVersion,
      };
      // Convert metadata JSON string to byte array (Vec<u8> in Rust)
      // serde_json expects Vec<u8> as an array of numbers [1, 2, 3]
      const metadataJson = JSON.stringify(metadata);
      const metadataBytes = Array.from(new TextEncoder().encode(metadataJson));

      // Install the application
      const request: any = {
        url: wasmUrl,
        // For MPK bundles, use empty metadata (backend will use bundle manifest metadata)
        // For WASM files, include metadata
        metadata: wasmUrl.endsWith('.mpk') ? [] : metadataBytes,
      };
      // Include hash in base58 format if we have it
      // Note: For MPK files, we should use the MPK file's hash, not the WASM hash
      // For now, only include hash if we're sure it matches the file being downloaded
      // (i.e., for WASM files, not MPK files until we have actual MPK hashes)
      if (wasmHashBase58 && !wasmUrl.endsWith('.mpk')) {
        request.hash = wasmHashBase58;
      }
      // For MPK files, don't provide hash until we have the actual MPK file hash
      // The node will compute it during download
      
      
      const response = await apiClient.node.installApplication(request);
      

      if (response.error) {
        console.error("📦 Marketplace: Install error:", response.error);
        const msg = response.error.message ? truncateText(response.error.message, 120) : 'Unknown error';
        toast.error(`Failed to install: ${msg}`);
        return;
      }

      toast.success(`${app.alias || app.name} installed successfully!`);

      // Record download with registry (fire-and-forget)
      recordDownload(app.registry, app.id, version);

      // Update just the changed card — no full reload, no flicker.
      // loadInstalledApps updates installedAppIds, which the sync useEffect
      // uses to flip installed:true on the affected card only.
      await loadInstalledApps();
      // Refresh the open modal so it shows "Installed" instead of "Install".
      setSelectedApp((prev) => prev?.id === app.id ? { ...prev, installed: true } : prev);
    } catch (err) {
      console.error("📦 Marketplace: Install exception:", err);
      const msg = truncateText(err instanceof Error ? err.message : "Unknown error", 120);
      toast.error(`Failed to install: ${msg}`);
    } finally {
      setInstallingAppId(null);
    }
  };


  const registryUrl = useMemo(() => {
    const reg = getSettings().registries?.[0];
    if (!reg) return null;
    try { return new URL(reg).origin; } catch { return reg.replace(/\/$/, ''); }
  }, []);

  return (
    <div className="marketplace-page">
      <header className="marketplace-header">
        <h1>Application Marketplace</h1>
        <div className="marketplace-header-row">
          <p>Browse and install applications from configured registries</p>
          {registryUrl && (
            <button
              className="explore-registry-btn"
              onClick={() => invoke('open_url_in_browser', { url: registryUrl })}
            >
              <ExternalLink size={13} />
              Explore Registry on web
            </button>
          )}
        </div>
      </header>

      <main className="marketplace-main">
        <div className="marketplace-controls">
          <div className="search-container">
            <Search className="search-icon" size={18} />
          <input
            type="text"
            placeholder="Search applications..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="search-input"
          />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="search-clear"
                aria-label="Clear search"
              >
                <X size={14} />
          </button>
            )}
          </div>
          
          <div className="marketplace-filters">
            <div className="filter-pills">
              {(['all', 'installed', 'not-installed'] as const).map((f) => (
                <button
                  key={f}
                  className={`filter-pill${filterInstalled === f ? ' active' : ''}`}
                  onClick={() => setFilterInstalled(f)}
                >
                  {f === 'all' ? 'All' : f === 'installed' ? 'Installed' : 'Not Installed'}
                </button>
              ))}
            </div>
            <button
              onClick={handleForceRefresh}
              className="refresh-btn"
              disabled={loading || refreshing}
              title="Refresh"
            >
              <RefreshCw size={15} className={loading || refreshing ? 'spinning' : ''} />
            </button>
          </div>
        </div>

        {error && (
          <div className="error-message">
            {error}
          </div>
        )}

        {loading ? (
          <div className="apps-grid">
            {Array.from({ length: 6 }).map((_, index) => (
              <div key={index} className="app-card skeleton-card">
                <div className="app-card-header">
                  <Skeleton variant="rectangular" width="40px" height="40px" borderRadius="10px" />
                  <div className="app-title-section">
                    <Skeleton variant="text" width="70%" height="16px" />
                    <Skeleton variant="text" width="40%" height="12px" />
                  </div>
                </div>
                <div className="app-card-description">
                  <Skeleton variant="text" width="100%" height="13px" />
                  <div style={{ marginTop: 6 }}><Skeleton variant="text" width="85%" height="13px" /></div>
                  <div style={{ marginTop: 6 }}><Skeleton variant="text" width="60%" height="13px" /></div>
                </div>
                <div className="app-card-footer">
                  <div className="app-meta">
                    <Skeleton variant="text" width="80%" height="12px" />
                    <div style={{ marginTop: 4 }}><Skeleton variant="text" width="60%" height="12px" /></div>
                  </div>
                </div>
                <div className="app-card-actions">
                  <Skeleton variant="rectangular" width="100%" height="38px" borderRadius="10px" />
                </div>
              </div>
            ))}
          </div>
        ) : filteredAndSortedApps.length === 0 ? (
          <div className="empty-state">
            <Package size={48} className="empty-icon" />
            <h3>No applications found</h3>
            {searchQuery ? (
              <p>Try adjusting your search query or filters.</p>
            ) : getSettings().registries?.length === 0 ? (
              <p>
                <a href="#settings">Configure registries in Settings</a> to browse applications.
              </p>
            ) : (
              <p>No applications match your current filters.</p>
            )}
          </div>
        ) : (
          <div className="apps-grid">
            {filteredAndSortedApps.map((app, index) => {
              const shortPubkey = app.developer_pubkey && app.developer_pubkey.length > 12
                ? `${app.developer_pubkey.slice(0, 6)}...${app.developer_pubkey.slice(-4)}`
                : app.developer_pubkey;
              const description = app.description || "No description available.";

              return (
                <div
                  key={`${app.developer_pubkey}-${app.name}-${index}`}
                  className="app-card"
                  data-testid="app-card"
                  onClick={() => setSelectedApp(app)}
                >
                  <div className="app-card-header">
                    <div className="app-icon-wrapper">
                      <Package className="app-icon" size={20} />
                    </div>
                    <div className="app-title-section">
                      <h3>{app.alias || app.name}</h3>
                      {app.latest_version && (
                        <span className="app-version-badge">v{app.latest_version}</span>
                      )}
                    </div>
                    {app.installed && (
                      <CheckCircle2 className="installed-icon" size={18} />
                    )}
                  </div>

                  <div className="app-card-description">
                    <p>{description}</p>
                  </div>

                  <div className="app-card-footer">
                    <div className="app-meta">
                      <div className="app-meta-row">
                        <span className="app-meta-label">Author:</span>
                        <span className="app-meta-value">
                          {app.author || (shortPubkey && shortPubkey !== 'unknown' ? shortPubkey : '—')}
                        </span>
                      </div>
                      <div className="app-meta-row">
                        <span className="app-meta-label">Downloads:</span>
                        <span className="app-meta-value">{(app.downloads ?? 0).toLocaleString()}</span>
                      </div>
                    </div>
                  </div>

                  <div className="app-card-actions" onClick={(e) => e.stopPropagation()}>
                    {app.installed ? (
                      <button className="button button-success" disabled>
                        <CheckCircle2 size={16} />
                        Installed
                      </button>
                    ) : (
                      <button
                        onClick={() => setSelectedApp(app)}
                        className="button button-primary"
                        disabled={installingAppId === app.id}
                      >
                        {installingAppId === app.id ? (
                          <>
                            <RefreshCw size={16} className="spinning" />
                            Installing...
                          </>
                        ) : (
                          <>
                            <span className="install-icon-wrap"><Download size={16} /></span>
                            Install
                          </>
                        )}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>

      {selectedApp && (
        <div className="app-detail-overlay" onClick={() => setSelectedApp(null)}>
          <div className="app-detail-modal" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setSelectedApp(null)}>
              <X size={18} />
            </button>
            <div className="modal-header">
              <div className="app-icon-wrapper modal-icon">
                <Package size={28} className="app-icon" />
              </div>
              <div className="modal-title">
                <h2>{selectedApp.alias || selectedApp.name}</h2>
                {selectedApp.latest_version && (
                  <span className="app-version-badge">v{selectedApp.latest_version}</span>
                )}
              </div>
              {selectedApp.installed && (
                <CheckCircle2 className="installed-icon" size={22} />
              )}
            </div>
            <p className="modal-description">
              {selectedApp.description || "No description available."}
            </p>
            <div className="modal-meta">
              <div className="modal-meta-row">
                <span className="modal-meta-label">Package ID</span>
                <span className="modal-meta-value mono">{selectedApp.id}</span>
              </div>
              <div className="modal-meta-row">
                <span className="modal-meta-label">Author</span>
                <span className="modal-meta-value">
                  {selectedApp.author || (
                    selectedApp.developer_pubkey
                      ? `${selectedApp.developer_pubkey.slice(0, 8)}...${selectedApp.developer_pubkey.slice(-6)}`
                      : '—'
                  )}
                </span>
              </div>
              <div className="modal-meta-row">
                <span className="modal-meta-label">Downloads</span>
                <span className="modal-meta-value">{(selectedApp.downloads ?? 0).toLocaleString()}</span>
              </div>
              <div className="modal-meta-row">
                <span className="modal-meta-label">Version</span>
                {versionsLoading ? (
                  <span className="modal-meta-value modal-versions-loading">
                    <RefreshCw size={12} className="spinning" /> Loading…
                  </span>
                ) : availableVersions.length > 1 ? (
                  <select
                    className="modal-version-select"
                    value={selectedVersion}
                    onChange={(e) => setSelectedVersion(e.target.value)}
                    disabled={installingAppId === selectedApp.id || selectedApp.installed}
                    data-testid="version-picker"
                  >
                    {availableVersions.map((v) => (
                      <option key={v.semver} value={v.semver}>
                        {v.semver === availableVersions[0]?.semver ? `${v.semver} (latest)` : v.semver}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="modal-meta-value">{selectedVersion || selectedApp.latest_version}</span>
                )}
              </div>
              <div className="modal-meta-row">
                <span className="modal-meta-label">Registry</span>
                <button
                  className="modal-meta-link"
                  onClick={(e) => {
                    e.stopPropagation();
                    const url = (() => { try { return `${new URL(selectedApp.registry).origin}/apps/${encodeURIComponent(selectedApp.id)}`; } catch { return `${selectedApp.registry.replace(/\/$/, '')}/apps/${encodeURIComponent(selectedApp.id)}`; } })();
                    invoke('open_url_in_browser', { url });
                  }}
                >
                  View on Registry
                </button>
              </div>
            </div>
            <div className="modal-actions">
              {selectedApp.installed ? (
                <button className="button button-success" disabled>
                  <CheckCircle2 size={16} />
                  Installed
                </button>
              ) : (
                <button
                  onClick={() => handleInstall(selectedApp, selectedVersion || selectedApp.latest_version)}
                  className="button button-primary"
                  disabled={installingAppId === selectedApp.id}
                >
                  {installingAppId === selectedApp.id ? (
                    <><RefreshCw size={16} className="spinning" /> Installing...</>
                  ) : (
                    <><span className="install-icon-wrap"><Download size={16} /></span>Install</>
                  )}
                </button>
              )}
              <button className="button button-secondary" onClick={() => setSelectedApp(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

