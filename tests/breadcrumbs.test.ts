import { describe, it, expect } from "vitest";
import { BreadcrumbBuffer } from "../src/breadcrumbs";

describe("BreadcrumbBuffer", () => {
  it("starts empty", () => {
    const b = new BreadcrumbBuffer();
    expect(b.size).toBe(0);
    expect(b.snapshot()).toEqual([]);
  });

  it("add() appends crumbs in order", () => {
    const b = new BreadcrumbBuffer();
    b.add({ timestamp: 1, category: "custom", message: "a" });
    b.add({ timestamp: 2, category: "custom", message: "b" });
    expect(b.snapshot().map((c) => c.message)).toEqual(["a", "b"]);
  });

  it("evicts oldest when buffer exceeds maxSize", () => {
    const b = new BreadcrumbBuffer(3);
    b.add({ timestamp: 1, category: "custom", message: "a" });
    b.add({ timestamp: 2, category: "custom", message: "b" });
    b.add({ timestamp: 3, category: "custom", message: "c" });
    b.add({ timestamp: 4, category: "custom", message: "d" });
    expect(b.snapshot().map((c) => c.message)).toEqual(["b", "c", "d"]);
  });

  it("snapshot() returns a defensive copy", () => {
    const b = new BreadcrumbBuffer();
    b.add({ timestamp: 1, category: "custom", message: "a" });
    const snap = b.snapshot();
    snap.push({ timestamp: 99, category: "custom", message: "external mutation" });
    expect(b.size).toBe(1);
  });

  it("clear() wipes the buffer", () => {
    const b = new BreadcrumbBuffer();
    b.add({ timestamp: 1, category: "custom", message: "a" });
    b.clear();
    expect(b.size).toBe(0);
  });

  it("default maxSize is 50", () => {
    const b = new BreadcrumbBuffer();
    for (let i = 0; i < 75; i++) {
      b.add({ timestamp: i, category: "custom", message: String(i) });
    }
    expect(b.size).toBe(50);
    // Oldest evicted, newest preserved.
    expect(b.snapshot()[0]!.message).toBe("25");
    expect(b.snapshot()[49]!.message).toBe("74");
  });
});
