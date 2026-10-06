import { getSettings } from "../utils/settings";
import { Cloud, Home, Layers, Package, Store, Settings2 as SettingsIcon, Server, UserRound } from "lucide-react";
import { useCloudEnabled } from "../hooks/useCloudEnabled";
import { useCloudSession, type CloudSessionStatus } from "../hooks/useCloudSession";
import calimeroLogo from "../assets/brand/calimero-wordmark.svg";
import "./Sidebar.css";

type NavPage = 'home' | 'marketplace' | 'installed' | 'namespaces' | 'cloud' | 'account' | 'nodes';

const CLOUD_STATUS_LABEL: Record<CloudSessionStatus, string> = {
  connected: 'Signed in to Calimero Cloud',
  expired: 'Cloud session expired',
  'signed-out': 'Not signed in to Calimero Cloud',
};

interface SidebarProps {
  currentPage: NavPage;
  onNavigate: (page: NavPage) => void;
  onOpenSettings: () => void;
  /** When true, show Nodes in nav so users can fix connection (even without developer mode) */
  nodeDisconnected?: boolean;
}

export default function Sidebar({ currentPage, onNavigate, onOpenSettings, nodeDisconnected = false }: SidebarProps) {
  const settings = getSettings();
  const developerMode = settings.developerMode ?? true;
  // Cloud is its own tab, outside Developer Mode: High Availability is something
  // every user who keeps data in a namespace may want.
  const cloudEnabled = useCloudEnabled();
  const cloudSession = useCloudSession();

  const navItems = [
    { id: 'home' as const, label: 'Home', icon: Home },
    ...(developerMode || nodeDisconnected ? [{ id: 'nodes' as const, label: 'Nodes', icon: Server }] : []),
    ...(developerMode ? [{ id: 'namespaces' as const, label: 'Namespaces', icon: Layers }] : []),
    ...(cloudEnabled ? [{ id: 'cloud' as const, label: 'Cloud', icon: Cloud }] : []),
    { id: 'account' as const, label: 'Account', icon: UserRound },
    { id: 'installed' as const, label: 'Applications', icon: Package },
    { id: 'marketplace' as const, label: 'Marketplace', icon: Store },
  ];

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-logo">
          <img src={calimeroLogo} alt="Calimero" className="logo-icon" />
        </div>
      </div>

      <nav className="sidebar-nav">
        {navItems.map((item) => (
          <button
            key={item.id}
            className={`sidebar-nav-item ${currentPage === item.id ? 'active' : ''}`}
            onClick={() => onNavigate(item.id)}
            title={item.label}
            data-tutorial={`nav-${item.id}`}
          >
            <item.icon className="nav-icon" size={20} />
            <span className="nav-label">{item.label}</span>
            {item.id === 'cloud' && (
              <span
                className={`nav-status-dot nav-status-${cloudSession}`}
                role="img"
                aria-label={CLOUD_STATUS_LABEL[cloudSession]}
              />
            )}
          </button>
        ))}
      </nav>

      <div className="sidebar-footer">
        <button
          className="sidebar-nav-item"
          onClick={onOpenSettings}
          title="Settings"
          data-tutorial="nav-settings"
        >
          <SettingsIcon className="nav-icon" size={20} />
          <span className="nav-label">Settings</span>
        </button>
      </div>
    </aside>
  );
}
