import { DateTime } from "luxon";
import { CLIENTS } from "../config/clients.js";
import { MEMBERS } from "../config/members.js";
import { escapeSlackText } from "../util/slackMrkdwn.js";
import type { ResolvedTask } from "../resolve/types.js";

/**
 * Spanish Block Kit builders for the confirmation flow (Phase 3 Flow A). Pure
 * functions over plain objects — no Slack client, no I/O — so they are fully
 * offline-testable. Display values come from the inverted config maps (option
 * UUID → name, member id → name), never from raw LLM strings, so the human
 * confirms exactly what will be written to ClickUp (Pitfall 4 / UX).
 */

/** Loosely-typed Block Kit block (we emit plain objects Slack accepts). */
export type Block = Record<string, unknown>;

/** action_id constants shared with the interaction handlers (plans 03/04). */
export const CONFIRM_ACTION_ID = "confirm_task";
export const EDIT_ACTION_ID = "edit_task";
export const CANCEL_ACTION_ID = "cancel_task";

const WARN = "⚠️ sin resolver";

// Reverse lookups built once at module load (pure constants, no I/O).
const OPTION_TO_CLIENT: Record<string, string> = Object.fromEntries(
  Object.entries(CLIENTS).map(([name, uuid]) => [uuid, name]),
);
const ID_TO_MEMBER: Record<number, string> = Object.fromEntries(
  Object.entries(MEMBERS).map(([name, id]) => [id, name]),
);

/** Spanish abbreviated weekday + day + month + year, e.g. "vie 20 jun 2026". */
function formatDate(ms: number, timezone: string): string {
  return DateTime.fromMillis(ms, { zone: timezone })
    .setLocale("es")
    .toFormat("ccc d LLL yyyy");
}

function clienteLine(resolved: ResolvedTask): string {
  if (resolved.clienteOptionId == null) return WARN;
  const name = OPTION_TO_CLIENT[resolved.clienteOptionId];
  return name != null ? escapeSlackText(name) : WARN;
}

function asignadosLine(resolved: ResolvedTask): string {
  const names = resolved.assigneeIds
    .map((id) => ID_TO_MEMBER[id])
    .filter((n): n is string => Boolean(n))
    .map((n) => escapeSlackText(n));
  // The ⚠️ marker is a trusted literal; only the untrusted name is escaped.
  const flagged = resolved.unresolvedAssignees.map((a) => `⚠️ ${escapeSlackText(a)}`);
  const all = [...names, ...flagged];
  if (all.length === 0) return WARN;
  return all.join(", ");
}

function section(text: string): Block {
  return { type: "section", text: { type: "mrkdwn", text } };
}

/**
 * The threaded preview: a section summarizing the resolved task (⚠️-flagging any
 * field the resolver left null) plus an actions block with Confirmar / Editar /
 * Cancelar, each carrying the pendingId in its `value`.
 */
export function buildPreviewBlocks(
  pendingId: string,
  resolved: ResolvedTask,
  opts: { timezone: string },
): Block[] {
  const { timezone } = opts;
  // Untrusted fields (title, description, links, names) are escaped so a crafted
  // value like <!channel> or <@U123> cannot ping/spoof in the preview (FIND-07).
  // The static labels, ⚠️ markers, formatted dates, and the _(...)_ placeholder
  // fallbacks are trusted literals and are NOT escaped.
  const descripcion = resolved.description?.trim()
    ? escapeSlackText(resolved.description)
    : "_(sin descripción)_";
  const inicio =
    resolved.startDateMs != null ? formatDate(resolved.startDateMs, timezone) : WARN;
  const entrega =
    resolved.dueDateMs != null ? formatDate(resolved.dueDateMs, timezone) : WARN;
  const links =
    resolved.links.length > 0
      ? resolved.links.map((l) => escapeSlackText(l)).join("\n")
      : "_(sin links)_";

  const summary = [
    `*Título:* ${escapeSlackText(resolved.title)}`,
    `*Descripción:* ${descripcion}`,
    `*Cliente:* ${clienteLine(resolved)}`,
    `*Asignados:* ${asignadosLine(resolved)}`,
    `*Inicio:* ${inicio}`,
    `*Entrega:* ${entrega}`,
    `*Links:* ${links}`,
  ].join("\n");

  return [
    section("*Nueva tarea.* Revisa los datos antes de confirmar."),
    section(summary),
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Confirmar", emoji: true },
          style: "primary",
          action_id: CONFIRM_ACTION_ID,
          value: pendingId,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Editar", emoji: true },
          action_id: EDIT_ACTION_ID,
          value: pendingId,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Cancelar", emoji: true },
          style: "danger",
          action_id: CANCEL_ACTION_ID,
          value: pendingId,
        },
      ],
    },
  ];
}

/** Terminal "✅ Tarea creada" state with the task link and NO buttons. */
export function buildConfirmedBlocks(taskUrl: string): Block[] {
  return [section(`✅ *Tarea creada.* <${taskUrl}|Abrir en ClickUp>`)];
}

/** Terminal "❌ Cancelado" state with NO buttons. */
export function buildCanceledBlocks(): Block[] {
  return [section("❌ *Cancelada.* No se creó ninguna tarea.")];
}
