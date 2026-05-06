import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './hooks/useAuth';
import Layout from './components/Layout';
import LoginPage from './pages/LoginPage';
import SetupPage from './pages/SetupPage';
import DashboardPage from './pages/DashboardPage';
import ClientsPage from './pages/ClientsPage';
import ClientDetailPage from './pages/ClientDetailPage';
import FeedsPage from './pages/FeedsPage';
import ChannelsPage from './pages/ChannelsPage';
import SyncPage from './pages/SyncPage';
import MappingPage from './pages/MappingPage';
import ProductsPage from './pages/ProductsPage';
import UsersPage from './pages/UsersPage';
import OrdersPage from './pages/OrdersPage';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#080c18' }}>
      <div style={{ textAlign: 'center' }}>
        <div className="spinner" style={{ width: 40, height: 40, border: '3px solid rgba(79,110,247,0.2)', borderTopColor: '#4f6ef7', borderRadius: '50%', margin: '0 auto 16px' }} />
        <p style={{ color: '#64748b', fontSize: 14 }}>Loading Sync-Engine...</p>
      </div>
    </div>
  );
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/setup" element={<SetupPage />} />
      <Route path="/" element={
        <ProtectedRoute>
          <Layout />
        </ProtectedRoute>
      }>
        <Route index element={<DashboardPage />} />
        <Route path="clients" element={<ClientsPage />} />
        <Route path="clients/:id" element={<ClientDetailPage />} />
        <Route path="feeds" element={<FeedsPage />} />
        <Route path="channels" element={<ChannelsPage />} />
        <Route path="sync" element={<SyncPage />} />
        <Route path="mapping" element={<MappingPage />} />
        <Route path="products" element={<ProductsPage />} />
        <Route path="orders" element={<OrdersPage />} />
        <Route path="users" element={<UsersPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  );
}
