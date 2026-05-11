const STORAGE_KEY = "calimero-context-keys";

type ContextKeyRecord = {
  publicKey: string;
  applicationId?: string;
};

type ContextKeyMap = Record<string, ContextKeyRecord>;

function readAll(): ContextKeyMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeAll(map: ContextKeyMap) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
}

export function saveContextKey(
  contextId: string,
  publicKey: string,
  applicationId?: string,
) {
  const map = readAll();
  map[contextId] = { publicKey, applicationId };
  writeAll(map);
}

export function getContextKey(contextId: string): ContextKeyRecord | null {
  return readAll()[contextId] ?? null;
}
