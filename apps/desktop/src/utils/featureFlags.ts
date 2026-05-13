/// <reference types="vite/client" />

const RAW_CLOUD = import.meta.env.VITE_ENABLE_CLOUD as string | undefined;

export function isCloudEnabled(): boolean {
  if (RAW_CLOUD === undefined || RAW_CLOUD === "") return Boolean(import.meta.env.DEV);
  return RAW_CLOUD === "true" || RAW_CLOUD === "1";
}
