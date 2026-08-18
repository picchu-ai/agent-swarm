/**
 * Display helpers for `contextKey` — the canonical cross-ingress
 * conversation/project key carried by every task that has one.
 *
 * Known shapes, in the order the swarm mints them:
 *   `project/<name>`                       — explicit project scope
 *   `slack/<channelId>`                    — a Slack channel conversation
 *   `task:slack:<channelId>:<threadTs>`    — a Slack thread
 *   `linear/<issueKey>`, `jira/<issueKey>` — tracker-scoped work
 *
 * Anything else renders verbatim: unknown shapes must degrade to the raw key
 * rather than to a wrong guess.
 */

export interface ContextKeyLabel {
  /** Scope shown as a muted prefix chip, or `null` for an unprefixed key. */
  scope: string | null;
  /** The human-facing remainder. Never empty. */
  label: string;
}

export function formatContextKey(contextKey: string): ContextKeyLabel {
  const key = contextKey.trim();
  if (!key) return { scope: null, label: contextKey };

  // `task:slack:<channel>:<ts>` — a thread inside a channel. Show the channel;
  // the thread timestamp is noise in a nav rail.
  if (key.startsWith("task:slack:")) {
    const channel = key.split(":")[2];
    return { scope: "slack", label: channel || key };
  }

  const slash = key.indexOf("/");
  if (slash > 0 && slash < key.length - 1) {
    return { scope: key.slice(0, slash), label: key.slice(slash + 1) };
  }

  return { scope: null, label: key };
}
