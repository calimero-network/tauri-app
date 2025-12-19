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
 */
export async function fetchAppsFromRegistry(
  registryUrl: string,
  filters?: { dev?: string; name?: string }
): Promise<AppSummary[]> {
  try {
    const url = new URL('/api/v1/apps', registryUrl);
    if (filters?.dev) {
      url.searchParams.set('dev', filters.dev);
    }
    if (filters?.name) {
      url.searchParams.set('name', filters.name);
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

    const data = await response.json();
    // Handle both array and object with apps property
    return Array.isArray(data) ? data : (data.apps || []);
  } catch (error) {
    console.error(`Failed to fetch apps from registry ${registryUrl}:`, error);
    throw error;
  }
}

/**
 * Fetch all versions of an application from a registry
 */
export async function fetchAppVersions(
  registryUrl: string,
  appId: string
): Promise<VersionInfo[]> {
  try {
    const url = new URL(`/api/v1/apps/${appId}`, registryUrl);
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch versions: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    // Backend returns { id, versions: VersionInfo[] }
    if (data.versions && Array.isArray(data.versions)) {
      return data.versions;
    }
    return [];
  } catch (error) {
    console.error(`Failed to fetch app versions from registry ${registryUrl}:`, error);
    throw error;
  }
}

/**
 * Fetch application manifest from a registry
 */
export async function fetchAppManifest(
  registryUrl: string,
  appId: string,
  version: string
): Promise<AppManifest> {
  try {
    const url = new URL(`/api/v1/apps/${appId}/${version}`, registryUrl);
    
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch manifest: ${response.status} ${response.statusText}`);
    }

    return await response.json();
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

