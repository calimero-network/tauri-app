import { useState, useEffect, useMemo } from "react";
import { getSettings } from "../utils/settings";
import { fetchAppsFromAllRegistries, type AppSummary } from "../utils/registry";
import { apiClient } from "@calimero-network/mero-react";
import { decodeMetadata } from "../utils/appUtils";
import { useToast } from "../contexts/ToastContext";
import Skeleton from "../components/Skeleton";
import { Search, RefreshCw, Package, Download, CheckCircle2, X } from "lucide-react";
import bs58 from "bs58";
import "./Marketplace.css";

interface MarketplaceApp extends AppSummary {
  registry: string;
  installed?: boolean;
}

export default function Marketplace() {
  const toast = useToast();
  const [apps, setApps] = useState<MarketplaceApp[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [installedAppIds, setInstalledAppIds] = useState<Set<string>>(new Set());
  const [filterInstalled, setFilterInstalled] = useState<'all' | 'installed' | 'not-installed'>('all');
  const [installingAppId, setInstallingAppId] = useState<string | null>(null);

  // Load installed apps first, then marketplace apps (sequential to avoid stale closure)
  useEffect(() => {
    const init = async () => {
      const installed = await loadInstalledApps();
      await loadMarketplaceApps(installed);
    };
    init();
  }, []);

  // Sync installed status whenever installedAppIds changes (e.g. after installing an app)
  // installedAppIds now contains app names (from metadata), not node-assigned IDs
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

  const loadInstalledApps = async (): Promise<Set<string>> => {
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
        const apps = Array.isArray(response.data) ? response.data : [];
        // Build a set of installed app names from decoded metadata.
        // The node-assigned app.id (a hash) does NOT match the registry package id,
        // so we extract the name from metadata (set during install) to correlate.
        const installedNames = new Set<string>();
        for (const app of apps as any[]) {
          const meta = decodeMetadata(app.metadata);
          if (meta?.name) {
            installedNames.add(meta.name);
          }
          // Also add the direct name field if the backend provides it
          if (app.name) {
            installedNames.add(app.name);
          }
          // Also add source if it might be a package identifier
          if (app.source) {
            installedNames.add(app.source);
          }
        }
        console.log("📦 Marketplace: Installed app names:", [...installedNames]);
        setInstalledAppIds(installedNames);
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
  };

  const loadMarketplaceApps = async (knownInstalled?: Set<string>) => {
    setLoading(true);
    setError(null);

    // Use the passed-in set, or fall back to current state
    const installed = knownInstalled ?? installedAppIds;

    try {
      const settings = getSettings();
      const registries = settings.registries || [];

      if (registries.length === 0) {
        setError("No registries configured. Please add registries in Settings.");
        setLoading(false);
        return;
      }

      const results = await fetchAppsFromAllRegistries(registries, {
        name: searchQuery || undefined,
      });

      // Flatten apps from all registries
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

      setApps(allApps);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load applications");
      console.error("Failed to load marketplace apps:", err);
    } finally {
      setLoading(false);
    }
  };

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

  const handleInstall = async (app: MarketplaceApp) => {
    console.log("📦 Marketplace: Install button clicked for app:", app);
    setInstallingAppId(app.id);
    try {
      // Fetch the manifest to get the WASM artifact URL
      const { fetchAppManifest } = await import("../utils/registry");
      const manifest = await fetchAppManifest(app.registry, app.id, app.latest_version);
      
      console.log("📦 Marketplace: Fetched manifest:", manifest);
      
      // Handle both v1 format (artifact) and v2 format (artifacts array)
      let wasmUrl: string;
      let wasmHashHex: string | null = null;
      
      if (manifest.artifact) {
        // V1 format: single artifact object
        console.log("📦 Marketplace: Using v1 format");
        if (!manifest.artifact.uri) {
          toast.error("Invalid manifest: artifact URI is missing");
          return;
        }
        wasmUrl = manifest.artifact.uri;
        // Extract hash from digest (format: "sha256:...")
        wasmHashHex = manifest.artifact.digest?.replace('sha256:', '') || null;
      } else if (manifest.artifacts && manifest.artifacts.length > 0) {
        // V2 format: artifacts array
        console.log("📦 Marketplace: Using v2 format, artifacts:", manifest.artifacts);
        // V2 bundles use MPK files, but also check for WASM for backward compatibility
        const mpkArtifact = manifest.artifacts.find(a => a.type === 'mpk');
        const wasmArtifact = manifest.artifacts.find(a => a.type === 'wasm');
        
        if (mpkArtifact) {
          // V2 bundle: MPK file
          console.log("📦 Marketplace: Found MPK artifact:", mpkArtifact);
          wasmUrl = mpkArtifact.mirrors?.[0] || `https://ipfs.io/ipfs/${mpkArtifact.cid}`;
          wasmHashHex = mpkArtifact.sha256?.replace('sha256:', '') || null;
          // If no sha256, try using cid if it looks like a hex hash (64 chars)
          if (!wasmHashHex && mpkArtifact.cid && /^[0-9a-f]{64}$/i.test(mpkArtifact.cid)) {
            wasmHashHex = mpkArtifact.cid;
          }
          console.log("📦 Marketplace: MPK URL:", wasmUrl, "Hash (hex):", wasmHashHex);
        } else if (wasmArtifact) {
          // Fallback: WASM artifact (v1 or legacy v2)
          console.log("📦 Marketplace: Found WASM artifact:", wasmArtifact);
          wasmUrl = wasmArtifact.mirrors?.[0] || `https://ipfs.io/ipfs/${wasmArtifact.cid}`;
          wasmHashHex = wasmArtifact.sha256?.replace('sha256:', '') || null;
          // If no sha256, try using cid if it looks like a hex hash (64 chars)
          if (!wasmHashHex && wasmArtifact.cid && /^[0-9a-f]{64}$/i.test(wasmArtifact.cid)) {
            wasmHashHex = wasmArtifact.cid;
          }
          console.log("📦 Marketplace: WASM URL:", wasmUrl, "Hash (hex):", wasmHashHex);
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
        version: app.latest_version,
        developer: app.developer_pubkey,
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
      
      console.log("📦 Marketplace: Installing with request:", { ...request, metadata: `[${metadataBytes.length} bytes]` });
      
      const response = await apiClient.node.installApplication(request);
      
      console.log("📦 Marketplace: Install response:", response);

      if (response.error) {
        console.error("📦 Marketplace: Install error:", response.error);
        toast.error(`Failed to install: ${response.error.message}`);
        return;
      }

      console.log("📦 Marketplace: Installation successful:", response.data);
      toast.success(`${app.alias || app.name} installed successfully!`);

      // Reload installed apps (this updates installedAppIds which triggers sync useEffect)
      await loadInstalledApps();
      // Also explicitly mark this app as installed immediately for instant UI feedback
      setApps((prevApps) =>
        prevApps.map((a) =>
          a.id === app.id || a.name === app.name
            ? { ...a, installed: true }
            : a
        )
      );
    } catch (err) {
      console.error("📦 Marketplace: Install exception:", err);
      toast.error(`Failed to install: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setInstallingAppId(null);
    }
  };


  return (
    <div className="marketplace-page">
      <header className="marketplace-header">
        <h1>Application Marketplace</h1>
        <p>Browse and install applications from configured registries</p>
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
            <select
              value={filterInstalled}
              onChange={(e) => setFilterInstalled(e.target.value as any)}
              className="filter-select"
            >
              <option value="all">All Apps</option>
              <option value="installed">Installed</option>
              <option value="not-installed">Not Installed</option>
            </select>
            
            <button 
              onClick={() => loadMarketplaceApps()} 
              className="button button-secondary"
              disabled={loading}
              title="Refresh applications"
            >
              <RefreshCw size={16} className={loading ? 'spinning' : ''} />
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
                  <Skeleton variant="text" width="60%" height="20px" />
                  <Skeleton variant="rectangular" width="70px" height="24px" borderRadius="12px" />
                </div>
                <div className="app-card-body">
                  <Skeleton variant="text" width="80%" height="14px" />
                  <Skeleton variant="text" width="50%" height="14px" />
                  <Skeleton variant="text" width="70%" height="14px" />
                  <Skeleton variant="text" width="60%" height="14px" />
                </div>
                <div className="skeleton-card-actions">
                  <Skeleton variant="rectangular" width="100px" height="36px" borderRadius="4px" />
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
              // Shorten developer pubkey for display
              const shortPubkey = app.developer_pubkey && app.developer_pubkey.length > 12
                ? `${app.developer_pubkey.slice(0, 6)}...${app.developer_pubkey.slice(-4)}`
                : app.developer_pubkey;
              
              return (
              <div key={`${app.developer_pubkey}-${app.name}-${index}`} className="app-card">
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
                  
                  {app.description && (
                    <div className="app-card-description">
                      <p>{app.description}</p>
                    </div>
                  )}

                  <div className="app-card-footer">
                    <div className="app-meta">
                      <div className="app-meta-row">
                        <span className="app-meta-label">Package:</span>
                        <span className="app-meta-value" title={app.id}>{app.id}</span>
                      </div>
                      <div className="app-meta-row">
                        <span className="app-meta-label">Author:</span>
                        <span className="app-meta-value">
                          {app.author || (shortPubkey && shortPubkey !== 'unknown' ? shortPubkey : '—')}
                        </span>
                      </div>
                    </div>
                  </div>
                  
                <div className="app-card-actions">
                  {app.installed ? (
                      <button className="button button-success" disabled>
                        <CheckCircle2 size={16} />
                      Installed
                    </button>
                  ) : (
                    <button
                      onClick={() => handleInstall(app)}
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
                            <Download size={16} />
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
    </div>
  );
}

