import { getSettings } from "../utils/settings";
import { Home, Link2, Package, ShoppingCart, Settings as SettingsIcon, Server } from "lucide-react";
import calimeroLogo from "../assets/calimero-logo.svg";
import "./Sidebar.css";

interface SidebarProps {
  currentPage: 'home' | 'marketplace' | 'installed' | 'contexts' | 'nodes';
  onNavigate: (page: 'home' | 'marketplace' | 'installed' | 'contexts' | 'nodes') => void;
  onOpenSettings: () => void;
}

export default function Sidebar({ currentPage, onNavigate, onOpenSettings }: SidebarProps) {
  const settings = getSettings();
  const developerMode = settings.developerMode ?? false;

  const navItems = [
    { id: 'home' as const, label: 'Home', icon: Home },
    ...(developerMode ? [{ id: 'nodes' as const, label: 'Nodes', icon: Server }] : []),
    ...(developerMode ? [{ id: 'contexts' as const, label: 'Contexts', icon: Link2 }] : []),
    { id: 'installed' as const, label: 'Applications', icon: Package },
    { id: 'marketplace' as const, label: 'Marketplace', icon: ShoppingCart },
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
