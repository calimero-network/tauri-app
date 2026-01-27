/**
 * Registry client utility for fetching applications from configured registries
 */

export interface AppSummary {
  id: string;
  name: string;
  developer_pubkey: string;
  latest_version: string;
  latest_cid: string;
  alias?: string;
  description?: string;
}

export interface VersionInfo {
  semver: string;
  cid: string;
  yanked?: boolean;
}

export interface AppManifest {
  manifest_version: string;
  // V1 format fields
  id?: string;
  name?: string;
  version?: string | { semver: string }; // V1 (string) or V2 ({ semver: string })
  chains?: string[];
  artifact?: {
    type: string;
    target: string;
    digest?: string; // format: "sha256:..."
    uri: string;
  };
  // V2 format fields
  app?: {
    name: string;
    developer_pubkey: string;
    id: string;
    alias?: string;
  };
  supported_chains?: string[];
  permissions?: Array<{
    cap: string;
    bytes: number;
  }>;
  artifacts?: Array<{
    type: string;
    target: string;
    cid: string;
    size: number;
    mirrors?: string[];
    sha256?: string; // Optional hex hash
  }>;
  metadata?: {
    description?: string;
    author?: string;
    license?: string;
    [key: string]: any;
  };
  distribution?: string;
  signature?: {
    alg: string;
    sig: string;
    signed_at: string;
  };
}

/**
 * Fetch applications from a registry
 * Uses V2 Bundle API
 */
export async function fetchAppsFromRegistry(
  registryUrl: string,
  filters?: { dev?: string; name?: string }
): Promise<AppSummary[]> {
  try {
    const url = new URL('/api/v2/bundles', registryUrl);
    if (filters?.dev) {
      url.searchParams.set('developer', filters.dev);
    }
    if (filters?.name) {
      url.searchParams.set('package', filters.name);
    }

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Registry request failed: ${response.status} ${response.statusText}`);
    }

    const bundles = await response.json();
    const bundlesArray = Array.isArray(bundles) ? bundles : [];

    // Transform V2 BundleManifest to AppSummary format
    return bundlesArray.map((bundle: any) => ({
      id: bundle.package,
      name: bundle.metadata?.name || bundle.package,
      developer_pubkey: bundle.signature?.pubkey || 'unknown',
      latest_version: bundle.appVersion,
      latest_cid: bundle.wasm?.hash || bundle.wasm?.path || '',
      alias: bundle.metadata?.name,
      description: bundle.metadata?.description,
    }));
  } catch (error) {
    console.error(`Failed to fetch apps from registry ${registryUrl}:`, error);
    throw error;
  }
}

/**
 * Fetch all versions of an application from a registry
 * Uses V2 Bundle API
 */
export async function fetchAppVersions(
  registryUrl: string,
  appId: string
): Promise<VersionInfo[]> {
  try {
    // Use V2 Bundle API - get all bundles for this package
    const url = new URL('/api/v2/bundles', registryUrl);
    url.searchParams.set('package', appId);

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch versions: ${response.status} ${response.statusText}`);
    }

    const bundles = await response.json();
    const bundlesArray = Array.isArray(bundles) ? bundles : [];

    // Transform V2 bundles to VersionInfo format
    return bundlesArray.map((bundle: any) => {
      // Get artifact URL (convention: /artifacts/:package/:version/:package-:version.mpk)
      const artifactUrl = `/artifacts/${bundle.package}/${bundle.appVersion}/${bundle.package}-${bundle.appVersion}.mpk`;
      return {
        semver: bundle.appVersion,
        cid: artifactUrl,
        yanked: false,
      };
    });
  } catch (error) {
    console.error(`Failed to fetch app versions from registry ${registryUrl}:`, error);
    throw error;
  }
}

/**
 * Fetch application manifest from a registry
 * Uses V2 Bundle API and transforms to AppManifest format
 */
export async function fetchAppManifest(
  registryUrl: string,
  appId: string,
  version: string
): Promise<AppManifest> {
  try {
    // Use V2 Bundle API
    const url = new URL(`/api/v2/bundles/${appId}/${version}`, registryUrl);
    
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch manifest: ${response.status} ${response.statusText}`);
    }

    const bundle = await response.json();

    // Transform V2 BundleManifest to AppManifest format
    // V2 bundles use MPK (Mero Package Kit) files, not raw WASM
    // Construct MPK URL: /artifacts/{package}/{version}/{package}-{version}.mpk
    const mpkUrl = `/artifacts/${bundle.package}/${bundle.appVersion}/${bundle.package}-${bundle.appVersion}.mpk`;
    // For absolute URL, we need to prepend the registry base URL
    const registryBase = new URL(registryUrl).origin;
    const mpkAbsoluteUrl = `${registryBase}${mpkUrl}`;
    const mpkHash = bundle.wasm?.hash || '';

    return {
      manifest_version: bundle.version || '2.0',
      app: {
        name: bundle.metadata?.name || bundle.package,
        developer_pubkey: bundle.signature?.pubkey || 'unknown',
        id: bundle.package,
        alias: bundle.metadata?.name,
      },
      version: {
        semver: bundle.appVersion,
      },
      supported_chains: [], // V2 bundles don't have chains in manifest
      permissions: [
        {
          cap: 'basic',
          bytes: bundle.wasm?.size || 0,
        },
      ],
      artifacts: [
        {
          type: 'mpk', // V2 bundles use MPK files
          target: 'node',
          cid: mpkHash, // Use hash as CID for compatibility
          size: bundle.wasm?.size || 0,
          mirrors: [mpkAbsoluteUrl], // MPK URL for download
          sha256: mpkHash, // Hash in hex format (without sha256: prefix)
        },
      ],
      metadata: {
        provides: bundle.interfaces?.exports || [],
        requires: bundle.interfaces?.uses || [],
        description: bundle.metadata?.description,
        tags: bundle.metadata?.tags,
        license: bundle.metadata?.license,
        links: bundle.links,
      },
      distribution: 'registry',
      signature: bundle.signature
        ? {
            alg: bundle.signature.alg,
            sig: bundle.signature.sig,
            signed_at: bundle.signature.signedAt,
          }
        : {
            alg: 'ed25519',
            sig: 'unsigned',
            signed_at: new Date().toISOString(),
          },
    };
  } catch (error) {
    console.error(`Failed to fetch app manifest from registry ${registryUrl}:`, error);
    throw error;
  }
}

/**
 * Fetch applications from all configured registries
 */
export async function fetchAppsFromAllRegistries(
  registryUrls: string[],
  filters?: { dev?: string; name?: string }
): Promise<Array<{ registry: string; apps: AppSummary[] }>> {
  const results = await Promise.allSettled(
    registryUrls.map(async (url) => {
      const apps = await fetchAppsFromRegistry(url, filters);
      return { registry: url, apps };
    })
  );

  return results
    .filter((result): result is PromiseFulfilledResult<{ registry: string; apps: AppSummary[] }> => 
      result.status === 'fulfilled'
    )
    .map((result) => result.value);
}

