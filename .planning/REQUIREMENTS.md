# Requirements: Slack → ClickUp Task Bot

**Core Value:** Convertir un mensaje libre en Slack en una tarea de ClickUp correcta y completa (cliente + asignado + fechas) sin llenar formularios a mano.

> **v1.0 — SHIPPED** (deployed live on Vercel). Ingestion, OpenAI parse + resolver, Confirm/Edit/Cancel preview, ClickUp create + link-back, reverse notifications (Flow B), base hardening (errors-in-thread, 429 retry, kill switch). See `.planning/milestones/` / git history.

---

## Milestone v1.1 — Dynamic Config + Security Hardening

**Defined:** 2026-06-19

### Dynamic Configuration

- [x] **DYN-01**: El bot lee las opciones del custom field "Cliente" en vivo desde ClickUp (GET field) en lugar de la lista hardcodeada
- [x] **DYN-02**: Las opciones de Cliente se cachean en Redis con TTL (≈10 min); agregar o renombrar un cliente en ClickUp se refleja sin redeploy una vez expira el cache
- [x] **DYN-03**: El bot lee los miembros del workspace ClickUp en vivo (cacheados en Redis con TTL) para resolver asignados, sin los 9 IDs hardcodeados
- [x] **DYN-04**: El mapa Slack→ClickUp se resuelve por email (Slack `users.info` email ↔ email del miembro ClickUp), sin IDs de Slack hardcodeados
- [x] **DYN-05**: Fallback resiliente: si ClickUp o Redis fallan, el bot usa el último cache válido o los maps estáticos como respaldo, sin romper el flujo de parseo
- [x] **DYN-06**: Existe una forma de refrescar/invalidar el cache manualmente (endpoint o comando) tras agregar un cliente o miembro

### Security Audit

- [ ] **SEC-01**: Auditoría OWASP Top 10 (2021) de toda la app, con hallazgos clasificados por severidad (crítico/alto/medio/bajo)
- [ ] **SEC-02**: Análisis de ciberseguridad cubriendo: verificación de firmas (Slack signing + ClickUp X-Signature), manejo y no-exposición de secrets, validación de entrada, SSRF/inyección en el fetch a ClickUp, exposición del endpoint `/api/slack/diag`, y dependencias vulnerables
- [ ] **SEC-03**: Reporte escrito (SECURITY.md) con los hallazgos y un plan de remediación priorizado

### Security Hardening (fixes)

- [x] **SEC-04**: Endurecer o retirar el endpoint `/api/slack/diag` en producción (gating fuerte, rate-limit, o gate por env para que no quede expuesto)
- [x] **SEC-05**: Corregir los hallazgos críticos y altos del audit (validación de entrada, headers, control de acceso, manejo de errores)
- [x] **SEC-06**: Garantizar que ningún secret/token se loguee ni se filtre en respuestas o cuerpos de error
- [x] **SEC-07**: Revisar dependencias por vulnerabilidades conocidas y actualizar las que sean críticas/altas

## Future Requirements

- **DYN-F1**: Mostrar hora exacta en due dates ("a las 12") con `due_date_time` en ClickUp
- **DYN-F2**: Auto-registro/rotación del webhook de ClickUp sin script manual

## Out of Scope

| Feature | Reason |
|---------|--------|
| Editar tareas existentes en ClickUp desde Slack | Fuera del valor central; v1 crea, no edita |
| Multi-workspace / multi-tenant | Un solo workspace (aprendoseo) |
| Auth de usuario / OAuth por persona | Token de bot único alcanza |
| Reescritura del modelo de datos | Hardening es quirúrgico, no refactor mayor |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| DYN-01 | Phase 6 | Done |
| DYN-02 | Phase 6 | Done |
| DYN-03 | Phase 6 | Done |
| DYN-04 | Phase 6 | Done |
| DYN-05 | Phase 6 | Done |
| DYN-06 | Phase 6 | Done |
| SEC-01 | Phase 7 | Pending |
| SEC-02 | Phase 7 | Pending |
| SEC-03 | Phase 7 | Pending |
| SEC-04 | Phase 8 | Done |
| SEC-05 | Phase 8 | Done |
| SEC-06 | Phase 8 | Done |
| SEC-07 | Phase 8 | Done |

**Coverage:**
- v1.1 requirements: 13 total (DYN-01..06, SEC-01..07)
- Mapped to phases: 13 ✓ (Phase 6: DYN, Phase 7: SEC audit, Phase 8: SEC hardening)
- Unmapped: 0

---
*v1.1 requirements defined: 2026-06-19*
