import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";
import StatusBadge from "../components/StatusBadge.jsx";

export default function Orders() {
  const [orders, setOrders] = useState([]);

  useEffect(() => {
    api.get("/orders").then((res) => setOrders(res.orders));
  }, []);

  return (
    <div>
      <div className="topbar"><h1>Meus pedidos</h1></div>
      <div className="card">
        {orders.length === 0 ? (
          <div className="empty">Nenhum pedido ainda. <Link to="/plans">Escolher um plano</Link>.</div>
        ) : (
          <table>
            <thead><tr><th>Data</th><th>Valor</th><th>Status</th></tr></thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id}>
                  <td>{o.created_at}</td>
                  <td>{(o.amount_cents / 100).toLocaleString("pt-BR", { style: "currency", currency: o.currency })}</td>
                  <td><StatusBadge status={o.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <p className="muted">
        Pedidos pendentes aguardam confirmação de pagamento. Após aprovado, o provisionamento do servidor é automático.
      </p>
    </div>
  );
}
