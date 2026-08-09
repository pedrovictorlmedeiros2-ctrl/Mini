import { useEffect, useState } from "react";
import { api } from "../../api.js";
import StatusBadge from "../../components/StatusBadge.jsx";

export default function AdminUsers() {
  const [rows, setRows] = useState([]);
  const [q, setQ] = useState("");

  function load() {
    api.get(`/admin/users?q=${encodeURIComponent(q)}`).then((res) => setRows(res.rows));
  }

  useEffect(() => { load(); }, [q]); // eslint-disable-line react-hooks/exhaustive-deps

  async function toggleStatus(u) {
    const next = u.status === "active" ? "blocked" : "active";
    if (next === "blocked" && !confirm(`Bloquear ${u.email}? Todas as sessões serão invalidadas.`)) return;
    await api.patch(`/admin/users/${u.id}/status`, { status: next });
    load();
  }

  return (
    <div>
      <div className="topbar"><h1>Usuários</h1></div>
      <div className="card">
        <input placeholder="Buscar por nome ou e-mail..." value={q} onChange={(e) => setQ(e.target.value)} className="mb-8" />
        <table>
          <thead><tr><th>Nome</th><th>E-mail</th><th>Papel</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {rows.map((u) => (
              <tr key={u.id}>
                <td>{u.name}</td>
                <td className="muted">{u.email}</td>
                <td>{u.role}</td>
                <td><StatusBadge status={u.status === "active" ? "RUNNING" : "SUSPENDED"} /></td>
                <td><button className="secondary" onClick={() => toggleStatus(u)}>{u.status === "active" ? "Bloquear" : "Desbloquear"}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
