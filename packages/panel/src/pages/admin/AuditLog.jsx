import { useEffect, useState } from "react";
import { api } from "../../api.js";

export default function AdminAuditLog() {
  const [rows, setRows] = useState([]);

  useEffect(() => {
    api.get("/admin/audit-log?limit=100").then((res) => setRows(res.rows));
  }, []);

  return (
    <div>
      <div className="topbar"><h1>Auditoria</h1></div>
      <div className="card">
        <table>
          <thead><tr><th>Data</th><th>Evento</th><th>Ator</th><th>Alvo</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="muted">{r.created_at}</td>
                <td>{r.event}</td>
                <td>{r.actor_email || r.actor_type}</td>
                <td className="muted">{r.target_type ? `${r.target_type}:${r.target_id?.slice(0, 8)}` : "—"}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={4} className="empty">Sem eventos</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
