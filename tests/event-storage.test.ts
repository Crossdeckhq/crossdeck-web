import { describe, it, expect, beforeEach } from "vitest";
import { PersistentEventStore } from "../src/event-storage";
import { MemoryStorage } from "../src/storage";
import type { QueuedEvent } from "../src/event-queue";

function evt(name: string): QueuedEvent {
  return {
    eventId: `evt_${name}_${Math.random().toString(36).slice(2)}`,
    name,
    timestamp: Date.now(),
    properties: {},
    anonymousId: "anon_test",
  };
}

describe("PersistentEventStore", () => {
  let storage: MemoryStorage;
  beforeEach(() => {
    storage = new MemoryStorage();
  });

  it("load() returns empty array when nothing stored", () => {
    const s = new PersistentEventStore({ storage, prefix: "cd:" });
    expect(s.load()).toEqual([]);
  });

  it("saveSync + load round-trips a batch", () => {
    const s = new PersistentEventStore({ storage, prefix: "cd:" });
    const batch = [evt("a"), evt("b"), evt("c")];
    s.saveSync(batch);
    const loaded = new PersistentEventStore({ storage, prefix: "cd:" }).load();
    expect(loaded.length).toBe(3);
    expect(loaded[0]!.name).toBe("a");
  });

  it("save() debounces but eventually persists (microtask)", async () => {
    const s = new PersistentEventStore({ storage, prefix: "cd:" });
    s.save([evt("a")]);
    s.save([evt("a"), evt("b")]);
    s.save([evt("a"), evt("b"), evt("c")]);
    // Nothing written yet — still queued in microtask.
    await Promise.resolve();
    const loaded = new PersistentEventStore({ storage, prefix: "cd:" }).load();
    expect(loaded.length).toBe(3);
  });

  it("clear() removes the persisted blob", () => {
    const s = new PersistentEventStore({ storage, prefix: "cd:" });
    s.saveSync([evt("a")]);
    s.clear();
    expect(new PersistentEventStore({ storage, prefix: "cd:" }).load()).toEqual([]);
  });

  it("saving an empty array clears the entry (not 'empty array' blob)", () => {
    const s = new PersistentEventStore({ storage, prefix: "cd:" });
    s.saveSync([evt("a")]);
    s.saveSync([]);
    expect(storage.getItem("cd:queue.v1")).toBeNull();
  });

  it("malformed stored blob loads as empty (no throw)", () => {
    storage.setItem("cd:queue.v1", "not json{{");
    const loaded = new PersistentEventStore({ storage, prefix: "cd:" }).load();
    expect(loaded).toEqual([]);
  });

  it("wrong version stored blob loads as empty", () => {
    storage.setItem(
      "cd:queue.v1",
      JSON.stringify({ version: 999, events: [evt("a")] }),
    );
    expect(new PersistentEventStore({ storage, prefix: "cd:" }).load()).toEqual([]);
  });

  it("throwing storage doesn't crash save() or load()", () => {
    const broken = {
      getItem() {
        throw new Error("quota exceeded");
      },
      setItem() {
        throw new Error("quota exceeded");
      },
      removeItem() {
        throw new Error("quota exceeded");
      },
    };
    const s = new PersistentEventStore({ storage: broken, prefix: "cd:" });
    expect(s.load()).toEqual([]);
    expect(() => s.saveSync([evt("a")])).not.toThrow();
    expect(() => s.clear()).not.toThrow();
  });
});
