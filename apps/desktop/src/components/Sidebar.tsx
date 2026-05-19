import { getSettings } from "../utils/settings";
import { Home, Layers, Package, Store, SettingsIcon, Server } from "./Icons";
import calimeroLogo from "../assets/calimero-logo.svg";
import "./Sidebar.css";

interface SidebarProps {
  currentPage: 'home' | 'marketplace' | 'installed' | 'namespaces' | 'nodes';
  onNavigate: (page: 'home' | 'marketplace' | 'installed' | 'namespaces' | 'nodes') => void;
  onOpenSettings: () => void;
  /** When true, show Nodes in nav so users can fix connection (even without developer mode) */
  nodeDisconnected?: boolean;
}

export default function Sidebar({ currentPage, onNavigate, onOpenSettings, nodeDisconnected = false }: SidebarProps) {
  const settings = getSettings();
  const developerMode = settings.developerMode ?? false;

  const navItems = [
    { id: 'home' as const, label: 'Home', icon: Home },
    ...(developerMode || nodeDisconnected ? [{ id: 'nodes' as const, label: 'Nodes', icon: Server }] : []),
    ...(developerMode ? [{ id: 'namespaces' as const, label: 'Namespaces', icon: Layers }] : []),
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
