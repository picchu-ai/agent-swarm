import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  getAllTasks,
  getTaskContextKeyGroups,
  getTasksCount,
  initDb,
} from "../be/db";

const TEST_DB_PATH = "./test-task-context-key-filter.sqlite";

async function removeDb() {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
}

describe("contextKey task filter and grouping", () => {
  let agentId: string;

  beforeAll(async () => {
    await removeDb();
    initDb(TEST_DB_PATH);
    agentId = createAgent({
      id: "context-key-agent",
      name: "Context Key Agent",
      isLead: false,
      status: "idle",
    }).id;

    // Two keys with different cardinality, plus rows carrying no key at all —
    // the "No project" bucket the dashboard rail renders separately.
    for (const task of ["rail row one", "rail row two", "rail row three"]) {
      createTaskExtended(task, { agentId, contextKey: "project/dashboard-ui" });
    }
    createTaskExtended("billing row", { agentId, contextKey: "project/billing" });
    createTaskExtended("unfiled one", { agentId });
    createTaskExtended("unfiled two", { agentId });
  });

  afterAll(async () => {
    closeDb();
    await removeDb();
  });

  test("filters tasks down to one exact context key", () => {
    const rows = getAllTasks({ contextKey: "project/dashboard-ui" });
    expect(rows).toHaveLength(3);
    expect(rows.every((t) => t.contextKey === "project/dashboard-ui")).toBe(true);
    expect(getTasksCount({ contextKey: "project/dashboard-ui" })).toBe(3);
  });

  test("contextKeyIsNull selects only tasks with no context key", () => {
    const rows = getAllTasks({ contextKeyIsNull: true });
    expect(rows).toHaveLength(2);
    expect(rows.every((t) => t.contextKey === undefined)).toBe(true);
    expect(getTasksCount({ contextKeyIsNull: true })).toBe(2);
  });

  test("contextKeyIsNull wins over a concrete contextKey", () => {
    // Both set: the IS NULL branch is documented to take priority, so this must
    // not silently AND the two into an always-empty result.
    const rows = getAllTasks({ contextKey: "project/billing", contextKeyIsNull: true });
    expect(rows).toHaveLength(2);
    expect(rows.every((t) => t.contextKey === undefined)).toBe(true);
  });

  test("an unknown context key matches nothing", () => {
    expect(getAllTasks({ contextKey: "project/does-not-exist" })).toHaveLength(0);
    expect(getTasksCount({ contextKey: "project/does-not-exist" })).toBe(0);
  });

  test("groups every key with counts, newest activity first, excluding NULLs", () => {
    const groups = getTaskContextKeyGroups();
    expect(groups.map((g) => g.contextKey).sort()).toEqual([
      "project/billing",
      "project/dashboard-ui",
    ]);

    const byKey = new Map(groups.map((g) => [g.contextKey, g]));
    expect(byKey.get("project/dashboard-ui")?.taskCount).toBe(3);
    expect(byKey.get("project/billing")?.taskCount).toBe(1);
    for (const group of groups) expect(group.lastActivityAt).toBeTruthy();

    // Ordering contract the rail depends on: most recently active first.
    const times = groups.map((g) => Date.parse(g.lastActivityAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  test("group counts agree with the filtered list they link to", () => {
    for (const group of getTaskContextKeyGroups()) {
      expect(getTasksCount({ contextKey: group.contextKey })).toBe(group.taskCount);
    }
  });
});
