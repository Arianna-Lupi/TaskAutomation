# DEPLOY — Setup paso a paso (Slack → ClickUp Task Bot)

Runbook completo para dejar el bot operativo. Orden importa: Slack y ClickUp necesitan la URL del deploy.

> Costo: Upstash Redis y Vercel (Hobby) son **gratis** para este volumen. Lo único pago es **OpenAI** (gpt-4o-mini, centavos por mensaje).

---

## 0. Cuentas necesarias

- GitHub (repo del bot)
- Vercel (hosting)
- Upstash (Redis — vía Vercel Marketplace)
- OpenAI (API key, con billing)
- ClickUp (API token — workspace de los clientes)
- Slack (app en el workspace; **instalación requiere admin** si el workspace es org-managed)

---

## 1. OpenAI API key

platform.openai.com → **API keys → Create new secret key** → copiá `sk-...`. Confirmá billing activo (Settings → Billing).
- `OPENAI_API_KEY = sk-...`
- `OPENAI_MODEL = gpt-4o-mini`

## 2. ClickUp API token

ClickUp → avatar (abajo izq) → **Settings → Apps → API Token → Generate** → `pk_...`.
- `CLICKUP_API_TOKEN = pk_...`
- `CLICKUP_LIST_ID = 901327239630` (lista Task- Seo Team — ya por default)
- `CLICKUP_TEAM_ID = 90131720021` (workspace — ya por default)

## 3. Slack app (vía manifest — recomendado para workspace org-managed)

El workspace es org-managed: **solo un admin puede instalar**. Si no sos admin, que lo haga Arianna.

1. api.slack.com/apps → **Create New App → From an app manifest** → elegí el workspace.
2. Pegá:

```yaml
display_information:
  name: AutomationClickup
features:
  bot_user:
    display_name: AutomationClickup
    always_online: true
oauth_config:
  scopes:
    bot:
      - chat:write
      - channels:history
settings:
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

3. **Create** → **Install to Workspace** (admin autoriza).
4. Copiá:
   - **Basic Information → App Credentials → Signing Secret** → `SLACK_SIGNING_SECRET` (disponible aún sin instalar).
   - **OAuth & Permissions → Bot User OAuth Token** (`xoxb-...`) → `SLACK_BOT_TOKEN` (aparece tras instalar).
5. Creá el canal dedicado (ej `#tareas`), invitá al bot (`/invite @AutomationClickup`), y sacá el **Channel ID** (`C...`, en View channel details) → `SLACK_TASK_CHANNEL_ID`.

> Las Request URLs de eventos/interactividad se setean DESPUÉS del deploy (paso 5). No las pongas en el manifest — Slack intenta verificarlas y falla si el bot aún no está en Vercel.
> NO necesitás Redirect URL. NO uses "Manage Distribution" (eso es para distribuir a otros workspaces).

## 4. Vercel — deploy + Upstash + env vars

1. vercel.com → **Add New → Project → Import** el repo.
2. Framework Preset: **Other**. (El repo ya trae `vercel.json` con `outputDirectory: public` y `public/index.html`, así que el build de funciones-only no falla.)
3. **Settings → Functions → Fluid Compute** → debe estar **ON** (en proyectos nuevos viene activado por default; confirmá). Necesario para `waitUntil`.
4. **Storage → Upstash → Redis** (plan **Free**) → conectar al proyecto.
   - Upstash inyecta vars con nombres estilo `KV_*`. El código usa otros nombres. **Mapealos:**
     - `UPSTASH_REDIS_REST_URL`   = valor de `KV_REST_API_URL`
     - `UPSTASH_REDIS_REST_TOKEN` = valor de `KV_REST_API_TOKEN`
     - (ignorá `KV_URL`, `REDIS_URL`, `KV_REST_API_READ_ONLY_TOKEN`)
5. **Settings → Environment Variables** → cargá todo (Production + Preview). El código **valida que TODAS existan no-vacías** al arrancar; poné placeholders en las que aún no tengas y reemplazalas luego:

```
OPENAI_API_KEY          = sk-...
OPENAI_MODEL            = gpt-4o-mini
CLICKUP_API_TOKEN       = pk_...
CLICKUP_LIST_ID         = 901327239630
CLICKUP_TEAM_ID         = 90131720021
TEAM_TIMEZONE           = America/Caracas
SLACK_SIGNING_SECRET    = ...           (paso 3 — ya disponible)
SLACK_BOT_TOKEN         = xoxb-...       (tras instalar; placeholder mientras tanto)
SLACK_TASK_CHANNEL_ID   = C...           (tras crear canal)
UPSTASH_REDIS_REST_URL  = ...            (paso 4)
UPSTASH_REDIS_REST_TOKEN = ...           (paso 4)
CLICKUP_WEBHOOK_SECRET  = ...            (paso 6 — placeholder mientras tanto)
OPS_API_TOKEN           = ...            (OPCIONAL — ver "Operación")
```

