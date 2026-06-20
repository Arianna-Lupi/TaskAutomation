import { describe, it, expect } from "vitest";
import {
  buildPreviewBlocks,
  buildConfirmedBlocks,
  buildCanceledBlocks,
  CONFIRM_ACTION_ID,
  EDIT_ACTION_ID,
  CANCEL_ACTION_ID,
  type Block,
} from "./blocks.js";
import type { ResolvedTask } from "../resolve/types.js";

const TZ = "America/Caracas";

const resolved: ResolvedTask = {
  title: "Diseñar landing",
  description: "landing de campaña",
  clienteOptionId: "63d9626f-9b80-4a19-8638-93b8042d2e9c", // Felipe Vergara
  assigneeIds: [216158839, 118065209], // Miguel Pacheco, Veronica Romero
  unresolvedAssignees: [],
  startDateMs: Date.UTC(2026, 5, 20, 4, 0, 0), // ~ jun 20 2026 in Caracas
  dueDateMs: Date.UTC(2026, 5, 25, 4, 0, 0),
  links: ["https://loom.com/x"],
};

function buttons(blocks: Block[]): Array<Record<string, unknown>> {
  const actions = blocks.find((b) => b.type === "actions");
  return (actions?.elements as Array<Record<string, unknown>>) ?? [];
}

function flatText(blocks: Block[]): string {
  return JSON.stringify(blocks);
}

describe("buildPreviewBlocks", () => {
  it("renders resolved cliente + member names + formatted dates with no ⚠️", () => {
    const blocks = buildPreviewBlocks("P1", resolved, { timezone: TZ });
    const text = flatText(blocks);
    expect(text).toContain("Felipe Vergara");
    expect(text).toContain("Miguel Pacheco");
    expect(text).toContain("Veronica Romero");
    expect(text).toContain("Diseñar landing");
    expect(text).toContain("https://loom.com/x");
    expect(text).not.toContain("sin resolver");
    // A formatted Spanish date for June 2026.
    expect(text).toMatch(/jun 2026/);
  });

  it("flags unresolved cliente, asignados, and dates with ⚠️", () => {
    const unresolved: ResolvedTask = {
      title: "Tarea X",
      description: null,
      clienteOptionId: null,
      assigneeIds: [],
      unresolvedAssignees: ["Vero R."],
      startDateMs: null,
      dueDateMs: null,
      links: [],
    };
    const blocks = buildPreviewBlocks("P2", unresolved, { timezone: TZ });
    const text = flatText(blocks);
    // Cliente + dates show "sin resolver"; asignado shows the flagged raw name.
    expect((text.match(/sin resolver/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(text).toContain("⚠️ Vero R.");
  });

  it("escapes mrkdwn control chars in untrusted fields (no live ping/spoof)", () => {
    const crafted: ResolvedTask = {
      title: "<!channel>",
      description: "ping <@U123> & escape",
      clienteOptionId: null,
      assigneeIds: [],
      unresolvedAssignees: ["<!here>"],
      startDateMs: null,
      dueDateMs: null,
      links: ["https://x.com/<a>"],
    };
    const blocks = buildPreviewBlocks("P3", crafted, { timezone: TZ });
    const text = flatText(blocks);
    // Title escaped — no live <!channel>.
    expect(text).toContain("&lt;!channel&gt;");
    expect(text).not.toContain("<!channel>");
    // Description escaped (both <@U123> and &).
    expect(text).toContain("&lt;@U123&gt;");
    expect(text).toContain("&amp; escape");
    // Link escaped.
    expect(text).toContain("https://x.com/&lt;a&gt;");
    // Unresolved assignee escaped but the ⚠️ marker preserved.
    expect(text).toContain("⚠️ &lt;!here&gt;");
    // Static Spanish labels remain intact.
    expect(text).toContain("*Título:*");
    expect(text).toContain("*Cliente:*");
  });

  it("has Confirmar/Editar/Cancelar buttons with correct ids, styles and value=pendingId", () => {
    const blocks = buildPreviewBlocks("PID", resolved, { timezone: TZ });
    const els = buttons(blocks);
    expect(els).toHaveLength(3);

    const confirm = els.find((e) => e.action_id === CONFIRM_ACTION_ID)!;
    const edit = els.find((e) => e.action_id === EDIT_ACTION_ID)!;
    const cancel = els.find((e) => e.action_id === CANCEL_ACTION_ID)!;

    expect(confirm.style).toBe("primary");
    expect(confirm.value).toBe("PID");
    expect(edit.value).toBe("PID");
    expect(cancel.style).toBe("danger");
    expect(cancel.value).toBe("PID");
  });
});

describe("terminal blocks", () => {
  it("buildConfirmedBlocks shows the link and has no buttons", () => {
    const blocks = buildConfirmedBlocks("https://app.clickup.com/t/abc");
    expect(flatText(blocks)).toContain("https://app.clickup.com/t/abc");
    expect(buttons(blocks)).toHaveLength(0);
    expect(blocks.some((b) => b.type === "actions")).toBe(false);
  });

  it("buildCanceledBlocks has no buttons", () => {
    const blocks = buildCanceledBlocks();
    expect(blocks.some((b) => b.type === "actions")).toBe(false);
    expect(flatText(blocks)).toContain("Cancelada");
  });
});
