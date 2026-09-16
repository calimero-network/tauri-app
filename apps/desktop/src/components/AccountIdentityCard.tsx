import { useState } from "react";
import { ChevronRight } from "lucide-react";
import CopyButton from "./CopyButton";
import { SkeletonText } from "./Skeleton";
import type { NodeIdentity } from "@calimero-network/mero-js";
import type { DeviceBanner } from "../lib/account";
import { truncateText } from "../utils/string";

type IdentityKey =
  | "accountId"
  | "deviceId"
  | "publicKey"
  | "accountRootPublicKey"
  | "accountNamespaceId";

interface IdentityField {
  id: string;
  label: string;
  key: IdentityKey;
}

/** What a person recognises this node by. Named rather than `keyof`, which also
 *  spans booleans these rows cannot render. */
const PRIMARY_FIELDS: IdentityField[] = [
  { id: "account-id", label: "Account", key: "accountId" },
  { id: "device-id", label: "Device", key: "deviceId" },
];

/** Keys other tools ask for; shown on request. */
const TECHNICAL_FIELDS: IdentityField[] = [
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

function IdentityRows({ identity, fields }: { identity: NodeIdentity; fields: IdentityField[] }) {
  return (
    <>
      {fields.map(({ id, label, key }) => {
        const value = identity[key];
        return (
          <div className="account-identity-row" key={id}>
            <dt>{label}</dt>
            <dd>
              <code id={`value-${id}`} title={value || undefined}>
                {value ? truncateText(value, 12) : "Not set"}
              </code>
              {value && <CopyButton id={`copy-${id}`} value={value} />}
            </dd>
          </div>
        );
      })}
    </>
  );
}

export default function AccountIdentityCard({
  identity,
  loading,
  error,
  banner,
  onRetry,
}: AccountIdentityCardProps) {
  const [showTechnical, setShowTechnical] = useState(false);

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
        <SkeletonText lines={2} />
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
        <dl className={`account-identity${showTechnical ? " is-open" : ""}`}>
          <IdentityRows identity={identity} fields={PRIMARY_FIELDS} />
          <div className="account-identity-row account-identity-more">
            <button
              type="button"
              id="identity-technical-toggle"
              className="disclosure-trigger"
              aria-expanded={showTechnical}
              aria-controls="identity-technical"
              onClick={() => setShowTechnical((open) => !open)}
            >
              <ChevronRight size={14} className="disclosure-chevron" />
              {showTechnical ? "Hide identifiers" : "Show identifiers"}
            </button>
          </div>
          {showTechnical && (
            <div id="identity-technical">
              <IdentityRows identity={identity} fields={TECHNICAL_FIELDS} />
            </div>
          )}
        </dl>
      )}
    </div>
  );
}
