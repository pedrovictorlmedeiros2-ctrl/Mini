import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api.js";
import StatusBadge from "../../components/StatusBadge.jsx";

export default function AdminServers() {
  const [rows, setRows] = useState([]);

  useEffect(() => {
    api.get("/servers?all=true").then((res) => setRows(res.rows));
  }, []);

  return (
    <div>
      <div className="topbar"><h1>Hospedagens</h1></div>
      <div className="card">
        <table>
          <thead><tr><th>Nome</th><th>Dono</th><th>Status</th><th>RAM</th><th>CPU</th></tr></thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id}>
                <td><Link to={`/servers/${s.id}`}>{s.name}</Link></td>
                <td className="muted">{s.owner_email}</td>
                <td><StatusBadge status={s.status} /></td>
                <td>{s.ram_mb} MB</td>
                <td>{s.cpu_percent}%</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={5} className="empty">Nenhuma hospedagem</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
