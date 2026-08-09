import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "./context/AuthContext.jsx";
import { RequireAuth, RequireAdmin } from "./components/ProtectedRoute.jsx";
import ClientLayout from "./layouts/ClientLayout.jsx";
import AdminLayout from "./layouts/AdminLayout.jsx";
import Login from "./pages/Login.jsx";
import Register from "./pages/Register.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import Plans from "./pages/Plans.jsx";
import Orders from "./pages/Orders.jsx";
import ServerDetail from "./pages/ServerDetail.jsx";
import AdminOverview from "./pages/admin/Overview.jsx";
import AdminUsers from "./pages/admin/Users.jsx";
import AdminServers from "./pages/admin/Servers.jsx";
import AdminNodes from "./pages/admin/Nodes.jsx";
import AdminPlans from "./pages/admin/Plans.jsx";
import AdminOrders from "./pages/admin/Orders.jsx";
import AdminAuditLog from "./pages/admin/AuditLog.jsx";

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />

          <Route element={<RequireAuth />}>
            <Route element={<ClientLayout />}>
              <Route path="/" element={<Dashboard />} />
              <Route path="/plans" element={<Plans />} />
              <Route path="/orders" element={<Orders />} />
              <Route path="/servers/:id" element={<ServerDetail />} />
            </Route>
          </Route>

          <Route element={<RequireAdmin />}>
            <Route path="/admin" element={<AdminLayout />}>
              <Route index element={<AdminOverview />} />
              <Route path="users" element={<AdminUsers />} />
              <Route path="servers" element={<AdminServers />} />
              <Route path="nodes" element={<AdminNodes />} />
              <Route path="plans" element={<AdminPlans />} />
              <Route path="orders" element={<AdminOrders />} />
              <Route path="audit-log" element={<AdminAuditLog />} />
            </Route>
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
