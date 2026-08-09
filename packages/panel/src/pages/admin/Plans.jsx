import { useEffect, useState } from "react";
import { api } from "../../api.js";

export default function AdminPlans() {
  const [plans, setPlans] = useState([]);
  const [editing, setEditing] = useState(null);

  function load() {
    api.get("/plans/admin/all").then((res) => setPlans(res.plans));
  }
  useEffect(() => { load(); }, []);

  async function save(e) {
    e.preventDefault();
    await api.patch(`/plans/admin/${editing.id}`, {
      name: editing.name,
      ram_mb: Number(editing.ram_mb),
      cpu_percent: Number(editing.cpu_percent),
      disk_mb: Number(editing.disk_mb),
      pids_limit: Number(editing.pids_limit),
      max_servers: Number(editing.max_servers),
      max_backups: Number(editing.max_backups),
      price_cents: Number(editing.price_cents),
      currency: editing.currency,
      active: editing.active ? 1 : 0,
    });
    setEditing(null);
    load();
  }

  return (
    <div>
      <div className="topbar"><h1>Planos</h1></div>
      <div className="card">
        <table>
          <thead><tr><th>Nome</th><th>RAM</th><th>CPU</th><th>Disco</th><th>Preço</th><th>Ativo</th><th></th></tr></thead>
          <tbody>
            {plans.map((p) => (
              <tr key={p.id}>
                <td>{p.name} <span className="muted">({p.slug})</span></td>
                <td>{p.ram_mb} MB</td>
                <td>{p.cpu_percent}%</td>
                <td>{p.disk_mb} MB</td>
                <td>{(p.price_cents / 100).toLocaleString("pt-BR", { style: "currency", currency: p.currency })}</td>
                <td>{p.active ? "Sim" : "Não"}</td>
                <td><button className="secondary" onClick={() => setEditing({ ...p })}>Editar</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <div className="card" style={{ maxWidth: 480 }}>
          <h3 style={{ marginTop: 0 }}>Editar {editing.slug}</h3>
          <form onSubmit={save}>
            <div className="grid cols-2">
              <div className="field"><label>Nome</label><input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></div>
              <div className="field"><label>Preço (centavos)</label><input type="number" value={editing.price_cents} onChange={(e) => setEditing({ ...editing, price_cents: e.target.value })} /></div>
              <div className="field"><label>RAM (MB)</label><input type="number" value={editing.ram_mb} onChange={(e) => setEditing({ ...editing, ram_mb: e.target.value })} /></div>
              <div className="field"><label>CPU (%)</label><input type="number" value={editing.cpu_percent} onChange={(e) => setEditing({ ...editing, cpu_percent: e.target.value })} /></div>
              <div className="field"><label>Disco (MB)</label><input type="number" value={editing.disk_mb} onChange={(e) => setEditing({ ...editing, disk_mb: e.target.value })} /></div>
              <div className="field"><label>Limite de processos</label><input type="number" value={editing.pids_limit} onChange={(e) => setEditing({ ...editing, pids_limit: e.target.value })} /></div>
              <div className="field"><label>Max. backups</label><input type="number" value={editing.max_backups} onChange={(e) => setEditing({ ...editing, max_backups: e.target.value })} /></div>
              <div className="field">
                <label>Ativo</label>
                <select value={editing.active ? "1" : "0"} onChange={(e) => setEditing({ ...editing, active: e.target.value === "1" })}>
                  <option value="1">Sim</option>
                  <option value="0">Não</option>
                </select>
              </div>
            </div>
            <div className="flex">
              <button type="submit">Salvar</button>
              <button type="button" className="secondary" onClick={() => setEditing(null)}>Cancelar</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
