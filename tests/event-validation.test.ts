import { describe, it, expect } from "vitest";
import { validateEventProperties } from "../src/event-validation";

describe("validateEventProperties — primitives", () => {
  it("returns empty bag for undefined input", () => {
    const out = validateEventProperties(undefined);
    expect(out.properties).toEqual({});
    expect(out.warnings).toEqual([]);
  });

  it("passes strings / numbers / booleans / null through", () => {
    const out = validateEventProperties({
      s: "hello",
      n: 42,
      f: 1.5,
      b: true,
      z: null,
    });
    expect(out.properties).toEqual({ s: "hello", n: 42, f: 1.5, b: true, z: null });
    expect(out.warnings).toEqual([]);
  });

  it("drops functions with a warning", () => {
    const out = validateEventProperties({ onClick: () => 0, name: "kept" });
    expect(out.properties).toEqual({ name: "kept" });
    expect(out.warnings).toContainEqual({ kind: "dropped_function", key: "onClick" });
  });

  it("drops symbols", () => {
    const out = validateEventProperties({ s: Symbol("x"), a: 1 });
    expect(out.properties).toEqual({ a: 1 });
    expect(out.warnings).toContainEqual({ kind: "dropped_symbol", key: "s" });
  });

  it("drops undefined values", () => {
    const out = validateEventProperties({ a: undefined, b: 1 });
    expect(out.properties).toEqual({ b: 1 });
    expect(out.warnings).toContainEqual({ kind: "dropped_undefined", key: "a" });
  });

  it("coerces NaN / Infinity to null", () => {
    const out = validateEventProperties({ a: NaN, b: Infinity });
    expect(out.properties).toEqual({ a: null, b: null });
    expect(out.warnings.filter((w) => w.kind === "non_serialisable")).toHaveLength(2);
  });
});

describe("validateEventProperties — coercions", () => {
  it("coerces Date → ISO string", () => {
    const d = new Date("2026-05-11T08:00:00.000Z");
    const out = validateEventProperties({ when: d });
    expect(out.properties.when).toBe("2026-05-11T08:00:00.000Z");
    expect(out.warnings).toContainEqual({ kind: "coerced_date", key: "when" });
  });

  it("coerces invalid Date → null", () => {
    const out = validateEventProperties({ when: new Date("not a date") });
    expect(out.properties.when).toBeNull();
  });

  it("coerces BigInt → string", () => {
    const out = validateEventProperties({ big: 9007199254740993n });
    expect(out.properties.big).toBe("9007199254740993");
    expect(out.warnings).toContainEqual({ kind: "coerced_bigint", key: "big" });
  });

  it("coerces Error → { name, message, stack }", () => {
    const e = new Error("boom");
    const out = validateEventProperties({ err: e });
    expect(out.properties.err).toMatchObject({ name: "Error", message: "boom" });
    expect(out.warnings).toContainEqual({ kind: "coerced_error", key: "err" });
  });

  it("coerces Map → plain object", () => {
    const m = new Map([
      ["a", 1],
      ["b", 2],
    ]);
    const out = validateEventProperties({ m });
    expect(out.properties.m).toEqual({ a: 1, b: 2 });
  });

  it("coerces Set → array", () => {
    const s = new Set([1, 2, 3]);
    const out = validateEventProperties({ s });
    expect(out.properties.s).toEqual([1, 2, 3]);
  });
});

