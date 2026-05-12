import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import {
  LayoutDashboard, Users, Database, Zap, Settings,
  GitBranch, ShoppingBag, Map, Package, LogOut, Activity, FileText, ClipboardList
} from 'lucide-react';

const navItems = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard', end: true, roles: ['admin', 'employee'] },
  { to: '/clients', icon: Users, label: 'Clients', roles: ['admin', 'employee'] },
  { to: '/feeds', icon: Database, label: 'Feeds', roles: ['admin', 'employee'] },
  { to: '/channels', icon: GitBranch, label: 'Channels', roles: ['admin', 'employee'] },
  { to: '/products', icon: Package, label: 'Products', roles: ['admin', 'employee'] },
  { to: '/mapping', icon: Map, label: 'Attribute Mapping', roles: ['admin', 'employee'] },
  { to: '/automations', icon: Activity, label: 'Automations', roles: ['admin', 'employee'] },
  { to: '/sync', icon: Zap, label: 'Sync Jobs', roles: ['admin', 'employee'] },
  { to: '/orders', icon: ShoppingBag, label: 'Orders', roles: ['admin', 'employee'] },
  { to: '/tasks', icon: ClipboardList, label: 'Tasks', roles: ['admin', 'employee'] },
  { to: '/invoices', icon: FileText, label: 'Invoices', roles: ['admin', 'employee', 'client'] },
];

const adminItems = [
  { to: '/users', icon: Settings, label: 'Users & Access' },
];

export default function Layout() {
  const { user, logout, isAdmin } = useAuth();
  const navigate = useNavigate();

  function handleLogout() {
    logout();
    navigate('/login');
  }

  return (
    <div className="app-layout">
      {/* ── Sidebar ── */}
      <aside className="sidebar">
        {/* Logo */}
        <div style={{ padding: '24px 20px 20px', borderBottom: '1px solid rgba(255,165,0,0.1)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 10,
              background: 'linear-gradient(135deg, #ffa500, #ff6b00)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 4px 12px rgba(255,165,0,0.4)'
            }}>
              <Activity size={18} color="#000" />
            </div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: '#f1f5f9' }}>Sync-Engine</div>
              <div style={{ fontSize: 11, color: '#ffa500', fontWeight: 500 }}>By E-sellers.net</div>
            </div>
          </div>
        </div>

        {/* Nav */}
        <nav style={{ flex: 1, padding: '16px 12px' }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: '#334155', textTransform: 'uppercase', letterSpacing: '0.08em', padding: '0 8px', marginBottom: 8 }}>
            Navigation
          </div>
          {navItems.filter(item => !item.roles || item.roles.includes(user?.role || '')).map(item => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              style={({ isActive }) => ({
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '9px 12px',
                borderRadius: 10,
                marginBottom: 2,
                fontSize: 14,
                fontWeight: 500,
                textDecoration: 'none',
                transition: 'all 0.2s',
                color: isActive ? '#ffa500' : '#64748b',
                background: isActive ? 'rgba(255,165,0,0.1)' : 'transparent',
                border: isActive ? '1px solid rgba(255,165,0,0.2)' : '1px solid transparent',
              })}
            >
              <item.icon size={16} />
              {item.label}
            </NavLink>
          ))}

          {isAdmin && (
            <>
              <div style={{ fontSize: 11, fontWeight: 600, color: '#334155', textTransform: 'uppercase', letterSpacing: '0.08em', padding: '12px 8px 8px', marginTop: 8, borderTop: '1px solid rgba(255,165,0,0.1)' }}>
                Admin
              </div>
              {adminItems.map(item => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  style={({ isActive }) => ({
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '9px 12px', borderRadius: 10, marginBottom: 2,
                    fontSize: 14, fontWeight: 500, textDecoration: 'none',
                    transition: 'all 0.2s',
                    color: isActive ? '#ffa500' : '#64748b',
                    background: isActive ? 'rgba(255,165,0,0.1)' : 'transparent',
                    border: isActive ? '1px solid rgba(255,165,0,0.2)' : '1px solid transparent',
                  })}
                >
                  <item.icon size={16} />
                  {item.label}
                </NavLink>
              ))}
            </>
          )}
        </nav>

        {/* User footer */}
        <div style={{ padding: '16px 16px', borderTop: '1px solid rgba(255,165,0,0.1)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <div style={{
              width: 34, height: 34, borderRadius: '50%',
              background: 'linear-gradient(135deg, #ffa500, #ff6b00)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 13, fontWeight: 700, color: '#000', flexShrink: 0
            }}>
              {user?.name?.[0]?.toUpperCase()}
            </div>
            <div style={{ overflow: 'hidden' }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {user?.name}
              </div>
              <div style={{ fontSize: 11, color: '#ffa500', fontWeight: 500, textTransform: 'capitalize' }}>
                {user?.role}
              </div>
            </div>
          </div>
          <button className="btn btn-secondary btn-sm" onClick={handleLogout} style={{ width: '100%' }}>
            <LogOut size={13} />
            Sign Out
          </button>
        </div>
      </aside>

      {/* ── Main ── */}
      <main className="main-content">
        <Outlet />
      </main>
    </div>
  );
}
