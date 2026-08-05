import { invoke } from '@tauri-apps/api/core';

export const BUNDLED_VERSION_ID = 'bundled';
export const LOCAL_ID_PREFIX = 'local:';

export interface ReleaseInfo {
  tag: string;
  prerelease: boolean;
  has_asset: boolean;
}

export interface InstalledVersion {
  id: string;
  path: string;
  size_bytes: number;
  used_by: string[];
  measured_version: string | null;
  drifted_nodes: string[];
}

export async function listMerodReleases(refresh?: boolean): Promise<ReleaseInfo[]> {
  return await invoke('list_merod_releases', { refresh });
}

export async function installMerodVersion(tag: string): Promise<InstalledVersion> {
  return await invoke('install_merod_version', { tag });
}

export async function listInstalledMerodVersions(homeDir?: string): Promise<InstalledVersion[]> {
  return await invoke('list_installed_merod_versions', { homeDir });
}

export async function removeMerodVersion(tag: string, homeDir?: string): Promise<void> {
  return await invoke('remove_merod_version', { tag, homeDir });
}

/**
 * A local build has no stable version, so it is labelled by kind rather than
 * by path - the measured version is shown separately on running nodes.
 */
export function formatVersionLabel(
  id: string,
  bundledVersion: string,
  measuredVersion?: string | null
): string {
  if (id === BUNDLED_VERSION_ID) {
    const trimmed = bundledVersion.replace(/^merod\s+/, '').trim();
    return trimmed ? `bundled - ${trimmed}` : 'bundled';
  }
  if (id.startsWith(LOCAL_ID_PREFIX)) {
    const trimmed = (measuredVersion ?? '').replace(/^merod\s+/, '').trim();
    return trimmed ? `local build - ${trimmed}` : 'local build';
  }
  return id;
}
