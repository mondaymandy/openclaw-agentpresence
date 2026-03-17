/**
 * HTTP API client for the Social Activity web app.
 * Replaces local SQLite with remote API calls.
 */

export interface ApiConfig {
  appUrl: string;
  apiKey: string;
  accountId: string;
}

let _config: ApiConfig | null = null;

export function initApiClient(config: ApiConfig): void {
  _config = config;
}

export function getApiConfig(): ApiConfig | null {
  return _config;
}

async function apiFetch(path: string, options?: RequestInit): Promise<any> {
  if (!_config) throw new Error("Social API client not initialized. Set SOCIAL_APP_URL, SOCIAL_APP_KEY, SOCIAL_ACCOUNT_ID.");
  
  const url = `${_config.appUrl}/api/bot/${_config.accountId}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Authorization": `Bearer ${_config.apiKey}`,
      "Content-Type": "application/json",
      ...(options?.headers ?? {}),
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Social API ${res.status}: ${text}`);
  }

  return res.json();
}

export async function fetchPersonality(platform?: string): Promise<any[]> {
  const params = platform ? `?platform=${platform}` : "";
  return apiFetch(`/personality${params}`);
}

export async function writePersonality(section: string, content: string, platform?: string): Promise<any> {
  return apiFetch("/personality", {
    method: "PUT",
    body: JSON.stringify({ section, content, platform: platform || "all" }),
  });
}

export async function listPosts(platform?: string, limit = 50): Promise<any[]> {
  const params = new URLSearchParams();
  if (platform) params.set("platform", platform);
  params.set("limit", String(limit));
  return apiFetch(`/posts?${params}`);
}

export async function logPost(post: {
  platform: string;
  postType?: string;
  text: string;
  url?: string;
  status?: string;
}): Promise<any> {
  return apiFetch("/posts", { method: "POST", body: JSON.stringify(post) });
}

export async function listEngagements(platform?: string, limit = 50): Promise<any[]> {
  const params = new URLSearchParams();
  if (platform) params.set("platform", platform);
  params.set("limit", String(limit));
  return apiFetch(`/engagements?${params}`);
}

export async function logEngagement(engagement: {
  platform: string;
  type: string;
  targetAuthor?: string;
  targetSnippet?: string;
  targetUrl?: string;
  myText?: string;
}): Promise<any> {
  return apiFetch("/engagements", { method: "POST", body: JSON.stringify(engagement) });
}

export async function fetchCorpus(): Promise<any[]> {
  return apiFetch("/corpus");
}

export async function writeCorpus(entry: {
  filename: string;
  title: string;
  content: string;
}): Promise<any> {
  return apiFetch("/corpus", { method: "POST", body: JSON.stringify(entry) });
}

export async function fetchStrategy(): Promise<any[]> {
  return apiFetch("/strategy");
}

export async function fetchFeedback(status?: string): Promise<any[]> {
  const params = status ? `?status=${status}` : "";
  return apiFetch(`/feedback${params}`);
}

export async function queuePost(post: {
  platform: string;
  postType?: string;
  text: string;
  scheduledFor?: string; // ISO timestamp — optional for drafts
  status?: string; // "scheduled" (default) or "draft"
}): Promise<any> {
  return apiFetch("/posts", {
    method: "POST",
    body: JSON.stringify({ ...post, status: post.status || "scheduled" }),
  });
}

export async function updatePostStatus(id: string, updates: {
  status?: string;
  scheduledFor?: string;
  text?: string;
}): Promise<any> {
  return apiFetch("/posts", {
    method: "PATCH",
    body: JSON.stringify({ id, ...updates }),
  });
}

export async function getNextScheduledPost(platform?: string): Promise<any | null> {
  const params = platform ? `?platform=${platform}` : "";
  return apiFetch(`/posts/next${params}`);
}

export async function markPostPublished(id: string, url?: string): Promise<any> {
  return apiFetch("/posts/next", {
    method: "PATCH",
    body: JSON.stringify({ id, url }),
  });
}

export async function writeJournalEntry(entry: {
  type: string;
  date: string;
  content: string;
}): Promise<any> {
  return apiFetch("/journal", { method: "POST", body: JSON.stringify(entry) });
}

