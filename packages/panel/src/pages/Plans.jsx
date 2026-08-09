import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api.js";

function money(cents, currency) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency }).format(cents / 100);
}

export default function Plans() {
  const [plans, setPlans] = useState([]);
  const [selected, setSelected] = useState(null);
  const [name, setName] = useState("");
  const [type, setType] = useState("generic");
  const [startCommand, setStartCommand] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    api.get("/plans").then((res) => setPlans(res.plans));
  }, []);

  async function createOrder(e) {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      await api.post("/orders", {
        planId: selected.id,
        serverName: name,
        serverType: type,
        startCommand: startCommand || undefined,
      });
      navigate("/orders");
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  if (selected) {
    return (
      <div>
        <div className="topbar"><h1>Novo servidor — {selected.name}</h1></div>
        <div className="card" style={{ maxWidth: 480 }}>
          {error && <div className="error-box">{error}</div>}
          <form onSubmit={createOrder}>
            <div className="field">
              <label>Nome do servidor</label>
              <input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} placeholder="Meu Bot Discord" />
            </div>
            <div className="field">
              <label>Tipo</label>
              <select value={type} onChange={(e) => setType(e.target.value)}>
                <option value="generic">Genérico</option>
                <option value="discord-bot">Bot do Discord</option>
                <option value="node-app">Aplicação Node.js</option>
                <option value="web-app">Aplicação Web</option>
              </select>
            </div>
            <div className="field">
              <label>Comando de inicialização (opcional, pode configurar depois)</label>
              <input value={startCommand} onChange={(e) => setStartCommand(e.target.value)} placeholder="node index.js" />
            </div>
            <div className="flex">
              <button type="submit" disabled={submitting}>{submitting ? "Criando pedido..." : `Confirmar pedido — ${money(selected.price_cents, selected.currency)}`}</button>
              <button type="button" className="secondary" onClick={() => setSelected(null)}>Voltar</button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="topbar"><h1>Escolha um plano</h1></div>
      <div className="grid cols-4">
        {plans.map((p) => (
          <div key={p.id} className="card">
            <h3 style={{ marginTop: 0 }}>{p.name}</h3>
            <div style={{ fontSize: 24, fontWeight: 700 }}>{money(p.price_cents, p.currency)}<span className="muted" style={{ fontSize: 13, fontWeight: 400 }}>/mês</span></div>
            <ul className="muted" style={{ paddingLeft: 18, fontSize: 14 }}>
              <li>{p.ram_mb} MB RAM</li>
              <li>{p.cpu_percent}% CPU</li>
              <li>{p.disk_mb} MB disco</li>
              <li>{p.max_backups} backups</li>
            </ul>
            <button style={{ width: "100%" }} onClick={() => setSelected(p)}>Selecionar</button>
          </div>
        ))}
      </div>
    </div>
  );
}
