import { DateTime } from "luxon";
import { CLIENTS } from "../config/clients.js";
import { MEMBERS } from "../config/members.js";
import type { ResolvedTask } from "../resolve/types.js";

/**
 * The Editar modal (Phase 3 Flow A — CONFIRM-04). Pure builders/parsers over
 * plain Slack view objects: buildEditModal prefills a view from the pending task;
 * parseEditSubmission maps a view_submission payload back into a ResolvedTask
 * patch. Cliente/Asignados come only from fixed config options (UUIDs / member
 * ids), never free text, so a tampered submission can't smuggle arbitrary values.
 */

export const EDIT_CALLBACK_ID = "edit_modal_submit";

// Stable block + action ids so parseEditSubmission reads the state deterministically.
export const TITLE_BLOCK = "title_block";
export const TITLE_ACTION = "title_action";
export const DESC_BLOCK = "desc_block";
export const DESC_ACTION = "desc_action";
export const CLIENTE_BLOCK = "cliente_block";
export const CLIENTE_ACTION = "cliente_action";
export const ASIGNADOS_BLOCK = "asignados_block";
export const ASIGNADOS_ACTION = "asignados_action";
export const INICIO_BLOCK = "inicio_block";
export const INICIO_ACTION = "inicio_action";
export const ENTREGA_BLOCK = "entrega_block";
export const ENTREGA_ACTION = "entrega_action";

const DATE_FMT = "yyyy-LL-dd";

type Option = { text: { type: "plain_text"; text: string }; value: string };

function plainOption(name: string, value: string): Option {
  return { text: { type: "plain_text", text: name }, value };
}

const CLIENTE_OPTIONS: Option[] = Object.entries(CLIENTS).map(([name, uuid]) =>
  plainOption(name, uuid),
);
const MEMBER_OPTIONS: Option[] = Object.entries(MEMBERS).map(([name, id]) =>
  plainOption(name, String(id)),
);

export type EditModalMeta = {
  pendingId: string;
  channel: string;
  messageTs: string;
};

export type EditModalView = Record<string, unknown>;

/**
 * Build a Slack modal view prefilled from the pending task. private_metadata
 * carries the meta (pendingId/channel/messageTs) across the open→submit gap.
 */
export function buildEditModal(
  resolved: ResolvedTask,
  opts: EditModalMeta & { timezone: string },
): EditModalView {
  const { pendingId, channel, messageTs, timezone } = opts;

  const clienteInitial = resolved.clienteOptionId
    ? CLIENTE_OPTIONS.find((o) => o.value === resolved.clienteOptionId)
    : undefined;

  const asignadosInitial = MEMBER_OPTIONS.filter((o) =>
    resolved.assigneeIds.includes(Number(o.value)),
  );

  const toDateStr = (ms: number | null): string | undefined =>
    ms != null ? DateTime.fromMillis(ms, { zone: timezone }).toFormat(DATE_FMT) : undefined;

  const inicioDate = toDateStr(resolved.startDateMs);
  const entregaDate = toDateStr(resolved.dueDateMs);

  return {
    type: "modal",
    callback_id: EDIT_CALLBACK_ID,
    private_metadata: JSON.stringify({ pendingId, channel, messageTs }),
    title: { type: "plain_text", text: "Editar tarea" },
    submit: { type: "plain_text", text: "Guardar" },
    close: { type: "plain_text", text: "Cancelar" },
    blocks: [
      {
        type: "input",
        block_id: TITLE_BLOCK,
        label: { type: "plain_text", text: "Título" },
        element: {
          type: "plain_text_input",
          action_id: TITLE_ACTION,
          initial_value: resolved.title,
        },
      },
      {
        type: "input",
        block_id: DESC_BLOCK,
        optional: true,
        label: { type: "plain_text", text: "Descripción" },
        element: {
          type: "plain_text_input",
          action_id: DESC_ACTION,
          multiline: true,
          ...(resolved.description ? { initial_value: resolved.description } : {}),
        },
      },
      {
        type: "input",
        block_id: CLIENTE_BLOCK,
        optional: true,
        label: { type: "plain_text", text: "Cliente" },
        element: {
          type: "static_select",
          action_id: CLIENTE_ACTION,
          options: CLIENTE_OPTIONS,
          ...(clienteInitial ? { initial_option: clienteInitial } : {}),
        },
      },
      {
        type: "input",
        block_id: ASIGNADOS_BLOCK,
        optional: true,
        label: { type: "plain_text", text: "Asignados" },
        element: {
          type: "multi_static_select",
          action_id: ASIGNADOS_ACTION,
          options: MEMBER_OPTIONS,
          ...(asignadosInitial.length > 0 ? { initial_options: asignadosInitial } : {}),
        },
      },
      {
        type: "input",
        block_id: INICIO_BLOCK,
        optional: true,
        label: { type: "plain_text", text: "Inicio" },
        element: {
          type: "datepicker",
          action_id: INICIO_ACTION,
          ...(inicioDate ? { initial_date: inicioDate } : {}),
        },
      },
      {
        type: "input",
        block_id: ENTREGA_BLOCK,
        optional: true,
        label: { type: "plain_text", text: "Entrega" },
        element: {
          type: "datepicker",
          action_id: ENTREGA_ACTION,
          ...(entregaDate ? { initial_date: entregaDate } : {}),
        },
      },
    ],
  };
}

