import { describe, it, expect } from "vitest";
import { ParsedTaskSchema, type ParsedTaskFromSchema } from "./schema.js";
import type { ParsedTask } from "../resolve/types.js";

describe("ParsedTaskSchema", () => {
  it("parses a fully-populated object", () => {
    const obj = {
      title: "Diseñar banner",
      description: "Para la campaña",
      clienteRaw: "FHCA",
      assigneesRaw: ["vero", "miguel"],
      startDatePhrase: "hoy",
      dueDatePhrase: "viernes",
      links: ["https://loom.com/x"],
    };
    expect(ParsedTaskSchema.parse(obj)).toEqual(obj);
  });

  it("parses a minimal object (nulls + empty arrays)", () => {
    const obj = {
      title: "Algo",
      description: null,
      clienteRaw: null,
      assigneesRaw: [],
      startDatePhrase: null,
      dueDatePhrase: null,
      links: [],
    };
    expect(ParsedTaskSchema.parse(obj)).toEqual(obj);
  });

  it("rejects a schema-violating object", () => {
    expect(() => ParsedTaskSchema.parse({ title: 123 })).toThrow();
  });

  it("the inferred type is assignable to the shared ParsedTask contract", () => {
    const fromSchema: ParsedTaskFromSchema = {
      title: "t",
      description: null,
      clienteRaw: null,
      assigneesRaw: [],
      startDatePhrase: null,
      dueDatePhrase: null,
      links: [],
    };
    const asContract: ParsedTask = fromSchema; // compile-time check
    expect(asContract.title).toBe("t");
  });
});
