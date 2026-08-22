/**
 * Approval-request terminal transitions and the expired-request sweep.
 *
 * Deliberately NOT in src/http/approval-requests.ts: the wait poller
 * (src/workflows/wait-poller.ts) drives the sweep, and importing the route
 * module from there would pull route registration into the poller's import
 * chain — which reorders every path in the generated openapi.json.
 */

import { resolveTemplate } from "../prompts/resolver";
import { workflowEventBus } from "../workflows/event-bus";
import {
  type ApprovalRequest,
  createTaskExtended,
  getApprovalRequestById,
  getExpiredPendingApprovals,
  getTaskById,
  resolveApprovalRequest,
} from "./db";

export type ApprovalFinalizeResult =
  | { ok: true; request: ApprovalRequest }
  | { ok: false; currentStatus: string; expiredWhilePending: boolean };

function isPastDeadline(request: ApprovalRequest): boolean {
  return request.expiresAt !== null && Date.parse(request.expiresAt) <= Date.now();
}

/**
 * Move an approval request to a terminal status and fire its side effects.
 *
 * The transition itself is `resolveApprovalRequest`'s single atomic UPDATE
 * (`status = 'pending'` + the `expiresAt` guard), so concurrent callers — a late
 * responder and the expiry sweep — can never both win. Only the caller whose CAS
 * returned a row runs the effects below, which is what keeps "one terminal
 * transition, one effect" true under a race.
 */
export function finalizeApprovalRequest(
  id: string,
  data: {
    status: "approved" | "rejected" | "timeout";
    responses?: Record<string, unknown>;
    resolvedBy?: string;
  },
): ApprovalFinalizeResult {
  const updated = resolveApprovalRequest(id, data);
  if (!updated) {
    const current = getApprovalRequestById(id);
    return {
      ok: false,
      currentStatus: current?.status ?? "unknown",
      // Still pending but past its deadline → the CAS's expiry guard rejected it,
      // not a concurrent resolution.
      expiredWhilePending:
        current !== null && current.status === "pending" && isPastDeadline(current),
    };
  }

  // Emit event for workflow resume
  if (updated.workflowRunId && updated.workflowRunStepId) {
    workflowEventBus.emit("approval.resolved", {
      requestId: updated.id,
      status: updated.status,
      responses: updated.responses,
      workflowRunId: updated.workflowRunId,
      workflowRunStepId: updated.workflowRunStepId,
    });
  }

  // For standalone (non-workflow) requests, create a follow-up task
  // so the requesting agent is notified of the outcome
  if (!updated.workflowRunId && updated.sourceTaskId) {
    createStandaloneFollowUpTask(updated, updated.sourceTaskId);
  }

  return { ok: true, request: updated };
}

function createStandaloneFollowUpTask(updated: ApprovalRequest, sourceTaskId: string): void {
  const sourceTask = getTaskById(sourceTaskId);
  if (!sourceTask) return;

  const { text: taskText } =
    updated.status === "timeout"
      ? resolveTemplate("hitl.timeout", {
          request_id: updated.id,
          title: updated.title,
          expires_at: updated.expiresAt ?? "",
        })
      : resolveTemplate("hitl.follow_up", {
          request_id: updated.id,
          title: updated.title,
          status: updated.status,
          responses: formatResponses(
            updated.questions as Array<{ id: string; type: string; label: string }>,
            updated.responses as Record<string, unknown>,
          ),
        });

  createTaskExtended(taskText, {
    agentId: sourceTask.agentId,
    parentTaskId: sourceTaskId,
    source: "system",
    taskType: "hitl-follow-up",
    tags: ["hitl", "follow-up"],
    // Explicit Slack metadata — parentTaskId auto-inherits too,
    // but being explicit ensures the follow-up task always gets
    // the right thread context even if inheritance logic changes.
    slackChannelId: sourceTask.slackChannelId ?? undefined,
    slackThreadTs: sourceTask.slackThreadTs ?? undefined,
    slackUserId: sourceTask.slackUserId ?? undefined,
  });
}

/**
 * Sweep standalone approval requests past their `expiresAt` into `timeout`.
 *
 * Idempotent: the terminal transition is the CAS in `finalizeApprovalRequest`,
 * so a row already swept (or resolved in the meantime) is skipped and a second
 * pass is a no-op. Workflow-linked requests are deliberately excluded — the
 * workflow engine owns their expiry so the run resumes on its `timeout` port.
 *
 * Returns the number of requests this pass actually timed out.
 */
export function sweepExpiredApprovalRequests(): number {
  let sweptCount = 0;
  for (const expired of getExpiredPendingApprovals({ standaloneOnly: true })) {
    try {
      if (finalizeApprovalRequest(expired.id, { status: "timeout" }).ok) sweptCount++;
    } catch (err) {
      console.error(`[approvals] Failed to expire approval request ${expired.id}:`, err);
    }
  }
  return sweptCount;
}

function formatResponses(
  questions: Array<{ id: string; type: string; label: string }>,
  responses: Record<string, unknown>,
): string {
  return questions
    .map((q) => {
      const answer = responses[q.id];
      let answerText: string;
      if (answer == null) {
        answerText = "(no answer)";
      } else if (q.type === "approval") {
        const a = answer as { approved?: boolean; comment?: string };
        answerText = a.approved ? "Approved" : "Rejected";
        if (a.comment) answerText += ` — ${a.comment}`;
      } else if (typeof answer === "object") {
        answerText = JSON.stringify(answer);
      } else {
        answerText = String(answer);
      }
      return `- ${q.label}: ${answerText}`;
    })
    .join("\n");
}
