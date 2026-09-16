import { Fragment } from "react";
import CopyButton from "./CopyButton";
import { SkeletonText } from "./Skeleton";
import type { NodeIdentity } from "@calimero-network/mero-js";
import type { DeviceBanner } from "../lib/account";

/** The five the card prints. Named rather than `keyof`, which now also spans a
 *  boolean these rows cannot render. */
const IDENTITY_FIELDS: {
  id: string;
  label: string;
  key:
    | "accountId"
    | "deviceId"
    | "publicKey"
    | "accountRootPublicKey"
    | "accountNamespaceId";
}[] = [
  { id: "account-id", label: "Account ID", key: "accountId" },
  { id: "device-id", label: "Device ID", key: "deviceId" },
  { id: "public-key", label: "Device public key", key: "publicKey" },
  { id: "account-root-public-key", label: "Account root public key", key: "accountRootPublicKey" },
  { id: "account-namespace", label: "Account namespace", key: "accountNamespaceId" },
];

interface AccountIdentityCardProps {
  identity: NodeIdentity | null;
  loading: boolean;
  error: string;
  banner: DeviceBanner | null;
  onRetry: () => void;
}

export default function AccountIdentityCard({
  identity,
  loading,
  error,
  banner,
  onRetry,
}: AccountIdentityCardProps) {
  return (
    <div className="settings-card">
      {banner && (
        <p
          className={banner.kind === "revoked" ? "error-message" : "account-banner"}
          id={`account-banner-${banner.kind}`}
        >
          {banner.text}
        </p>
      )}
      <h2>This device</h2>
      {loading ? (
        <SkeletonText lines={4} />
      ) : error ? (
        <>
          <p className="field-error">{error}</p>
          <button
            type="button"
            id="account-retry"
            className="button button-secondary"
            onClick={onRetry}
          >
            Retry
          </button>
        </>
      ) : !identity ? (
        <p className="field-hint" id="account-no-identity">
          This node has no account identity yet. It gets one the first time it takes part in
          a namespace.
        </p>
      ) : (
        <dl className="account-identity">
          {IDENTITY_FIELDS.map(({ id, label, key }) => {
            const value = identity[key];
            return (
              <Fragment key={id}>
                <dt>{label}</dt>
                <dd>
                  <code id={`value-${id}`} title={value || undefined}>
                    {value || "Not set"}
                  </code>
                  {value && <CopyButton id={`copy-${id}`} value={value} />}
                </dd>
              </Fragment>
            );
          })}
        </dl>
      )}
    </div>
  );
}
