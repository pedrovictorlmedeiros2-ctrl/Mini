import { useEffect, useState } from "react";
import { api } from "../../api.js";

export default function AdminOverview() {
  const [data, setData] = useState(null);

  useEffect(() => {
    api.get("/admin/overview").then(setData);
    const t = setInterval(() => api.get("/admin/overview").then(setData), 10000);
    return () => clearInterval(t);
  }, []);

  if (!data) return <div className="empty">Carregando...</div>;
  const { counts, queue } = data;

  return (
    <div>
      <div className="topbar"><h1>Visão geral</h1></div>
      <div className="grid cols-4">
        <div className="stat"><div className="label">Usuários</div><div className="value">{counts.users}</div></div>
        <div className="stat"><div className="label">Servidores ativos</div><div className="value">{counts.servers}</div></div>
        <div className="stat"><div className="label">Rodando agora</div><div className="value">{counts.servers_running}</div></div>
        <div className="stat"><div className="label">Nodes ativos</div><div className="value">{counts.nodes_active} / {counts.nodes}</div></div>
        <div className="stat"><div className="label">Pedidos provisionados</div><div className="value">{counts.orders_provisioned}</div></div>
        <div className="stat"><div className="label">Receita (aprovada)</div><div className="value">{(counts.revenue_cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}</div></div>
        <div className="stat"><div className="label">Fila — profundidade</div><div className="value">{queue.depth}</div></div>
        <div className="stat"><div className="label">Fila — em execução</div><div className="value">{queue.inFlight}</div></div>
      </div>
    </div>
  );
}
