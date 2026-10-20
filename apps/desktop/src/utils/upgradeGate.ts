import type { AdminApiClient, Namespace } from '@calimero-network/mero-js';
import { behindContexts, behindPhrase } from './memberSwitch';

type GateClient = {
  admin: Pick<
    AdminApiClient,
    'listNamespaces' | 'getContextsForApplication' | 'listNamespaceGroups' | 'listSubgroups'
  >;
};

export interface BehindNamespace {
  ns: Namespace;
  summary: string;
}

export interface GateRequest {
  appId: string;
  appName: string;
  resolve: (open: boolean) => void;
}

let host: ((req: GateRequest) => void) | null = null;

/** The one mounted gate that answers launch requests; returns its unregister. */
export function registerGateHost(fn: (req: GateRequest) => void): () => void {
  host = fn;
  return () => {
    if (host === fn) host = null;
  };
}

/** Resolves true when the app may open now, false when the user backed out. */
export function confirmAppUpToDate(appId: string, appName: string): Promise<boolean> {
  if (!host) return Promise.resolve(true);
  const ask = host;
  return new Promise((resolve) => ask({ appId, appName, resolve }));
}

async function namespaceGroupIds(admin: GateClient['admin'], namespaceId: string): Promise<string[]> {
  const seen = new Set([namespaceId]);
  const walk = async (ids: string[]) => {
    const fresh = ids.filter((id) => !seen.has(id));
    fresh.forEach((id) => seen.add(id));
    const children = await Promise.all(fresh.map((id) => admin.listSubgroups(id)));
    const next = children.flat().map((g) => g.groupId);
    if (next.length) await walk(next);
  };
  const direct = (await admin.listNamespaceGroups(namespaceId)).map((g) => g.groupId);
  await walk(direct);
  return [...seen];
}

/** Namespaces targeting `appId` that this node still runs on an older release; a node that cannot answer is not behind. */
export async function behindNamespaces(mero: GateClient, appId: string): Promise<BehindNamespace[]> {
  try {
    const mine = (await mero.admin.listNamespaces()).filter(
      (ns) => ns.targetApplicationId === appId && ns.appVersion,
    );
    if (mine.length === 0) return [];
    const { contexts } = await mero.admin.getContextsForApplication(appId);
    const out: BehindNamespace[] = [];
    for (const ns of mine) {
      const groupIds = await namespaceGroupIds(mero.admin, ns.namespaceId);
      if (behindContexts(ns, contexts, groupIds).length) {
        out.push({ ns, summary: behindPhrase(ns, contexts, groupIds, 'of its contexts') });
      }
    }
    return out;
  } catch (e) {
    console.warn('[gate] could not tell whether the app is behind; opening it:', e);
    return [];
  }
}
