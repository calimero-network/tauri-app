import { getSettings } from "../utils/settings";
import { Home, Layers, Package, Store, Settings2 as SettingsIcon, Server, UserRound } from "lucide-react";
import calimeroLogo from "../assets/calimero-logo.svg";
import "./Sidebar.css";

type NavPage = 'home' | 'marketplace' | 'installed' | 'namespaces' | 'account' | 'nodes';

interface SidebarProps {
  currentPage: NavPage;
  onNavigate: (page: NavPage) => void;
  onOpenSettings: () => void;
  /** When true, show Nodes in nav so users can fix connection (even without developer mode) */
  nodeDisconnected?: boolean;
  /** Devices still on this account, or undefined while the node has not said. */
  accountDevices?: number;
}

export default function Sidebar({ currentPage, onNavigate, onOpenSettings, nodeDisconnected = false, accountDevices }: SidebarProps) {
  const settings = getSettings();
  const developerMode = settings.developerMode ?? false;

  const navItems = [
    { id: 'home' as const, label: 'Home', icon: Home },
    ...(developerMode || nodeDisconnected ? [{ id: 'nodes' as const, label: 'Nodes', icon: Server }] : []),
    ...(developerMode ? [{ id: 'namespaces' as const, label: 'Namespaces', icon: Layers }] : []),
    { id: 'account' as const, label: 'Account', icon: UserRound, count: accountDevices },
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
          >
            <item.icon className="nav-icon" size={20} />
            <span className="nav-label">{item.label}</span>
            {'count' in item && item.count !== undefined && (
              <span className="nav-count">{item.count}</span>
            )}
          </button>
        ))}
      </nav>

      <div className="sidebar-footer">
        <button
          className="sidebar-nav-item"
          onClick={onOpenSettings}
          title="Settings"
        >
          <SettingsIcon className="nav-icon" size={20} />
          <span className="nav-label">Settings</span>
        </button>
      </div>
    </aside>
  );
}
