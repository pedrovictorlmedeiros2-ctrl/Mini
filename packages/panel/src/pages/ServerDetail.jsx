import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, wsUrl, ApiError } from "../api.js";
import StatusBadge from "../components/StatusBadge.jsx";

function ConsoleTab({ server }) {
  const [lines, setLines] = useState([]);
  const boxRef = useRef(null);

  useEffect(() => {
    setLines([]);
    const ws = new WebSocket(wsUrl("/ws/panel"));
    ws.onopen = () => ws.send(JSON.stringify({ type: "subscribe_console", serverId: server.id }));
    ws.onmessage = (evt) => {
      const msg = JSON.parse(evt.data);
      if (msg.type === "console_log" && msg.serverId === server.id) {
        setLines((prev) => [...prev.slice(-999), msg]);
      }
    };
    return () => {
      try { ws.send(JSON.stringify({ type: "unsubscribe_console", serverId: server.id })); } catch { /* closing */ }
      ws.close();
    };
  }, [server.id]);

  useEffect(() => {
    if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [lines]);

  return (
    <div className="console" ref={boxRef}>
      {lines.length === 0 && <div className="muted">Aguardando saída do console... (o console só transmite enquanto o servidor está em execução)</div>}
      {lines.map((l, i) => (
        <div key={i} className="line" data-ts={new Date(l.ts).toLocaleTimeString()}>{l.line}</div>
      ))}
    </div>
  );
}

function FilesTab({ server }) {
  const [path, setPath] = useState(".");
  const [entries, setEntries] = useState([]);
  const [editing, setEditing] = useState(null);
  const [content, setContent] = useState("");
  const [error, setError] = useState("");

  const load = useCallback((p) => {
    setError("");
    api.get(`/servers/${server.id}/files?path=${encodeURIComponent(p)}`)
      .then((res) => { setEntries(res.entries); setPath(p); })
      .catch((err) => setError(err.message));
  }, [server.id]);

  useEffect(() => { load("."); }, [load]);

  async function openFile(name) {
    const filePath = path === "." ? name : `${path}/${name}`;
    try {
      const res = await api.get(`/servers/${server.id}/files/content?path=${encodeURIComponent(filePath)}`);
      setEditing(filePath);
      setContent(res.content);
    } catch (err) {
      setError(err.message);
    }
  }

  async function save() {
    await api.put(`/servers/${server.id}/files/content`, { path: editing, content });
    setEditing(null);
    load(path);
  }

  async function del(name) {
    const filePath = path === "." ? name : `${path}/${name}`;
    if (!confirm(`Excluir ${filePath}?`)) return;
    await api.delete(`/servers/${server.id}/files`, { path: filePath });
    load(path);
  }

  async function createFolder() {
    const name = prompt("Nome da nova pasta:");
    if (!name) return;
    await api.post(`/servers/${server.id}/files/mkdir`, { path: path === "." ? name : `${path}/${name}` });
    load(path);
  }

  if (editing) {
    return (
      <div>
        <div className="flex between mb-8">
          <strong>{editing}</strong>
          <div className="flex">
            <button onClick={save}>Salvar</button>
            <button className="secondary" onClick={() => setEditing(null)}>Cancelar</button>
          </div>
        </div>
        <textarea rows={20} value={content} onChange={(e) => setContent(e.target.value)} style={{ fontFamily: "monospace" }} />
      </div>
    );
  }

  const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";

  return (
    <div>
      {error && <div className="error-box">{error}</div>}
      <div className="flex between mb-8">
        <span className="muted">/{path === "." ? "" : path}</span>
        <button className="secondary" onClick={createFolder}>+ Pasta</button>
      </div>
      {path !== "." && (
        <div className="file-row" style={{ cursor: "pointer" }} onClick={() => load(parent)}>.. (voltar)</div>
      )}
      {entries.map((e) => (
        <div className="file-row" key={e.name}>
          <span
            style={{ cursor: "pointer" }}
            onClick={() => (e.isDirectory ? load(path === "." ? e.name : `${path}/${e.name}`) : openFile(e.name))}
          >
            {e.isDirectory ? "📁" : "📄"} {e.name}
          </span>
          <div className="flex">
            <span className="muted">{e.isDirectory ? "" : `${e.size} B`}</span>
            <button className="secondary" onClick={() => del(e.name)}>Excluir</button>
          </div>
        </div>
      ))}
      {entries.length === 0 && <div className="empty">Pasta vazia</div>}
    </div>
  );
}

function EnvTab({ server }) {
  const [env, setEnv] = useState([]);
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(() => {
    api.get(`/servers/${server.id}/env`).then((res) => setEnv(res.env));
  }, [server.id]);

  useEffect(() => { load(); }, [load]);

  async function add(e) {
    e.preventDefault();
    setError("");
    try {
      await api.put(`/servers/${server.id}/env`, { key, value });
      setKey(""); setValue("");
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function remove(k) {
    await api.delete(`/servers/${server.id}/env/${encodeURIComponent(k)}`);
    load();
  }

  return (
    <div>
      {error && <div className="error-box">{error}</div>}
      <table>
        <thead><tr><th>Variável</th><th>Valor</th><th></th></tr></thead>
        <tbody>
          {env.map((e) => (
            <tr key={e.key}>
              <td><code>{e.key}</code></td>
              <td className="muted">{e.value}</td>
              <td><button className="secondary" onClick={() => remove(e.key)}>Remover</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <form onSubmit={add} className="flex mt-16">
        <input placeholder="CHAVE" value={key} onChange={(e) => setKey(e.target.value.toUpperCase())} required />
        <input placeholder="valor" value={value} onChange={(e) => setValue(e.target.value)} required />
        <button type="submit">Adicionar</button>
      </form>
      <p className="muted">Valores identificados como sensíveis (token, secret, senha, key) são mascarados automaticamente.</p>
    </div>
  );
}

function BackupsTab({ server }) {
  const [backups, setBackups] = useState([]);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    api.get(`/servers/${server.id}/backups`).then((res) => setBackups(res.backups));
  }, [server.id]);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  async function create() {
    setError("");
    try {
      await api.post(`/servers/${server.id}/backups`);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function restore(id) {
    if (!confirm("Restaurar este backup irá substituir todos os arquivos atuais do servidor. Continuar?")) return;
    await api.post(`/servers/${server.id}/backups/${id}/restore`);
    load();
  }

  return (
    <div>
      {error && <div className="error-box">{error}</div>}
      <button onClick={create} className="mb-8">+ Criar backup</button>
      <table>
        <thead><tr><th>Criado em</th><th>Status</th><th>Tamanho</th><th></th></tr></thead>
        <tbody>
          {backups.map((b) => (
            <tr key={b.id}>
              <td>{b.created_at}</td>
              <td><StatusBadge status={b.status} /></td>
              <td className="muted">{b.size_bytes ? `${Math.round(b.size_bytes / 1024)} KB` : "—"}</td>
              <td>{b.status === "COMPLETED" && <button className="secondary" onClick={() => restore(b.id)}>Restaurar</button>}</td>
            </tr>
          ))}
          {backups.length === 0 && <tr><td colSpan={4} className="empty">Nenhum backup ainda</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function DomainsTab({ server }) {
  const [domains, setDomains] = useState([]);
  const [hostname, setHostname] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(() => {
    api.get(`/servers/${server.id}/domains`).then((res) => setDomains(res.domains));
  }, [server.id]);

  useEffect(() => { load(); }, [load]);

  async function add(e) {
    e.preventDefault();
    setError("");
    try {
      await api.post(`/servers/${server.id}/domains`, { hostname });
      setHostname("");
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function remove(id) {
    await api.delete(`/servers/${server.id}/domains/${id}`);
    load();
  }

  return (
    <div>
      {error && <div className="error-box">{error}</div>}
      <table>
        <thead><tr><th>Domínio</th><th>Verificado</th><th></th></tr></thead>
        <tbody>
          {domains.map((d) => (
            <tr key={d.id}>
              <td>{d.hostname}</td>
              <td className="muted">{d.verified ? "Sim" : `Não — aponte um registro TXT com o token ${d.verification_token}`}</td>
              <td><button className="secondary" onClick={() => remove(d.id)}>Remover</button></td>
            </tr>
          ))}
          {domains.length === 0 && <tr><td colSpan={3} className="empty">Nenhum domínio associado</td></tr>}
        </tbody>
      </table>
      <form onSubmit={add} className="flex mt-16">
        <input placeholder="meudominio.com" value={hostname} onChange={(e) => setHostname(e.target.value)} required />
        <button type="submit">Adicionar</button>
      </form>
      <p className="muted">
        A verificação de propriedade e o roteamento SSL/reverse-proxy automático ainda não estão implementados nesta versão —
        o domínio fica registrado para configuração manual do DNS.
      </p>
    </div>
  );
}

const TABS = ["console", "files", "env", "backups", "domains"];
const TAB_LABELS = { console: "Console", files: "Arquivos", env: "Variáveis", backups: "Backups", domains: "Domínios" };

export default function ServerDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [server, setServer] = useState(null);
  const [stats, setStats] = useState(null);
  const [tab, setTab] = useState("console");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    api.get(`/servers/${id}`).then((res) => setServer(res.server)).catch((err) => setError(err.message));
  }, [id]);

  useEffect(() => {
    load();
    const ws = new WebSocket(wsUrl("/ws/panel"));
    ws.onmessage = (evt) => {
      const msg = JSON.parse(evt.data);
      if (msg.type === "server_update" && msg.server.id === id) setServer(msg.server);
    };
    return () => ws.close();
  }, [id, load]);

  useEffect(() => {
    if (!server || server.status !== "RUNNING") return;
    const t = setInterval(() => {
      api.get(`/servers/${id}/stats`).then((res) => setStats(res.stats)).catch(() => {});
    }, 4000);
    return () => clearInterval(t);
  }, [server, id]);

  async function action(name) {
    setBusy(true);
    setError("");
    try {
      if (name === "delete") {
        if (!confirm("Excluir este servidor permanentemente? Esta ação não pode ser desfeita.")) { setBusy(false); return; }
        await api.delete(`/servers/${id}`);
        navigate("/");
        return;
      }
      await api.post(`/servers/${id}/${name}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (error && !server) return <div className="error-box">{error}</div>;
  if (!server) return <div className="empty">Carregando...</div>;

  const canStart = ["STOPPED", "ERROR", "CRASHED"].includes(server.status);
  const canStop = ["RUNNING"].includes(server.status);
  const canRestart = ["RUNNING"].includes(server.status);

  return (
    <div>
      <div className="topbar">
        <div>
          <h1>{server.name}</h1>
          <div className="flex" style={{ marginTop: 6 }}>
            <StatusBadge status={server.status} />
            <span className="muted">{server.slug}</span>
          </div>
        </div>
        <div className="flex">
          <button disabled={busy || !canStart} onClick={() => action("start")}>Iniciar</button>
          <button className="secondary" disabled={busy || !canRestart} onClick={() => action("restart")}>Reiniciar</button>
          <button className="secondary" disabled={busy || !canStop} onClick={() => action("stop")}>Parar</button>
          <button className="danger" disabled={busy} onClick={() => action("delete")}>Excluir</button>
        </div>
      </div>

      {error && <div className="error-box">{error}</div>}

      <div className="grid cols-3 mb-8">
        <div className="stat"><div className="label">CPU</div><div className="value">{stats?.running ? `${stats.cpuPercent}%` : "—"}</div></div>
        <div className="stat"><div className="label">RAM</div><div className="value">{stats?.running ? `${stats.memoryUsedMb} MB` : "—"} <span className="muted" style={{ fontSize: 13 }}>/ {server.ram_mb} MB</span></div></div>
        <div className="stat"><div className="label">Processos</div><div className="value">{stats?.running ? stats.pids : "—"}</div></div>
      </div>

      <div className="tabs">
        {TABS.map((t) => (
          <div key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>{TAB_LABELS[t]}</div>
        ))}
      </div>

      <div className="card">
        {tab === "console" && <ConsoleTab server={server} />}
        {tab === "files" && <FilesTab server={server} />}
        {tab === "env" && <EnvTab server={server} />}
        {tab === "backups" && <BackupsTab server={server} />}
        {tab === "domains" && <DomainsTab server={server} />}
      </div>
    </div>
  );
}