export async function listJournalEntries(type?: string, limit?: number): Promise<any[]> {
  const params = new URLSearchParams();
  if (type) params.set("type", type);
  if (limit) params.set("limit", String(limit));
  return apiFetch(`/journal?${params}`);
}

export async function getJournalContext(): Promise<{
  daily: { date: string; content: string } | null;
  weekly: { date: string; content: string } | null;
  monthly: { date: string; content: string } | null;
  quarterly: { date: string; content: string } | null;
}> {
  return apiFetch("/journal/context");
}

// ── Chat API ────────────────────────────────────────────────────────────

export async function chatGetMessages(since?: string, limit?: number): Promise<any[]> {
  const cfg = _config;
  if (!cfg) throw new Error("API not configured");
  const params = new URLSearchParams();
  if (since) params.set("since", since);
  if (limit) params.set("limit", String(limit));
  const url = `${cfg.appUrl}/api/bot/${cfg.accountId}/chat?${params}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
  });
  if (!res.ok) throw new Error(`Chat GET failed: ${res.status}`);
  const data = await res.json();
  return data.messages || [];
}

export async function chatPostMessage(text: string, authorName?: string): Promise<any> {
  const cfg = _config;
  if (!cfg) throw new Error("API not configured");
  const res = await fetch(`${cfg.appUrl}/api/bot/${cfg.accountId}/chat`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text, authorName }),
  });
  if (!res.ok) throw new Error(`Chat POST failed: ${res.status}`);
  return res.json();
}

export async function chatRegisterWebhook(url: string, secret?: string): Promise<void> {
  const cfg = _config;
  if (!cfg) throw new Error("API not configured");
  const res = await fetch(`${cfg.appUrl}/api/bot/${cfg.accountId}/chat/webhook`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ url, secret }),
  });
  if (!res.ok) throw new Error(`Webhook register failed: ${res.status}`);
}

// ── Guardrails API ──────────────────────────────────────────────────────

export interface Guardrail {
  id: string;
  name: string;
  type: "phrase" | "regex" | "semantic";
  pattern: string;
  severity: "block" | "warn";
  enabled: boolean;
}

export interface GuardrailViolation {
  guardrail: Guardrail;
  match: string;
}

export async function fetchGuardrails(): Promise<Guardrail[]> {
  const cfg = _config;
  if (!cfg) return [];
  try {
    const res = await fetch(`${cfg.appUrl}/api/bot/${cfg.accountId}/guardrails`, {
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.guardrails || [];
  } catch {
    return [];
  }
}

/**
 * Check text against all guardrails. Returns violations found.
 * Only checks phrase and regex types — semantic requires LLM (handled separately).
 */
export function checkGuardrails(text: string, guardrails: Guardrail[]): GuardrailViolation[] {
  const violations: GuardrailViolation[] = [];
  const lower = text.toLowerCase();

  for (const g of guardrails) {
    if (!g.enabled) continue;

    if (g.type === "phrase") {
      if (lower.includes(g.pattern.toLowerCase())) {
        violations.push({ guardrail: g, match: g.pattern });
      }
    } else if (g.type === "regex") {
      try {
        const re = new RegExp(g.pattern, "gi");
        const m = text.match(re);
        if (m) {
          violations.push({ guardrail: g, match: m[0] });
        }
      } catch {}
    }
    // semantic type is skipped here — needs LLM, handled by caller
  }

  return violations;
}

// ── Audit Logging ──────────────────────────────────────────────────────
export interface AuditEventParams {
  category: 'content' | 'engagement' | 'inbound' | 'pipeline' | 'cron' | 'chat' | 'account' | 'system';
  eventType: string;
  platform?: string;
  title: string;
  description?: string;
  metadata?: Record<string, unknown>;
  itemId?: string;
  itemType?: string;
  severity?: 'info' | 'warning' | 'error' | 'success';
}

export async function logAuditEvent(params: AuditEventParams): Promise<void> {
  try {
    await apiFetch("/audit", {
      method: "POST",
      body: JSON.stringify(params),
    });
  } catch {
    // Audit logging should never break the main flow
  }
}
