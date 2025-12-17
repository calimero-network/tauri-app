import { useState, useEffect } from "react";
import { getSettings } from "../utils/settings";
import { fetchAppsFromAllRegistries, type AppSummary } from "../utils/registry";
import { apiClient } from "@calimero-network/mero-react";
import bs58 from "bs58";
import "./Marketplace.css";

interface MarketplaceApp extends AppSummary {
  registry: string;
  installed?: boolean;
}

export default function Marketplace() {
  const [apps, setApps] = useState<MarketplaceApp[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [installedAppIds, setInstalledAppIds] = useState<Set<string>>(new Set());

  // Load installed applications
  useEffect(() => {
    loadInstalledApps();
  }, []);

  // Load marketplace applications
  useEffect(() => {
    loadMarketplaceApps();
  }, []);

  const loadInstalledApps = async () => {
    try {
      const response = await apiClient.node.listApplications();
      if (response.data) {
        const installed = new Set<string>(
          (response.data as any).apps?.map((app: any) => app.id as string) || []
        );
        setInstalledAppIds(installed);
      }
    } catch (err) {
      console.error("Failed to load installed apps:", err);
    }
  };

  const loadMarketplaceApps = async () => {
    setLoading(true);
    setError(null);

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
          // Use the app.id from the registry
          const appId = app.id;
          allApps.push({
            ...app,
            registry,
            installed: installedAppIds.has(appId),
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

  const handleInstall = async (app: MarketplaceApp) => {
    try {
      // Fetch the manifest to get the WASM artifact URL
      const { fetchAppManifest } = await import("../utils/registry");
      const manifest = await fetchAppManifest(app.registry, app.id, app.latest_version);
      
      // Handle both v1 format (artifact) and v2 format (artifacts array)
      let wasmUrl: string;
      let wasmHashHex: string | null = null;
      
      if (manifest.artifact) {
        // V1 format: single artifact object
        wasmUrl = manifest.artifact.uri;
        // Extract hash from digest (format: "sha256:...")
        wasmHashHex = manifest.artifact.digest?.replace('sha256:', '') || null;
      } else if (manifest.artifacts && manifest.artifacts.length > 0) {
        // V2 format: artifacts array
        const wasmArtifact = manifest.artifacts.find(a => a.type === 'wasm');
        if (!wasmArtifact) {
          alert("No WASM artifact found in application manifest");
          return;
        }
        wasmUrl = wasmArtifact.mirrors?.[0] || `https://ipfs.io/ipfs/${wasmArtifact.cid}`;
        // For v2, hash might be in sha256 field
        wasmHashHex = wasmArtifact.sha256?.replace('sha256:', '') || null;
      } else {
        alert("No WASM artifact found in application manifest");
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
      
      // Create metadata (simplified - you may need to encode more info)
      const metadata = {
        name: app.alias || app.name,
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
        metadata: metadataBytes,
      };
      // Include hash in base58 format if we have it
      if (wasmHashBase58) {
        request.hash = wasmHashBase58;
      }
      
      const response = await apiClient.node.installApplication(request);

      if (response.error) {
        alert(`Failed to install: ${response.error.message}`);
        return;
      }

      alert(`Application installed successfully! ID: ${response.data?.applicationId || 'unknown'}`);

      // Reload installed apps
      await loadInstalledApps();
      // Update the app's installed status
      setApps((prevApps) =>
        prevApps.map((a) =>
          a.id === app.id
            ? { ...a, installed: true }
            : a
        )
      );
    } catch (err) {
      alert(`Failed to install application: ${err instanceof Error ? err.message : "Unknown error"}`);
      console.error("Install error:", err);
    }
  };

  const handleSearch = () => {
    loadMarketplaceApps();
  };

  return (
    <div className="marketplace-page">
      <header className="marketplace-header">
        <h1>Application Marketplace</h1>
        <p>Browse and install applications from configured registries</p>
      </header>

      <main className="marketplace-main">
        <div className="marketplace-search">
          <input
            type="text"
            placeholder="Search applications..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyPress={(e) => e.key === "Enter" && handleSearch()}
            className="search-input"
          />
          <button onClick={handleSearch} className="button button-primary">
            Search
          </button>
          <button onClick={loadMarketplaceApps} className="button">
            Refresh
          </button>
        </div>

        {error && (
          <div className="error-message">
            {error}
          </div>
        )}

        {loading ? (
          <div className="loading">Loading applications...</div>
        ) : apps.length === 0 ? (
          <div className="empty-state">
            <p>No applications found.</p>
            {getSettings().registries?.length === 0 && (
              <p>
                <a href="#settings">Configure registries in Settings</a> to browse applications.
              </p>
            )}
          </div>
        ) : (
          <div className="apps-grid">
            {apps.map((app, index) => (
              <div key={`${app.developer_pubkey}-${app.name}-${index}`} className="app-card">
                <div className="app-card-header">
                  <h3>{app.alias || app.name}</h3>
                  {app.installed && (
                    <span className="installed-badge">Installed</span>
                  )}
                </div>
                <div className="app-card-body">
                  <p className="app-name">Package: {app.name}</p>
                  <p className="app-version">Version: {app.latest_version}</p>
                  <p className="app-developer">
                    Developer: {app.developer_pubkey.substring(0, 16)}...
                  </p>
                  <p className="app-registry">Registry: {new URL(app.registry).hostname}</p>
                </div>
                <div className="app-card-actions">
                  {app.installed ? (
                    <button className="button" disabled>
                      Installed
                    </button>
                  ) : (
                    <button
                      onClick={() => handleInstall(app)}
                      className="button button-primary"
                    >
                      Install
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