> `OPS_API_TOKEN` es opcional. Dejalo sin definir y los endpoints de ops
> (`/api/slack/diag`, `/api/admin/refresh-config`) quedan apagados (responden 404).
> Definilo (un valor random de 32+ chars, ej `openssl rand -hex 24`) para
> habilitar el acceso ops vía `Authorization: Bearer`.

6. **Deploy.** Copiá la **URL de producción** (ej `https://task-automation-puce.vercel.app`).

> Node: el repo pide Node 20 vía `package.json` engines; Vercel lo respeta aunque el Project Settings diga otra cosa (warning inofensivo).
> Los warnings de `npm deprecated` (glob/uuid/tar...) son del toolchain de Vercel, no del bot. Ignorables.

## 5. Conectar Slack al deploy

api.slack.com/apps → tu app:

1. **Event Subscriptions → Enable Events ON**
   - Request URL: `https://<DEPLOY_URL>/api/slack/events` → debe dar **Verified ✓** (requiere `SLACK_SIGNING_SECRET` real en Vercel).
   - **Subscribe to bot events**: `message.channels` (o `message.groups` si el canal es privado). Save.
2. **Interactivity & Shortcuts → ON**
   - Request URL: `https://<DEPLOY_URL>/api/slack/interactions`. Save.
3. Si pide reinstalar por los cambios → **Reinstall to Workspace**.

## 6. Registrar webhook de ClickUp (Flow B)

Con el deploy arriba y `CLICKUP_API_TOKEN` a mano:

```bash
CLICKUP_API_TOKEN=pk_xxx node scripts/register-clickup-webhook.mjs https://<DEPLOY_URL>/api/clickup/webhook
```

Imprime `id` + `secret`. Copiá el **secret** → Vercel env `CLICKUP_WEBHOOK_SECRET` → **Redeploy**.

## 7. Prueba end-to-end

1. En `#tareas` escribí: `Tarea para Vero: diseñar landing de Apturio, entrega el viernes, link figma.com/abc`
2. El bot responde en el hilo con el **preview** (cliente, asignado, fechas; ⚠️ en lo no resuelto).
3. **Editar** (modal con selects) si algo está mal, o **Confirmar**.
4. Confirmar → crea la tarea en ClickUp + postea el **link** en el hilo.
5. En ClickUp cambiá estado/asignado de esa tarea → llega notificación al mismo hilo (Flow B).

---

## Probar el "cerebro" sin Slack (camino B)

Corre los módulos reales del bot (OpenAI + ClickUp) sin Slack:

```bash
# Solo parse + resolve (NO crea tarea):
OPENAI_API_KEY=sk-... SIM_DRY=1 npx vitest run simulate.live

# Parse + resolve + crea la tarea real (borrala después si es prueba):
OPENAI_API_KEY=sk-... CLICKUP_API_TOKEN=pk_... npx vitest run simulate.live

# Mensaje propio:
SIM_MESSAGE="..." OPENAI_API_KEY=sk-... CLICKUP_API_TOKEN=pk_... npx vitest run simulate.live
```

---

## Operación

**Kill switch (sin redeploy)** — apaga el bot en un canal si se porta mal:

```bash
node scripts/killswitch.mjs C0123ABC on    # apagar en ese canal
node scripts/killswitch.mjs C0123ABC off   # reactivar
node scripts/killswitch.mjs all on         # apagar TODO
```

**Endpoints de ops (diag + refresh-config)** — apagados por defecto:

```bash
# Definí OPS_API_TOKEN en Vercel para encenderlos (sin él dan 404).
# Salud del bot (solo conteos/booleanos, sin lista de canales ni host de redis):
curl -H "Authorization: Bearer $OPS_API_TOKEN" https://<DEPLOY_URL>/api/slack/diag

# Unir el bot al canal de tareas configurado (POST, único canal posible):
curl -X POST -H "Authorization: Bearer $OPS_API_TOKEN" https://<DEPLOY_URL>/api/slack/diag

# Refrescar el cache de config (POST; devuelve clearedCount):
curl -X POST -H "Authorization: Bearer $OPS_API_TOKEN" https://<DEPLOY_URL>/api/admin/refresh-config
```

El token va siempre en el header `Authorization: Bearer`, nunca en la URL. El
signing secret de Slack ya no se usa como llave de ops.

**Troubleshooting:**
- *Slack "Request URL not verified"*: deploy caído o `SLACK_SIGNING_SECRET` mal. Mirá Vercel → Deployments → Functions (logs).
- *No crea tarea*: `CLICKUP_API_TOKEN` tal cual `pk_...` (sin `Bearer`), y el bot debe estar en el canal.
- *Build falla "Output Directory public"*: ya resuelto (existe `public/` + `vercel.json`). Si reaparece, confirmá que el commit incluye ambos.
- *Build falla "Function Runtimes must have a valid version"*: ya resuelto (se quitó `runtime` de `vercel.json`).