describe("validateEventProperties — truncation + safety", () => {
  it("truncates strings over maxStringLength with an ellipsis", () => {
    const long = "x".repeat(2000);
    const out = validateEventProperties({ blob: long }, { maxStringLength: 50 });
    expect((out.properties.blob as string).length).toBe(50);
    expect((out.properties.blob as string).endsWith("…")).toBe(true);
    expect(out.warnings).toContainEqual({ kind: "truncated_string", key: "blob" });
  });

  it("replaces circular object refs with '[circular]'", () => {
    const obj: Record<string, unknown> = { name: "ref" };
    obj.self = obj;
    const out = validateEventProperties({ outer: obj });
    // The outer reference is replaced.
    expect((out.properties.outer as { self: unknown }).self).toBe("[circular]");
    expect(out.warnings.some((w) => w.kind === "circular_reference")).toBe(true);
  });

  it("replaces circular array refs with '[circular]'", () => {
    const a: unknown[] = [1, 2];
    a.push(a);
    const out = validateEventProperties({ arr: a });
    expect(out.properties.arr).toEqual([1, 2, "[circular]"]);
  });

  it("does NOT flag a legitimate DAG — sibling sharing is fine (P1 #18 regression)", () => {
    // Pre-fix the validator used a shared WeakSet `seen` that added on
    // visit but never removed. Two sibling properties pointing at the
    // SAME sub-object would have the second visit (under the second
    // sibling) trip the [circular] branch and silently lose data with
    // a misleading warning. New impl uses an ancestor-only stack
    // (add on entry, delete on exit), so DAG sibling sharing passes
    // through verbatim and only true cycles flag.
    const shared = { email: "wes@pinet.co.za", plan: "pro" };
    const out = validateEventProperties({ owner: shared, member: shared });
    expect(out.properties.owner).toEqual({ email: "wes@pinet.co.za", plan: "pro" });
    expect(out.properties.member).toEqual({ email: "wes@pinet.co.za", plan: "pro" });
    expect(out.warnings.some((w) => w.kind === "circular_reference")).toBe(false);
  });

  it("does NOT flag a legitimate DAG across arrays (P1 #18 regression)", () => {
    const shared = { id: 42 };
    const out = validateEventProperties({ team: [shared, shared, { id: 7 }] });
    expect(out.properties.team).toEqual([{ id: 42 }, { id: 42 }, { id: 7 }]);
    expect(out.warnings.some((w) => w.kind === "circular_reference")).toBe(false);
  });

  it("caps deep nesting with '[depth-exceeded]'", () => {
    // 7 levels nested; default maxDepth=5.
    let leaf: unknown = "deep";
    for (let i = 0; i < 7; i++) leaf = { next: leaf };
    const out = validateEventProperties({ root: leaf });
    const json = JSON.stringify(out.properties);
    expect(json).toContain("[depth-exceeded]");
    expect(out.warnings.some((w) => w.kind === "depth_exceeded")).toBe(true);
  });

  it("drops largest property when total exceeds byte cap", () => {
    const out = validateEventProperties(
      {
        tiny: "ok",
        huge: "x".repeat(900),
      },
      { maxBatchPropertyBytes: 200, maxStringLength: 10_000 },
    );
    // huge dropped, tiny + marker remain
    expect(out.properties.tiny).toBe("ok");
    expect(out.properties.huge).toBeUndefined();
    expect(out.properties.__truncated).toBe(true);
    expect(out.warnings.some((w) => w.kind === "size_cap_exceeded")).toBe(true);
  });

  it("output of a mixed bag round-trips through JSON.stringify", () => {
    // Build an input that would otherwise crash JSON.stringify
    // (BigInt and an actual circular ref).
    const cycleObj: Record<string, unknown> = { name: "ref" };
    cycleObj.self = cycleObj;
    const out = validateEventProperties({
      fn: () => 0,
      sym: Symbol("x"),
      big: 1n,
      err: new Error("e"),
      d: new Date(),
      cycle: cycleObj,
    });
    // After validation the structure must be safe to stringify.
    expect(() => JSON.stringify(out.properties)).not.toThrow();
  });

  it("does NOT mutate the caller's input object", () => {
    const input = {
      arr: [1, 2, 3],
      nested: { keep: true },
      bad: () => 0,
    };
    const before = JSON.stringify({ arr: input.arr, nested: input.nested, hasBad: typeof input.bad });
    validateEventProperties(input);
    const after = JSON.stringify({ arr: input.arr, nested: input.nested, hasBad: typeof input.bad });
    expect(after).toBe(before);
  });
});
