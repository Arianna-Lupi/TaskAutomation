# Requirements: Slack → ClickUp Task Bot

**Defined:** 2026-06-18
**Core Value:** Convertir un mensaje libre en Slack en una tarea de ClickUp correcta y completa (cliente + asignado + fechas) sin llenar formularios a mano.

## v1 Requirements

Requirements for initial release. Each maps to roadmap phases.

### Ingestion (Slack inbound)

- [x] **INGEST-01**: El bot recibe eventos del canal Slack dedicado y verifica la firma HMAC de Slack sobre el body crudo *(offline-verified; live deploy handshake pending)*
- [x] **INGEST-02**: El bot responde (ACK) en menos de 3s y procesa el trabajo pesado en background (waitUntil) *(adapter ACK-then-waitUntil wired; live <3s timing pending)*
- [x] **INGEST-03**: El bot deduplica reintentos de Slack (idempotencia por event_id/message_ts) para no crear tareas duplicadas
- [x] **INGEST-04**: El bot solo procesa mensajes raíz de humanos del canal designado (ignora sus propios mensajes y bots — evita echo loops)

### Parsing (IA)

- [x] **PARSE-01**: El bot extrae con OpenAI (structured outputs, json_schema strict) un objeto estructurado: título, descripción, cliente, asignados, start date, due date, links
- [x] **PARSE-02**: El bot resuelve el "cliente" a una de las 7 opciones del dropdown ClickUp por su option UUID (valida contra la lista; sin match → null)
- [x] **PARSE-03**: El bot resuelve asignados a member IDs de ClickUp vía mapa fijo Slack→ClickUp + resolución de nombres del texto (sin match → null)
- [x] **PARSE-04**: El bot resuelve fechas relativas en español ("viernes", "mañana") a epoch en milisegundos en la zona horaria del equipo

### Confirmation (human gate)

- [x] **CONFIRM-01**: El bot postea un preview en el hilo del mensaje mostrando los valores ya resueltos (cliente, asignados, fechas) y marca los campos sin resolver
- [x] **CONFIRM-02**: El preview tiene botones Block Kit Confirmar / Editar / Cancelar
- [x] **CONFIRM-03**: El estado del "pending task" persiste fuera de memoria (Upstash Redis, keyed por pendingId en el valor del botón) y sobrevive cold starts
- [x] **CONFIRM-04**: "Editar" abre un modal con selects para corregir cliente/asignados/fechas antes de crear
- [x] **CONFIRM-05**: "Cancelar" descarta el pending y actualiza el mensaje; los botones se deshabilitan tras una acción

### Task Creation (ClickUp outbound)

- [x] **CREATE-01**: Al confirmar, el bot crea la tarea en la list destino (Task- Seo Team) con título, descripción, asignados y fechas en epoch ms
- [x] **CREATE-02**: El bot setea el custom field Cliente por option UUID y el campo Link/Loom cuando hay link
- [x] **CREATE-03**: El bot postea el link de la tarea creada de vuelta al hilo del mensaje original
- [x] **CREATE-04**: El bot escribe el mapeo task↔thread (taskID → channel+thread_ts) para notificaciones reversas

### Reverse Notifications (ClickUp inbound)

- [x] **NOTIFY-01**: El bot expone un endpoint webhook que verifica la firma X-Signature de ClickUp sobre el body crudo *(offline-verified; live registration pending)*
- [x] **NOTIFY-02**: El bot registra y escucha taskStatusUpdated y taskAssigneeUpdated *(handler + registration script done; live registration pending)*
- [x] **NOTIFY-03**: El bot postea cambios de estatus/asignado en el hilo correspondiente (usando el mapa task↔thread) filtrando solo transiciones relevantes

### Hardening

- [x] **HARD-01**: Errores de parseo/creación se reportan en el hilo con mensaje claro (no fallo silencioso)
- [x] **HARD-02**: El bot maneja rate limits (429) con backoff y deduplica redeliveries de webhook
- [x] **HARD-03**: Existe un kill switch por canal para desactivar el bot sin redeploy

## v2 Requirements

Deferred to future release. Tracked but not in current roadmap.

### Confirmation UX

- **CONFIRMV2-01**: Confirmación 1-click para parses de alta confianza
- **CONFIRMV2-02**: Confirmación por reacción emoji

### Pipelines

- **PIPE-01**: Pipeline resumen de reunión RIPAI → tarea ClickUp

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| Sincronización de edición bidireccional (Slack edita ClickUp y viceversa) | Complejidad alta; no aporta al equipo de 3-4 personas |
| Escuchar múltiples canales / DMs / slash commands | v1 es un solo canal dedicado |
| OAuth por usuario | Token de bot único es suficiente para equipo interno |
| Crear tareas sin confirmación humana | El gate humano es el core; evita tareas mal parseadas |
| UI de configuración / dashboard de analytics | Config-as-code basta para este tamaño |
| Recordatorios / SLA / subtareas / comentarios paridad ClickUp | Fuera del valor central |
| Automatización "Read Eye Task" | Pertenece a Aprendo Club, otro proyecto |
| Reporte diario SEO (rankings/GSC) | Automatización separada, datos sin especificar |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| INGEST-01 | Phase 1 | Complete (offline; live deploy pending) |
| INGEST-02 | Phase 1 | Complete (offline; live <3s pending) |
| INGEST-03 | Phase 1 | Complete |
| INGEST-04 | Phase 1 | Complete |
| PARSE-01 | Phase 2 | Complete |
| PARSE-02 | Phase 2 | Complete |
| PARSE-03 | Phase 2 | Complete |
| PARSE-04 | Phase 2 | Complete |
| CONFIRM-01 | Phase 3 | Done |
| CONFIRM-02 | Phase 3 | Done |
| CONFIRM-03 | Phase 3 | Done |
| CONFIRM-04 | Phase 3 | Done |
| CONFIRM-05 | Phase 3 | Done |
| CREATE-01 | Phase 3 | Done |
| CREATE-02 | Phase 3 | Done |
| CREATE-03 | Phase 3 | Done |
| CREATE-04 | Phase 3 | Done |
| NOTIFY-01 | Phase 4 | Complete (offline; live registration pending) |
| NOTIFY-02 | Phase 4 | Complete (offline; live registration pending) |
| NOTIFY-03 | Phase 4 | Complete |
| HARD-01 | Phase 5 | Complete |
| HARD-02 | Phase 5 | Complete (offline-verified; live 429/5xx backoff timing pending) |
| HARD-03 | Phase 5 | Complete |

**Coverage:**
- v1 requirements: 23 total (note: earlier header said 21; the listed items total 23 — all are mapped)
- Mapped to phases: 23
- Unmapped: 0 ✓

---
*Requirements defined: 2026-06-18*
*Last updated: 2026-06-18 — Phase 5 complete (HARD-01..03; live 429/5xx backoff timing deferred). All v1 requirements done.*
