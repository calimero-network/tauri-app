import { useCallback, useEffect, useState } from "react";
import { CloudCheck, Link2 } from "lucide-react";
import { SkeletonText } from "./Skeleton";
import { cloudLinkState } from "../lib/account";
import { getCloudIdToken } from "../utils/cloudAuth";
import { linkAccountToCloud, listCloudAccounts } from "../utils/cloudApi";

interface CloudAccountLinkCardProps {
  /** This node's account, 64 hex, or null while identity is still loading. */
  accountId: string | null;
  /**
   * Whether this node holds the account root.
   *
   * Only the holder can link: the signature is made by the root, which lives in
   * this node's store and reaches no other. A paired device shown the button
   * would get a refusal from its own node, so it is not shown one.
   */
  isHolder: boolean;
}

/**
 * Bind this node's Calimero account to the signed-in cloud login.
 *
 * Two identities that are otherwise unrelated — a cloud login is an email, a
 * Calimero identity is a 32-byte account — and the cloud cannot take our word
 * for which account is ours, since anyone can mint a root offline. The link is
 * a root signature over a challenge the cloud issued and sealed against its own
 * login.
 *
 * The card reads the existing links first so the button reflects what the cloud
 * already knows: offering "Link" for an account that is already linked invites a
 * request that comes back 409, which reads as a bug rather than as "already
 * done".
 */
export default function CloudAccountLinkCard({
  accountId,
  isHolder,
}: CloudAccountLinkCardProps) {
  const [loading, setLoading] = useState(true);
  const [linked, setLinked] = useState(false);
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState("");
  const [atLimit, setAtLimit] = useState(false);

  const token = getCloudIdToken();

  const refresh = useCallback(async () => {
    if (!token || !accountId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const { accounts, limit } = await listCloudAccounts(token);
      const state = cloudLinkState(
        accountId,
        accounts.map((a) => a.accountId),
        limit,
      );
      setLinked(state === "linked");
      setAtLimit(state === "at-limit");
    } catch (e) {
      setError((e as Error)?.message || "Could not read your linked accounts");
    } finally {
      setLoading(false);
    }
  }, [token, accountId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onLink = useCallback(async () => {
    if (!token) return;
    setLinking(true);
    setError("");
    try {
      await linkAccountToCloud(token);
      setLinked(true);
    } catch (e) {
      setError((e as Error)?.message || "Could not link this account");
    } finally {
      setLinking(false);
    }
  }, [token]);

  // A paired device manages nothing here, and the holder's node is where the
  // root that signs lives.
  if (!isHolder) return null;

  return (
    <div className="settings-card">
      <div className="account-devices-header">
        <h2>Calimero Cloud</h2>
        {linked && (
          <span className="account-this-device">
            <CloudCheck size={14} style={{ marginRight: "6px", verticalAlign: "middle" }} />
            Linked
          </span>
        )}
      </div>

      {!token ? (
        <p className="account-section-hint">
          Sign in to Calimero Cloud in Settings to link this account. Linking is
          what lets the cloud attribute a plan to it, and what lets you find your
          namespaces again from a new device.
        </p>
      ) : loading ? (
        <SkeletonText />
      ) : (
        <>
          <p className="account-section-hint">
            {linked
              ? "This account belongs to your cloud login. Its plan and billing are attributed here, and you can find its namespaces again after losing a device."
              : "Link this account to your cloud login so its plan can be attributed to it, and so you can find its namespaces again after losing a device. Your account root signs a challenge from the cloud; the key never leaves this computer."}
          </p>

          {error && <p className="field-error">{error}</p>}

          {!linked && (
            <button
              type="button"
              id="link-account-to-cloud"
              className="button button-primary"
              disabled={linking || atLimit || !accountId}
              onClick={() => void onLink()}
            >
              <Link2 size={14} style={{ marginRight: "6px", verticalAlign: "middle" }} />
              {linking ? "Linking…" : "Link to cloud"}
            </button>
          )}

          {atLimit && (
            <p className="account-section-hint">
              Your plan has no room for another linked account. Upgrade, or
              unlink one you no longer use.
            </p>
          )}
        </>
      )}
    </div>
  );
}
