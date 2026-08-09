# Grafana — Atlantic Host

## Prometheus scrape

```yaml
# prometheus.yml
scrape_configs:
  - job_name: atlantic-host
    metrics_path: /metrics
    static_configs:
      - targets: ['atlantic-host:3001']
```

## Importar dashboard

1. Grafana → Dashboards → Import
2. Cole o conteúdo de `atlantic-host-dashboard.json`
3. Selecione o datasource Prometheus

Métricas usadas:
- `hosting_bots_total` / `hosting_bots_online` / `hosting_bots_suspended`
- `hosting_panel_uptime_seconds`
- `hosting_panel_memory_rss_bytes` / `hosting_panel_memory_heap_bytes`
- `hosting_host_memory_*` / `hosting_host_load1`
- `hosting_queue_size` / `hosting_queue_processed_total` / `hosting_queue_failed_total`
- `hosting_orders_open`
