import { describe, it, expect } from "vitest";
import {
  buildEditModal,
  parseEditSubmission,
  EDIT_CALLBACK_ID,
  TITLE_BLOCK,
  TITLE_ACTION,
  DESC_BLOCK,
  DESC_ACTION,
  CLIENTE_BLOCK,
  CLIENTE_ACTION,
  ASIGNADOS_BLOCK,
  ASIGNADOS_ACTION,
  INICIO_BLOCK,
  INICIO_ACTION,
  ENTREGA_BLOCK,
  ENTREGA_ACTION,
} from "./modal.js";
import type { ResolvedTask } from "../resolve/types.js";

const TZ = "America/Caracas";

const resolved: ResolvedTask = {
  title: "Diseñar landing",
  description: "landing de campaña",
  clienteOptionId: "63d9626f-9b80-4a19-8638-93b8042d2e9c", // Felipe Vergara
  assigneeIds: [216158839], // Miguel Pacheco
  unresolvedAssignees: [],
  startDateMs: Date.UTC(2026, 5, 20, 4, 0, 0),
  dueDateMs: Date.UTC(2026, 5, 25, 4, 0, 0),
  links: [],
};

function blocksOf(view: Record<string, unknown>) {
  return view.blocks as Array<Record<string, unknown>>;
}
function elementAt(view: Record<string, unknown>, blockId: string) {
  const block = blocksOf(view).find((b) => b.block_id === blockId)!;
  return block.element as Record<string, unknown>;
}

describe("buildEditModal", () => {
  it("uses the edit callback_id and embeds meta in private_metadata", () => {
    const view = buildEditModal(resolved, {
      pendingId: "PID",
      channel: "C_TASK",
      messageTs: "1700000000.000100",
      timezone: TZ,
    });
    expect(view.callback_id).toBe(EDIT_CALLBACK_ID);
    expect(JSON.parse(view.private_metadata as string)).toEqual({
      pendingId: "PID",
      channel: "C_TASK",
      messageTs: "1700000000.000100",
    });
  });

  it("offers exactly 7 Cliente and 9 Asignados options", () => {
    const view = buildEditModal(resolved, { pendingId: "P", channel: "C", messageTs: "1", timezone: TZ });
    expect((elementAt(view, CLIENTE_BLOCK).options as unknown[]).length).toBe(7);
    expect((elementAt(view, ASIGNADOS_BLOCK).options as unknown[]).length).toBe(9);
  });

  it("prefills title, cliente, asignados and dates from the resolved task", () => {
    const view = buildEditModal(resolved, { pendingId: "P", channel: "C", messageTs: "1", timezone: TZ });
    expect(elementAt(view, TITLE_BLOCK).initial_value).toBe("Diseñar landing");

    const clienteInitial = elementAt(view, CLIENTE_BLOCK).initial_option as { value: string };
    expect(clienteInitial.value).toBe("63d9626f-9b80-4a19-8638-93b8042d2e9c");

    const asignadosInitial = elementAt(view, ASIGNADOS_BLOCK).initial_options as { value: string }[];
    expect(asignadosInitial.map((o) => o.value)).toEqual(["216158839"]);

    expect(elementAt(view, INICIO_BLOCK).initial_date).toBe("2026-06-20");
    expect(elementAt(view, ENTREGA_BLOCK).initial_date).toBe("2026-06-25");
  });

  it("omits initial values for null fields", () => {
    const empty: ResolvedTask = {
      title: "X",
      description: null,
      clienteOptionId: null,
      assigneeIds: [],
      unresolvedAssignees: [],
      startDateMs: null,
      dueDateMs: null,
      links: [],
    };
    const view = buildEditModal(empty, { pendingId: "P", channel: "C", messageTs: "1", timezone: TZ });
    expect(elementAt(view, CLIENTE_BLOCK).initial_option).toBeUndefined();
    expect(elementAt(view, ASIGNADOS_BLOCK).initial_options).toBeUndefined();
    expect(elementAt(view, INICIO_BLOCK).initial_date).toBeUndefined();
    expect(elementAt(view, DESC_BLOCK).initial_value).toBeUndefined();
  });
});

describe("parseEditSubmission", () => {
  function submission(over: {
    title?: string;
    desc?: string;
    cliente?: string | null;
    asignados?: string[];
    inicio?: string | null;
    entrega?: string | null;
  }) {
    return {
      private_metadata: JSON.stringify({ pendingId: "PID", channel: "C_TASK", messageTs: "1700000000.000100" }),
      state: {
        values: {
          [TITLE_BLOCK]: { [TITLE_ACTION]: { value: over.title ?? "Nuevo título" } },
          [DESC_BLOCK]: { [DESC_ACTION]: { value: over.desc ?? "" } },
          [CLIENTE_BLOCK]: {
            [CLIENTE_ACTION]: { selected_option: over.cliente ? { value: over.cliente } : null },
          },
          [ASIGNADOS_BLOCK]: {
            [ASIGNADOS_ACTION]: { selected_options: (over.asignados ?? []).map((v) => ({ value: v })) },
          },
          [INICIO_BLOCK]: { [INICIO_ACTION]: { selected_date: over.inicio ?? null } },
          [ENTREGA_BLOCK]: { [ENTREGA_ACTION]: { selected_date: over.entrega ?? null } },
        },
      },
    };
  }

  it("returns the meta from private_metadata", () => {
    const { meta } = parseEditSubmission(submission({}), { timezone: TZ });
    expect(meta).toEqual({ pendingId: "PID", channel: "C_TASK", messageTs: "1700000000.000100" });
  });

  it("extracts cliente UUID, numeric assignee ids, and epoch-ms dates in the team TZ", () => {
    const { patch } = parseEditSubmission(
      submission({
        title: "Editado",
        desc: "desc nueva",
        cliente: "57123824-86d1-4fb8-a3a3-03fb1a8d8704", // Children Chic
        asignados: ["216158839", "118065209"],
        inicio: "2026-06-20",
        entrega: "2026-06-25",
      }),
      { timezone: TZ },
    );
    expect(patch.title).toBe("Editado");
    expect(patch.description).toBe("desc nueva");
    expect(patch.clienteOptionId).toBe("57123824-86d1-4fb8-a3a3-03fb1a8d8704");
    expect(patch.assigneeIds).toEqual([216158839, 118065209]);
    expect(patch.unresolvedAssignees).toEqual([]);
    // 2026-06-20 midnight in Caracas (UTC-4) = 04:00 UTC.
    expect(patch.startDateMs).toBe(Date.UTC(2026, 5, 20, 4, 0, 0));
    expect(patch.dueDateMs).toBe(Date.UTC(2026, 5, 25, 4, 0, 0));
  });

  it("maps a blank description to null and a cleared date to null", () => {
    const { patch } = parseEditSubmission(
      submission({ desc: "   ", cliente: null, inicio: null, entrega: null }),
      { timezone: TZ },
    );
    expect(patch.description).toBeNull();
    expect(patch.clienteOptionId).toBeNull();
    expect(patch.startDateMs).toBeNull();
    expect(patch.dueDateMs).toBeNull();
  });
});
