import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";

export default function AdminLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">Atlantic<span>Admin</span></div>
        <nav>
          <NavLink to="/admin" end className={({ isActive }) => (isActive ? "active" : "")}>Visão geral</NavLink>
          <NavLink to="/admin/users" className={({ isActive }) => (isActive ? "active" : "")}>Usuários</NavLink>
          <NavLink to="/admin/servers" className={({ isActive }) => (isActive ? "active" : "")}>Hospedagens</NavLink>
          <NavLink to="/admin/nodes" className={({ isActive }) => (isActive ? "active" : "")}>Nodes</NavLink>
          <NavLink to="/admin/plans" className={({ isActive }) => (isActive ? "active" : "")}>Planos</NavLink>
          <NavLink to="/admin/orders" className={({ isActive }) => (isActive ? "active" : "")}>Pedidos</NavLink>
          <NavLink to="/admin/audit-log" className={({ isActive }) => (isActive ? "active" : "")}>Auditoria</NavLink>
          <NavLink to="/" className={({ isActive }) => (isActive ? "active" : "")}>Voltar ao painel</NavLink>
          <div
            className="navlink"
            onClick={() => { logout(); navigate("/login"); }}
            style={{ marginTop: 16 }}
          >
            Sair ({user?.name})
          </div>
        </nav>
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
