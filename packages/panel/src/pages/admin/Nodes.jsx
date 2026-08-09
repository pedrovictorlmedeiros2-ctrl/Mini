import { useEffect, useState } from "react";
import { api } from "../../api.js";
import StatusBadge from "../../components/StatusBadge.jsx";

export default function AdminNodes() {
  const [nodes, setNodes] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", hostname: "", region: "default", ramMbTotal: 4096, cpuPercentTotal: 400, diskMbTotal: 20480, weight: 100 });
  const [newToken, setNewToken] = useState(null);
  const [error, setError] = useState("");

  function load() {
    api.get("/admin/nodes").then((res) => setNodes(res.nodes));
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, []);

  async function createNode(e) {
    e.preventDefault();
    setError("");
    try {
      const res = await api.post("/admin/nodes", {
        ...form,
        ramMbTotal: Number(form.ramMbTotal),
        cpuPercentTotal: Number(form.cpuPercentTotal),
        diskMbTotal: Number(form.diskMbTotal),
        weight: Number(form.weight),
      });
      setNewToken({ nodeId: res.node.id, token: res.agentToken });
      setShowForm(false);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function setStatus(node, status) {
    await api.patch(`/admin/nodes/${node.id}/status`, { status });
    load();
  }

  return (
    <div>
      <div className="topbar">
        <h1>Nodes</h1>
        <button onClick={() => setShowForm((v) => !v)}>+ Registrar node</button>
      </div>

      {newToken && (
        <div className="card" style={{ borderColor: "var(--warn)" }}>
          <strong>Token do node (copie agora — não será mostrado novamente):</strong>
          <pre style={{ overflowX: "auto", background: "var(--panel-2)", padding: 10, borderRadius: 8 }}>
NODE_ID={newToken.nodeId}
NODE_TOKEN={newToken.token}
          </pre>
          <button className="secondary" onClick={() => setNewToken(null)}>Fechar</button>
        </div>
      )}

      {showForm && (
        <div className="card">
          {error && <div className="error-box">{error}</div>}
          <form onSubmit={createNode}>
            <div className="grid cols-2">
              <div className="field"><label>Nome</label><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></div>
              <div className="field"><label>Hostname</label><input value={form.hostname} onChange={(e) => setForm({ ...form, hostname: e.target.value })} required /></div>
              <div className="field"><label>Região</label><input value={form.region} onChange={(e) => setForm({ ...form, region: e.target.value })} /></div>
              <div className="field"><label>Peso</label><input type="number" value={form.weight} onChange={(e) => setForm({ ...form, weight: e.target.value })} /></div>
              <div className="field"><label>RAM total (MB)</label><input type="number" value={form.ramMbTotal} onChange={(e) => setForm({ ...form, ramMbTotal: e.target.value })} /></div>
              <div className="field"><label>CPU total (%)</label><input type="number" value={form.cpuPercentTotal} onChange={(e) => setForm({ ...form, cpuPercentTotal: e.target.value })} /></div>
              <div className="field"><label>Disco total (MB)</label><input type="number" value={form.diskMbTotal} onChange={(e) => setForm({ ...form, diskMbTotal: e.target.value })} /></div>
            </div>
            <button type="submit">Registrar</button>
          </form>
        </div>
      )}

      <div className="card">
        <table>
          <thead><tr><th>Nome</th><th>Região</th><th>Status</th><th>Conectado</th><th>RAM</th><th>CPU</th><th>Containers</th><th></th></tr></thead>
          <tbody>
            {nodes.map((n) => (
              <tr key={n.id}>
                <td>{n.name}<div className="muted">{n.hostname}</div></td>
                <td>{n.region}</td>
                <td><StatusBadge status={n.status} /></td>
                <td>{n.connected ? "🟢" : "🔴"}</td>
                <td>{n.ram_mb_reserved} / {n.ram_mb_total} MB</td>
                <td>{n.cpu_percent_reserved} / {n.cpu_percent_total}%</td>
                <td>{n.containers_count}</td>
                <td className="flex">
                  {n.status !== "MAINTENANCE" && <button className="secondary" onClick={() => setStatus(n, "MAINTENANCE")}>Manutenção</button>}
                  {n.status === "MAINTENANCE" && <button className="secondary" onClick={() => setStatus(n, "ACTIVE")}>Reativar</button>}
                </td>
              </tr>
            ))}
            {nodes.length === 0 && <tr><td colSpan={8} className="empty">Nenhum node registrado ainda</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
