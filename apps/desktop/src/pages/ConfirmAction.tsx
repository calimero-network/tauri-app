import React, { useState } from "react";
import "./ConfirmAction.css";

interface ConfirmActionProps {
  title: string;
  message: string;
  itemName: string;
  actionLabel: string;
  /** Called with the option's state, or `false` when the page shows none. */
  onConfirm: (optionChecked: boolean) => void;
  /** An extra opt-in shown above the buttons, e.g. "also delete the app's data". */
  option?: { label: string; hint?: string; defaultChecked: boolean };
  onCancel: () => void;
  breadcrumbs: Array<{ label: string; onClick?: () => void }>;
}

const ConfirmAction: React.FC<ConfirmActionProps> = ({
  title,
  message,
  itemName,
  actionLabel,
  onConfirm,
  onCancel,
  breadcrumbs,
  option,
}) => {
  const [optionChecked, setOptionChecked] = useState(option?.defaultChecked ?? false);
  return (
    <div className="confirm-action-page">
      <nav className="breadcrumbs">
        {breadcrumbs.map((crumb, index) => (
          <React.Fragment key={index}>
            {index > 0 && <span className="breadcrumb-separator"> / </span>}
            {crumb.onClick ? (
              <button
                className="breadcrumb-link"
                onClick={crumb.onClick}
                type="button"
              >
                {crumb.label}
              </button>
            ) : (
              <span className="breadcrumb-current">{crumb.label}</span>
            )}
          </React.Fragment>
        ))}
      </nav>

      <div className="confirm-action-content">
        <h1>{title}</h1>
        <div className="confirm-message">
          <p>{message}</p>
          <p className="item-name">"{itemName}"</p>
        </div>
        {option && (
          <label className="confirm-option" data-testid="confirm-option">
            <input
              type="checkbox"
              checked={optionChecked}
              onChange={(e) => setOptionChecked(e.target.checked)}
            />
            <span>
              <span className="confirm-option-label">{option.label}</span>
              {option.hint && <span className="confirm-option-hint">{option.hint}</span>}
            </span>
          </label>
        )}
        <div className="confirm-actions">
          <button
            onClick={onCancel}
            className="button button-secondary"
            type="button"
          >
            Cancel
          </button>
          <button
            onClick={() => onConfirm(option ? optionChecked : false)}
            className="button button-danger"
            type="button"
          >
            {actionLabel}
          </button>
        </div>
      </div>
    </div>
  );
};

export default React.memo(ConfirmAction);

