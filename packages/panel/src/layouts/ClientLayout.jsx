import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";

export default function ClientLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">Atlantic<span>Host</span></div>
        <nav>
          <NavLink to="/" end className={({ isActive }) => (isActive ? "active" : "")}>Dashboard</NavLink>
          <NavLink to="/plans" className={({ isActive }) => (isActive ? "active" : "")}>Novo servidor</NavLink>
          <NavLink to="/orders" className={({ isActive }) => (isActive ? "active" : "")}>Pedidos</NavLink>
          {user?.role === "admin" && (
            <NavLink to="/admin" className={({ isActive }) => (isActive ? "active" : "")}>Painel Admin</NavLink>
          )}
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
