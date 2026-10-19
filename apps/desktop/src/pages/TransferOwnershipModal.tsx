import { useState } from "react";
import { X } from "lucide-react";
import { roleColor, roleLabel } from "../utils/groupRoles";

export interface TransferTarget {
  identity: string;
  role?: string;
  name?: string;
  shortId: string;
  /** What the member is called in a sentence. */
  label: string;
}

interface TransferOwnershipModalProps {
  candidates: TransferTarget[];
  loading: boolean;
  /** Why the member list could not be read; shown in place of the list. */
  error?: string;
  /** Why nobody can transfer from here; shown in place of the list. */
  blocked?: string;
  onClose: () => void;
  onContinue: (target: TransferTarget) => void;
}

export function TransferOwnershipModal({ candidates, loading, error, blocked, onClose, onContinue }: TransferOwnershipModalProps) {
  const [chosen, setChosen] = useState<TransferTarget | null>(null);

  return (
    <div className="ns-modal-backdrop" onClick={onClose}>
      <div className="ns-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Transfer Ownership">
        <div className="ns-modal-header">
          <h2>Transfer Ownership</h2>
          <button className="ns-modal-close" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <div className="ns-modal-body">
          {loading ? (
            <p className="empty-hint">Loading members…</p>
          ) : error ? (
            <p className="empty-hint">{error}</p>
          ) : blocked ? (
            <p className="empty-hint">{blocked}</p>
          ) : candidates.length === 0 ? (
            <p className="empty-hint">No other member can take over yet. Invite someone first.</p>
          ) : (
            <div className="ns-transfer-list" role="radiogroup" aria-label="New owner">
              {candidates.map((c) => (
                <label key={c.identity} className="ns-transfer-option">
                  <input
                    type="radio"
                    name="transfer-target"
                    checked={chosen?.identity === c.identity}
                    onChange={() => setChosen(c)}
                  />
                  <div className="member-info">
                    <div className="member-name-row">
                      <span className={`member-name${c.name ? "" : " mono"}`}>{c.name || c.shortId}</span>
                    </div>
                    {c.name && <span className="member-id mono">{c.shortId}</span>}
                  </div>
                  <span className="member-role" style={{ color: roleColor(c.role ?? "Member") }}>{roleLabel(c.role ?? "Member")}</span>
                </label>
              ))}
            </div>
          )}
          {!blocked && (
            <p className="ns-modal-hint ns-transfer-hint">
              The new owner can delete the namespace for everyone. You stay an admin.
            </p>
          )}
          <div className="ns-modal-actions">
            <button type="button" className="ns-modal-cancel" onClick={onClose}>Cancel</button>
            <button type="button" className="ns-action-btn" disabled={!chosen || !!blocked || !!error || loading} onClick={() => chosen && onContinue(chosen)}>
              Continue
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
