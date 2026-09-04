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

interface ReleaseListing {
  releases: ReleaseInfo[];
  /** True when a refetch failed and this is the last list we managed to fetch. */
  stale: boolean;
}

export async function listMerodReleases(refresh?: boolean): Promise<ReleaseListing> {
  return await invoke('list_merod_releases', { refresh });
}

/** Repair a node whose local build moved or was deleted. Returns how many nodes changed. */
export async function repointLocalBuild(
  oldId: string,
  newPath: string,
  homeDir?: string,
): Promise<number> {
  return await invoke('repoint_local_build', { oldId, newPath, homeDir });
}

export async function listInstalledMerodVersions(homeDir?: string): Promise<InstalledVersion[]> {
  return await invoke('list_installed_merod_versions', { homeDir });
}

export async function removeMerodVersion(tag: string, homeDir?: string): Promise<void> {
  return await invoke('remove_merod_version', { tag, homeDir });
}

/** merod prints `merod <tag> (build ...) (commit ...)`; keep the tag. An
 *  unreadable binary reports the literal "unknown", which is not a version. */
function shortVersion(raw?: string | null): string {
  const tag = (raw ?? '').replace(/^merod\s+/, '').trim().split(/\s+/)[0] ?? '';
  return tag === 'unknown' ? '' : tag;
}

export function formatVersionLabel(
  id: string,
  bundledVersion: string,
  measuredVersion?: string | null
): string {
  if (id === BUNDLED_VERSION_ID) {
    const v = shortVersion(bundledVersion);
    return v ? `default - ${v}` : 'default';
  }
  if (id.startsWith(LOCAL_ID_PREFIX)) {
    const v = shortVersion(measuredVersion);
    return v ? `local build - ${v}` : 'local build';
  }
  return id;
}
