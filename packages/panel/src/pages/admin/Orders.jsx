import { useEffect, useState } from "react";
import { api } from "../../api.js";
import StatusBadge from "../../components/StatusBadge.jsx";

export default function AdminOrders() {
  const [rows, setRows] = useState([]);

  function load() {
    api.get("/orders/admin/all").then((res) => setRows(res.rows));
  }
  useEffect(() => {
    load();
    const t = setInterval(load, 6000);
    return () => clearInterval(t);
  }, []);

  async function approve(o) {
    if (!confirm(`Confirmar pagamento aprovado para o pedido de ${o.user_email}? Isso irá provisionar o servidor.`)) return;
    await api.post(`/orders/${o.id}/approve`);
    load();
  }

  return (
    <div>
      <div className="topbar"><h1>Pedidos</h1></div>
      <div className="card">
        <table>
          <thead><tr><th>Usuário</th><th>Valor</th><th>Status</th><th>Data</th><th></th></tr></thead>
          <tbody>
            {rows.map((o) => (
              <tr key={o.id}>
                <td>{o.user_email}</td>
                <td>{(o.amount_cents / 100).toLocaleString("pt-BR", { style: "currency", currency: o.currency })}</td>
                <td><StatusBadge status={o.status} /></td>
                <td className="muted">{o.created_at}</td>
                <td>{o.status === "PENDING" && <button className="secondary" onClick={() => approve(o)}>Aprovar pagamento</button>}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={5} className="empty">Nenhum pedido</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="muted">
        Aprovação manual simula um gateway de pagamento confirmado (ex.: transferência bancária). Gateways automáticos usam o
        endpoint POST /api/payments/webhook com assinatura HMAC.
      </p>
    </div>
  );
}
