// Standalone HITL approval expiry — deadline enforcement + periodic sweep.
//
// Covers the two halves of the fix:
//   1. The `expiresAt` guard inside `resolveApprovalRequest`'s CAS, so a response
//      arriving after the deadline can never produce approved/rejected.
//   2. `sweepExpiredApprovalRequests`, which drives expired STANDALONE requests to
//      the terminal `timeout` status. Workflow-linked requests stay untouched —
//      their expiry is owned by src/workflows/recovery.ts.
//
// The respond route is exercised through the real production pipeline
// (handleCore auth → handleApprovalRequests), pattern borrowed from
// rbac-charact-http.test.ts.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { finalizeApprovalRequest, sweepExpiredApprovalRequests } from "../be/approval-lifecycle";
import {
  type ApprovalRequest,
  closeDb,
  createAgent,
  createApprovalRequest,
  createTaskExtended,
  getApprovalRequestById,
  getDb,
  getExpiredPendingApprovals,
  initDb,
  resolveApprovalRequest,
} from "../be/db";
import { handleApprovalRequests } from "../http/approval-requests";
import { handleCore } from "../http/core";
import { getPathSegments, parseQueryParams } from "../http/utils";
// Registers `hitl.follow_up` / `hitl.timeout` in the prompt-template registry.
import "../tools/templates";

const TEST_DB_PATH = "./test-approval-expiry.sqlite";
const API_KEY = "test-approval-expiry-key";

let server: Server;
let port: number;
let agentId: string;

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function createPipelineServer(apiKey: string): Server {
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const myAgentId = req.headers["x-agent-id"] as string | undefined;
    const handled = await handleCore(req, res, myAgentId, apiKey);
    if (handled) return;
    const pathSegments = getPathSegments(req.url || "");
    const queryParams = parseQueryParams(req.url || "");
    const ok = await handleApprovalRequests(req, res, pathSegments, queryParams);
    if (!ok) {
      res.writeHead(404);
      res.end("Not Found");
    }
  });
}

async function respond(
  id: string,
  responses: Record<string, unknown>,
): Promise<{ status: number; body: { approvalRequest?: ApprovalRequest; error?: string } }> {
  const res = await fetch(`http://localhost:${port}/api/approval-requests/${id}/respond`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({ responses, respondedBy: "user-1" }),
  });
  return { status: res.status, body: (await res.json()) as never };
}

/** Creates a standalone request, then back-dates `expiresAt` when `expired`. */
function makeStandaloneRequest(opts?: {
  expired?: boolean;
  sourceTaskId?: string;
}): ApprovalRequest {
  const request = createApprovalRequest({
    id: crypto.randomUUID(),
    title: "Approve deployment",
    questions: [{ id: "q1", type: "approval", label: "Approve?", required: true }],
    approvers: { policy: "any" },
    sourceTaskId: opts?.sourceTaskId,
    timeoutSeconds: 3600,
  });
  if (opts?.expired) backdateExpiry(request.id);
  return getApprovalRequestById(request.id)!;
}

function backdateExpiry(id: string): void {
  getDb()
    .prepare("UPDATE approval_requests SET expiresAt = ? WHERE id = ?")
    .run("2000-01-01T00:00:00.000Z", id);
}

function countFollowUps(parentTaskId: string): number {
  const row = getDb()
    .prepare<{ n: number }, [string]>(
      "SELECT COUNT(*) as n FROM agent_tasks WHERE parentTaskId = ? AND taskType = 'hitl-follow-up'",
    )
    .get(parentTaskId);
  return row?.n ?? 0;
}

function makeSourceTask(): string {
  return createTaskExtended("original task", { agentId, source: "mcp" }).id;
}

beforeAll(async () => {
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
  agentId = createAgent({ name: "approval-expiry-agent", isLead: false, status: "idle" }).id;
  server = createPipelineServer(API_KEY);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  port = addr.port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
});

