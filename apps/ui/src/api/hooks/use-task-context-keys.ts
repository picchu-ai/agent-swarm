import { useQuery } from "@tanstack/react-query";
import { api } from "../client";

export interface TaskContextKeysOptions {
  /** Mirror the task list's flag so rail counts match the list they link to. */
  includeHeartbeat?: boolean;
  /** Skip the query entirely — used to gate it behind an API-version check. */
  enabled?: boolean;
}

/**
 * Distinct `contextKey` groups across every task, newest activity first.
 *
 * Polls on a slower cadence than the 5s list default: the set of projects moves
 * on the timescale of new conversations, not new task rows, and this hook is
 * mounted by the always-visible sidebar on every route.
 */
export function useTaskContextKeys(opts?: TaskContextKeysOptions) {
  const includeHeartbeat = opts?.includeHeartbeat ?? false;
  return useQuery({
    queryKey: ["task-context-keys", { includeHeartbeat }],
    queryFn: () => api.fetchTaskContextKeys({ includeHeartbeat }),
    select: (data) => data.contextKeys,
    enabled: opts?.enabled ?? true,
    refetchInterval: 30_000,
  });
}
