import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, wsUrl } from "../api.js";
import StatusBadge from "../components/StatusBadge.jsx";

function QuotaStat({ label, used, limit, unit }) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{used}{unit} <span className="muted" style={{ fontSize: 14, fontWeight: 400 }}>/ {limit}{unit}</span></div>
      <div className="bar"><div className="fill" style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

export default function Dashboard() {
  const [servers, setServers] = useState([]);
  const [quota, setQuota] = useState(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    const res = await api.get("/servers");
    setServers(res.servers);
    setQuota(res.quota);
    setLoading(false);
  }

  useEffect(() => {
    load();
    const ws = new WebSocket(wsUrl("/ws/panel"));
    ws.onmessage = (evt) => {
      const msg = JSON.parse(evt.data);
      if (msg.type === "server_update") {
        setServers((prev) => prev.map((s) => (s.id === msg.server.id ? msg.server : s)));
      }
    };
    return () => ws.close();
  }, []);

  if (loading) return <div className="empty">Carregando...</div>;

  return (
    <div>
      <div className="topbar">
        <h1>Visão geral</h1>
        <Link to="/plans"><button>+ Novo servidor</button></Link>
      </div>

      {quota && (
        <div className="grid cols-4 mb-8">
          <QuotaStat label="Servidores" used={quota.servers.used} limit={quota.servers.limit} unit="" />
          <QuotaStat label="RAM" used={quota.ramMb.used} limit={quota.ramMb.limit} unit="MB" />
          <QuotaStat label="CPU" used={quota.cpuPercent.used} limit={quota.cpuPercent.limit} unit="%" />
          <QuotaStat label="Disco" used={quota.diskMb.used} limit={quota.diskMb.limit} unit="MB" />
        </div>
      )}

      <div className="card" style={{ marginTop: 16 }}>
        <h3 style={{ marginTop: 0 }}>Seus servidores</h3>
        {servers.length === 0 ? (
          <div className="empty">
            Você ainda não tem nenhum servidor. <Link to="/plans">Crie o primeiro</Link>.
          </div>
        ) : (
          <table>
            <thead>
              <tr><th>Nome</th><th>Tipo</th><th>Status</th><th>RAM</th><th>CPU</th></tr>
            </thead>
            <tbody>
              {servers.map((s) => (
                <tr key={s.id} style={{ cursor: "pointer" }} onClick={() => (window.location.href = `/servers/${s.id}`)}>
                  <td><Link to={`/servers/${s.id}`}>{s.name}</Link></td>
                  <td className="muted">{s.type}</td>
                  <td><StatusBadge status={s.status} /></td>
                  <td>{s.ram_mb} MB</td>
                  <td>{s.cpu_percent}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