// ── Submission parsing ─────────────────────────────────────────────────────

type ViewStateValue = {
  value?: string | null;
  selected_option?: { value: string } | null;
  selected_options?: { value: string }[];
  selected_date?: string | null;
};

type SubmittedView = {
  private_metadata?: string;
  state?: { values?: Record<string, Record<string, ViewStateValue>> };
};

export type EditSubmission = {
  meta: EditModalMeta;
  patch: Partial<ResolvedTask>;
};

function field(view: SubmittedView, block: string, action: string): ViewStateValue {
  return view.state?.values?.[block]?.[action] ?? {};
}

function dateToMs(date: string | null | undefined, timezone: string): number | null {
  if (!date) return null;
  const dt = DateTime.fromFormat(date, DATE_FMT, { zone: timezone });
  return dt.isValid ? dt.toMillis() : null;
}

/**
 * Parse a view_submission payload into { meta, patch }. The patch carries the
 * corrected title, description (null when blank), clienteOptionId (selected UUID
 * or null), assigneeIds (selected member ids), and start/due epoch-ms at midnight
 * in `timezone` (null when cleared). unresolvedAssignees is cleared to [] — the
 * human has now explicitly chosen the asignados.
 */
export function parseEditSubmission(
  view: SubmittedView,
  opts: { timezone: string },
): EditSubmission {
  const meta = JSON.parse(view.private_metadata ?? "{}") as EditModalMeta;

  const titleRaw = field(view, TITLE_BLOCK, TITLE_ACTION).value ?? "";
  const descRaw = field(view, DESC_BLOCK, DESC_ACTION).value ?? "";
  const cliente = field(view, CLIENTE_BLOCK, CLIENTE_ACTION).selected_option?.value ?? null;
  const asignados = field(view, ASIGNADOS_BLOCK, ASIGNADOS_ACTION).selected_options ?? [];
  const inicio = field(view, INICIO_BLOCK, INICIO_ACTION).selected_date ?? null;
  const entrega = field(view, ENTREGA_BLOCK, ENTREGA_ACTION).selected_date ?? null;

  const patch: Partial<ResolvedTask> = {
    title: titleRaw.trim(),
    description: descRaw.trim() ? descRaw.trim() : null,
    clienteOptionId: cliente,
    assigneeIds: asignados.map((o) => Number(o.value)),
    unresolvedAssignees: [],
    startDateMs: dateToMs(inicio, opts.timezone),
    dueDateMs: dateToMs(entrega, opts.timezone),
  };

  return { meta, patch };
}