describe("standalone approval expiry", () => {
  test("response before the deadline is accepted", async () => {
    const sourceTaskId = makeSourceTask();
    const request = makeStandaloneRequest({ sourceTaskId });

    const res = await respond(request.id, { q1: { approved: true } });

    expect(res.status).toBe(200);
    expect(res.body.approvalRequest?.status).toBe("approved");
    expect(getApprovalRequestById(request.id)!.status).toBe("approved");
    expect(getApprovalRequestById(request.id)!.resolvedBy).toBe("user-1");
    expect(countFollowUps(sourceTaskId)).toBe(1);
  });

  test("response after the deadline is refused and the request ends in timeout", async () => {
    const sourceTaskId = makeSourceTask();
    const request = makeStandaloneRequest({ expired: true, sourceTaskId });

    const res = await respond(request.id, { q1: { approved: true } });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("expired");

    const after = getApprovalRequestById(request.id)!;
    expect(after.status).toBe("timeout");
    // The late answer must not be recorded as the resolution.
    expect(after.responses).toBeNull();
    expect(after.resolvedBy).toBeNull();
    // Exactly one effect: the timeout follow-up, never an "approved" one too.
    expect(countFollowUps(sourceTaskId)).toBe(1);
  });

  test("the CAS itself rejects a post-deadline approve/reject", () => {
    const expired = makeStandaloneRequest({ expired: true });

    expect(resolveApprovalRequest(expired.id, { status: "approved" })).toBeNull();
    expect(resolveApprovalRequest(expired.id, { status: "rejected" })).toBeNull();
    expect(getApprovalRequestById(expired.id)!.status).toBe("pending");

    // `timeout` is the transition the deadline authorizes — it must still pass.
    expect(resolveApprovalRequest(expired.id, { status: "timeout" })).not.toBeNull();
    expect(getApprovalRequestById(expired.id)!.status).toBe("timeout");
  });

  test("sweep is idempotent: two passes produce one transition", () => {
    const sourceTaskId = makeSourceTask();
    const request = makeStandaloneRequest({ expired: true, sourceTaskId });

    const firstPass = sweepExpiredApprovalRequests();
    const swept = getApprovalRequestById(request.id)!;
    expect(firstPass).toBeGreaterThanOrEqual(1);
    expect(swept.status).toBe("timeout");
    expect(countFollowUps(sourceTaskId)).toBe(1);

    const secondPass = sweepExpiredApprovalRequests();
    expect(secondPass).toBe(0);
    // Same terminal row, untouched — and no second follow-up task.
    expect(getApprovalRequestById(request.id)!.resolvedAt).toBe(swept.resolvedAt);
    expect(countFollowUps(sourceTaskId)).toBe(1);
  });

  test("response racing the sweep yields exactly one terminal transition", () => {
    const sourceTaskId = makeSourceTask();
    const request = makeStandaloneRequest({ expired: true, sourceTaskId });

    // Every contender for the terminal transition, interleaved: the responder's
    // forced timeout (respond route), the sweep, and a late approve.
    const attempts = [
      () => finalizeApprovalRequest(request.id, { status: "timeout" }),
      () => finalizeApprovalRequest(request.id, { status: "approved", resolvedBy: "user-1" }),
      () => finalizeApprovalRequest(request.id, { status: "timeout" }),
      () => finalizeApprovalRequest(request.id, { status: "rejected" }),
    ];
    const winners = attempts.map((attempt) => attempt()).filter((result) => result.ok);

    expect(winners).toHaveLength(1);
    expect(getApprovalRequestById(request.id)!.status).toBe("timeout");
    expect(countFollowUps(sourceTaskId)).toBe(1);
    // A second sweep pass after the race is still a no-op.
    expect(sweepExpiredApprovalRequests()).toBe(0);
  });

  test("workflow-linked approvals are left to the workflow engine", () => {
    const workflowRunId = crypto.randomUUID();
    const workflowRunStepId = crypto.randomUUID();
    const request = createApprovalRequest({
      id: crypto.randomUUID(),
      title: "Workflow approval",
      questions: [{ id: "q1", type: "approval", label: "Approve?", required: true }],
      approvers: { policy: "any" },
      workflowRunId,
      workflowRunStepId,
      timeoutSeconds: 3600,
    });
    backdateExpiry(request.id);

    // Visible to the unfiltered query (what recovery.ts-adjacent callers see)
    // but excluded from the standalone sweep's input.
    expect(getExpiredPendingApprovals().some((r) => r.id === request.id)).toBe(true);
    expect(
      getExpiredPendingApprovals({ standaloneOnly: true }).some((r) => r.id === request.id),
    ).toBe(false);

    sweepExpiredApprovalRequests();
    expect(getApprovalRequestById(request.id)!.status).toBe("pending");

    // src/workflows/recovery.ts auto-timeouts it and resumes the run on the
    // `timeout` port — that transition must still be allowed post-deadline.
    expect(resolveApprovalRequest(request.id, { status: "timeout" })).not.toBeNull();
    expect(getApprovalRequestById(request.id)!.status).toBe("timeout");
  });
});
