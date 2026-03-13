import fs from "fs";
import path from "path";
import { TwitterWatcher } from "./watcher/twitter-watcher.js";
import { getDb, upsertInfluencer, getEnabledWatches } from "./data/db.js";
import { initApiClient, getApiConfig, fetchPersonality, logPost as apiLogPost, logEngagement as apiLogEngagement, listPosts, listEngagements, fetchCorpus, writeCorpus, fetchStrategy, fetchFeedback, queuePost, getNextScheduledPost, markPostPublished, updatePostStatus, writeJournalEntry, listJournalEntries, getJournalContext, chatPostMessage, chatRegisterWebhook, fetchGuardrails, checkGuardrails, logAuditEvent } from "./data/api-client.js";
import { MondayBoardClient } from "./services/monday-board.js";
import { canAct, recordAction, getActionCount } from "./utils/rate-limiter.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default function register(api: any): void {
  const cfg = api.config?.plugins?.entries?.["openclaw-agentpresence"]?.config ?? {};
  const mondayToken = process.env["MONDAY_API_TOKEN"];
  const tavilyKey = process.env["TAVILY_API_KEY"] ?? "";

  // ── Initialize API client from env ────────────────────────────────────
  const appUrl = process.env["SOCIAL_APP_URL"] ?? cfg.appUrl;
  const apiKey = process.env["SOCIAL_APP_KEY"] ?? cfg.apiKey;
  const accountId = process.env["SOCIAL_ACCOUNT_ID"] ?? cfg.accountId;

  if (appUrl && apiKey && accountId) {
    initApiClient({ appUrl, apiKey, accountId });
    api.logger.info(`openclaw-agentpresence: API client initialized (${appUrl}, account: ${accountId})`);
  } else {
    api.logger.warn("openclaw-agentpresence: SOCIAL_APP_URL/KEY/ACCOUNT_ID not set — API features disabled, using local SQLite only");
  }

  // ── Background service: Twitter watcher ──────────────────────────────
  let watcher: TwitterWatcher | null = null;

  api.registerService({
    id: "openclaw-agentpresence.watcher",
    start() {
      if (!tavilyKey) {
        api.logger.warn("openclaw-agentpresence: TAVILY_API_KEY not set — watcher disabled");
        return;
      }
      watcher = new TwitterWatcher(
        tavilyKey,
        {
          pollIntervalMs: cfg.watchIntervalMs ?? 600_000,
          notifySession: cfg.notifySessionKey ?? "main",
          quietHours: {
            start: cfg.quietHoursStart ?? "23:00",
            end: cfg.quietHoursEnd ?? "07:00",
            tz: "America/New_York",
          },
        },
        api.logger
      );
      watcher.start();
    },
    stop() {
      watcher?.stop();
      watcher = null;
    },
  });

  // ── Tool: Fetch personality from web app ──────────────────────────────
  api.registerTool({
    name: "social_get_personality",
    description: "Fetch the social personality/voice guidelines from the Social Activity web app. Call this before writing any post or comment to get the latest personality rules.",
    parameters: {
      type: "object",
      properties: {
        platform: { type: "string", enum: ["twitter", "linkedin", "youtube", "all"], description: "Filter by platform (default: all)" },
      },
      required: [],
    },
    async execute(_id: string, params: { platform?: string }) {
      if (!getApiConfig()) {
        return { content: [{ type: "text", text: "API not configured. Set SOCIAL_APP_URL, SOCIAL_APP_KEY, SOCIAL_ACCOUNT_ID." }] };
      }
      const sections = await fetchPersonality(params.platform === "all" ? undefined : params.platform);
      const text = sections.map((s: any) => {
        const header = s.platform !== "all" ? `[${s.platform}] ${s.section}` : s.section;
        return `## ${header}\n${s.content}`;
      }).join("\n\n---\n\n");
      return { content: [{ type: "text", text: text || "No personality sections found." }] };
    },
  });

  // ── Tool: Log a published post ────────────────────────────────────────
  api.registerTool({
    name: "social_log_post",
    description: "Log a published social media post. Saves to the web app AND local files. Call this immediately after posting.",
    parameters: {
      type: "object",
      properties: {
        platform: { type: "string", enum: ["twitter", "linkedin", "youtube"], description: "Platform posted to" },
        type: { type: "string", enum: ["post", "thread", "reply", "quote"], description: "Post type" },
        content: { type: "string", description: "Full post content" },
        url: { type: "string", description: "URL of the published post" },
        target_handle: { type: "string", description: "Handle replied to (for replies)" },
      },
      required: ["platform", "type", "content"],
    },
    async execute(_id: string, params: { platform: string; type: string; content: string; url?: string; target_handle?: string }) {
      let apiResult = null;
      
      // Log to web app API
      if (getApiConfig()) {
        try {
          // Guardrail check
          const _gr = await fetchGuardrails();
          const _gv = checkGuardrails(params.content, _gr);
          const _gb = _gv.filter((v: any) => v.guardrail.severity === "block");
          if (_gb.length > 0) {
            const msg = "🛑 POST BLOCKED by guardrails:\n" + _gb.map((v: any) => "- " + v.guardrail.name + ": matched \"" + v.match + "\"").join("\n") + "\n\nThe post was NOT logged.";
            logAuditEvent({ category: 'content', eventType: 'post_blocked', platform: params.platform, title: `Post blocked by guardrails: ${_gb.map((v: any) => v.guardrail.name).join(', ')}`, description: params.content.slice(0, 200), severity: 'warning' });
            return { content: [{ type: "text", text: msg }] };
          }
          apiResult = await apiLogPost({
            platform: params.platform,
            postType: params.type,
            text: params.content,
            url: params.url,
            status: "published",
          });
        } catch (err) {
          api.logger.warn(`openclaw-agentpresence: API log failed: ${err}`);
        }
      }

      // Also log locally (backward compat)
      try {
        const db = getDb();
        db.prepare(
          `INSERT INTO posts (platform, type, content, url, target_handle) VALUES (?, ?, ?, ?, ?)`
        ).run(params.platform, params.type, params.content, params.url ?? null, params.target_handle ?? null);
      } catch { /* local DB optional */ }

      recordAction(params.platform);
      
      // Audit: post logged
      logAuditEvent({
        category: 'content',
        eventType: 'post_published',
        platform: params.platform,
        title: `Published ${params.type}: "${params.content.slice(0, 80)}"`,
        metadata: { url: params.url },
        itemId: apiResult?.id,
        itemType: 'post',
        severity: 'success',
      });

      return {
        content: [{ type: "text", text: `Post logged${apiResult ? ` (API id: ${apiResult.id})` : " (local only)"}` }],
      };
    },
  });

  // ── Tool: Log an engagement ───────────────────────────────────────────
  api.registerTool({
    name: "social_log_engagement",
    description: "Log an engagement action (reply, comment, like) to the web app and local DB.",
    parameters: {
      type: "object",
      properties: {
        platform: { type: "string", enum: ["twitter", "linkedin", "youtube"] },
        target_handle: { type: "string", description: "Handle of person engaged with" },
        content: { type: "string", description: "Your reply/comment content" },
        url: { type: "string", description: "URL of your reply or original post" },
        they_engaged: { type: "boolean", description: "Did they engage back?" },
        they_followed_back: { type: "boolean", description: "Did they follow back?" },
        notes: { type: "string", description: "Notes about interaction quality" },
      },
      required: ["platform", "target_handle", "content"],
    },
    async execute(_id: string, params: {
      platform: string; target_handle: string; content: string;
      url?: string; they_engaged?: boolean; they_followed_back?: boolean; notes?: string;
    }) {
      let apiResult = null;

      // Log to web app API
      if (getApiConfig()) {
        try {
          apiResult = await apiLogEngagement({
            platform: params.platform,
            type: "reply",
            targetAuthor: params.target_handle,
            targetUrl: params.url,
            myText: params.content,
          });
        } catch (err) {
          api.logger.warn(`openclaw-agentpresence: API engagement log failed: ${err}`);
        }
      }

      // Also log locally
      try {
        const db = getDb();
        const postResult = db.prepare(
          `INSERT INTO posts (platform, type, content, url, target_handle) VALUES (?, 'reply', ?, ?, ?)`
        ).run(params.platform, params.content, params.url ?? null, params.target_handle);
        
        db.prepare(
          `UPDATE influencers SET replies_sent = replies_sent + 1, last_engaged_at = datetime('now'), updated_at = datetime('now') WHERE handle = ?`
        ).run(params.target_handle);
      } catch { /* local DB optional */ }

      recordAction(params.platform);

      // Audit: engagement logged
      logAuditEvent({
        category: 'engagement',
        eventType: 'reply_sent',
        platform: params.platform,
        title: `Reply to @${params.target_handle}: "${params.content.slice(0, 80)}"`,
        metadata: { targetUrl: params.url, targetHandle: params.target_handle },
        itemId: apiResult?.id,
        itemType: 'engagement',
        severity: 'info',
      });

      return {
        content: [{ type: "text", text: `Engagement logged${apiResult ? ` (API id: ${apiResult.id})` : " (local only)"}` }],
      };
    },
  });

  // ── Tool: Get posts from web app ──────────────────────────────────────
  api.registerTool({
    name: "social_get_posts",
    description: "List recent posts from the Social Activity web app.",
    parameters: {
      type: "object",
      properties: {
        platform: { type: "string", enum: ["twitter", "linkedin", "youtube"] },
        limit: { type: "number", description: "Max results (default 20)" },
      },
      required: [],
    },
    async execute(_id: string, params: { platform?: string; limit?: number }) {
      if (!getApiConfig()) return { content: [{ type: "text", text: "API not configured." }] };
      const posts = await listPosts(params.platform, params.limit ?? 20);
      return { content: [{ type: "text", text: JSON.stringify(posts, null, 2) }] };
    },
  });

  // ── Tool: Get feedback from web app ───────────────────────────────────
  api.registerTool({
    name: "social_get_feedback",
    description: "Get team feedback on posts from the Social Activity web app. Check this before posting to incorporate recent coaching.",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["pending", "addressed"], description: "Filter by status" },
      },
      required: [],
    },
    async execute(_id: string, params: { status?: string }) {
      if (!getApiConfig()) return { content: [{ type: "text", text: "API not configured." }] };
      const feedback = await fetchFeedback(params.status);
      return { content: [{ type: "text", text: JSON.stringify(feedback, null, 2) }] };
    },
  });

  // ── Tool: Get corpus ──────────────────────────────────────────────────
  api.registerTool({
    name: "social_get_corpus",
    description: "Get the knowledge corpus from the Social Activity web app — reference material for writing posts.",
    parameters: { type: "object", properties: {}, required: [] },
    async execute() {
      if (!getApiConfig()) return { content: [{ type: "text", text: "API not configured." }] };
      const corpus = await fetchCorpus();
      return { content: [{ type: "text", text: JSON.stringify(corpus, null, 2) }] };
    },
  });

  // ── Tool: Write corpus entry ───────────────────────────────────────────
  api.registerTool({
    name: "social_write_corpus",
    description: "Write or update a knowledge corpus entry on the Social Activity web app. Use this to persist learned knowledge — extracted from links, attachments, conversations, or any source. The corpus is the agent's long-term knowledge base for writing posts and making decisions. Filename acts as a unique key (upserts if exists).",
    parameters: {
      type: "object",
      properties: {
        filename: { type: "string", description: "Unique filename/slug for this entry (e.g. 'competitor-launch-2026-03', 'brand-guidelines-v2'). Used as upsert key." },
        title: { type: "string", description: "Human-readable title for the corpus entry" },
        content: { type: "string", description: "Full content of the corpus entry (markdown supported)" },
      },
      required: ["filename", "title", "content"],
    },
    async execute(_id: string, params: { filename: string; title: string; content: string }) {
      if (!getApiConfig()) return { content: [{ type: "text", text: "API not configured. Set SOCIAL_APP_URL, SOCIAL_APP_KEY, SOCIAL_ACCOUNT_ID." }] };
      try {
        const result = await writeCorpus(params);
        return { content: [{ type: "text", text: `✅ Corpus entry saved: "${params.title}" (${params.filename})\nID: ${result.id}` }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: `❌ Failed to write corpus: ${err.message}` }] };
      }
    },
  });

  // ── Tool: Get strategy ────────────────────────────────────────────────
  api.registerTool({
    name: "social_get_strategy",
    description: "Get content strategy docs from the Social Activity web app.",
    parameters: { type: "object", properties: {}, required: [] },
    async execute() {
      if (!getApiConfig()) return { content: [{ type: "text", text: "API not configured." }] };
      const strategy = await fetchStrategy();
      return { content: [{ type: "text", text: JSON.stringify(strategy, null, 2) }] };
    },
  });

  // ── Tool: Upsert influencer (local DB) ────────────────────────────────
  api.registerTool({
    name: "social_upsert_influencer",
    description: "Add or update an influencer in the local DB.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" }, handle: { type: "string" },
        platform: { type: "string", enum: ["twitter", "linkedin", "youtube"] },
        monday_item_id: { type: "string" },
        phase: { type: "number", enum: [1, 2, 3, 4] },
        priority: { type: "string", enum: ["high", "medium", "low"] },
        type: { type: "string", enum: ["tech", "business", "creator", "media"] },
        notes: { type: "string" },
      },
      required: ["name", "handle"],
    },
    execute(_id: string, params: any) {
      const db = getDb();
      const id = upsertInfluencer(db, params);
      return { content: [{ type: "text", text: `Influencer @${params.handle} saved (id: ${id})` }] };
    },
  });

  // ── Tool: Watch status ────────────────────────────────────────────────
  api.registerTool({
    name: "social_watch_status",
    description: "Get Twitter watcher status and pending tweet notifications.",
    parameters: { type: "object", properties: {}, required: [] },
    execute() {
      if (!watcher) return { content: [{ type: "text", text: "Watcher not running (TAVILY_API_KEY not set?)" }] };
      const status = watcher.getStatus();
      const notifications = watcher.drainNotifications();
      const lines = [
        `Running: ${status.running}`,
        `Watching: ${status.watchList.map((h: string) => `@${h}`).join(", ")}`,
        `Last poll: ${status.lastPollAt ?? "never"}`,
        notifications.length > 0
          ? `NEW TWEETS (${notifications.length}):\n${notifications.map((e: any) => `  @${e.handle}: ${e.url}\n  "${e.text.slice(0, 120)}..."`).join("\n\n")}`
          : "No new tweets.",
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  });

  // ── Tool: Rate check ──────────────────────────────────────────────────
  api.registerTool({
    name: "social_rate_check",
    description: "Check action count this hour (LinkedIn: 30/hr, Twitter: 120/hr).",
    parameters: {
      type: "object",
      properties: { platform: { type: "string", enum: ["twitter", "linkedin", "youtube"] } },
      required: ["platform"],
    },
    execute(_id: string, params: { platform: string }) {
      const count = getActionCount(params.platform);
      const ok = canAct(params.platform);
      return { content: [{ type: "text", text: `${params.platform}: ${count} actions this hour. ${ok ? "OK." : "LIMIT REACHED."}` }] };
    },
  });

  // ── Tool: Advance influencer phase ────────────────────────────────────
  api.registerTool({
    name: "social_advance_phase",
    description: "Advance an influencer to the next engagement phase on Monday.com board.",
    parameters: {
      type: "object",
      properties: {
        handle: { type: "string" },
        new_phase: { type: "number", enum: [2, 3, 4] },
      },
      required: ["handle", "new_phase"],
    },
    async execute(_id: string, params: { handle: string; new_phase: number }) {
      if (!mondayToken) return { content: [{ type: "text", text: "MONDAY_API_TOKEN not set" }] };
      const db = getDb();
      const influencer = db.prepare("SELECT * FROM influencers WHERE handle = ?").get(params.handle) as any;
      if (!influencer?.monday_item_id) return { content: [{ type: "text", text: `No Monday item ID for @${params.handle}` }] };

      const phaseLabels: Record<number, string> = { 2: "Phase 2 - Engage", 3: "Phase 3 - Deepen", 4: "Phase 4 - Partner" };
      const monday = new MondayBoardClient(mondayToken);
      await monday.advancePhase(influencer.monday_item_id, phaseLabels[params.new_phase] as any);
      db.prepare("UPDATE influencers SET phase = ?, updated_at = datetime('now') WHERE handle = ?").run(params.new_phase, params.handle);

      return { content: [{ type: "text", text: `@${params.handle} advanced to Phase ${params.new_phase}` }] };
    },
  });

  // ── Tool: Monday sync ─────────────────────────────────────────────────
  api.registerTool({
    name: "social_monday_sync",
    description: "Sync all influencers from the Monday.com board into local DB.",
    parameters: { type: "object", properties: {}, required: [] },
    async execute() {
      if (!mondayToken) return { content: [{ type: "text", text: "MONDAY_API_TOKEN not set" }] };
      const monday = new MondayBoardClient(mondayToken);
      const items = await monday.listItems();
      const db = getDb();
      let synced = 0;
      for (const item of items) {
        const handleCol = item.column_values.find((c: any) => c.id === "text_mm15amhz");
        if (!handleCol?.text) continue;
        upsertInfluencer(db, { name: item.name, handle: handleCol.text, monday_item_id: item.id });
        synced++;
      }
      return { content: [{ type: "text", text: `Synced ${synced} influencers from Monday.com` }] };
    },
  });

  // ── Slash commands ───────────────────────────────────────────────────

  // ── Tool: Queue a post for scheduled publishing ───────────────────────
  api.registerTool({
    name: "social_queue_post",
    description: "Queue a post for future publishing. The main agent writes posts with full context, then a lightweight cron publishes them on schedule. Use ISO timestamps for scheduledFor (e.g. '2026-03-08T12:00:00-05:00' for noon ET). Set status='draft' to save without scheduling (won't auto-publish until approved).",
    parameters: {
      type: "object",
      properties: {
        platform: { type: "string", enum: ["twitter", "linkedin", "youtube"], description: "Target platform" },
        type: { type: "string", enum: ["post", "thread", "reply", "quote"], description: "Post type" },
        content: { type: "string", description: "Full post content" },
        scheduledFor: { type: "string", description: "ISO timestamp for when to publish (optional for drafts)" },
        status: { type: "string", enum: ["scheduled", "draft"], description: "Post status — 'draft' saves without scheduling, 'scheduled' (default) queues for auto-publish" },
      },
      required: ["platform", "type", "content"],
    },
    async execute(_id: string, params: { platform: string; type: string; content: string; scheduledFor?: string; status?: string }) {
      if (!getApiConfig()) return { content: [{ type: "text", text: "API not configured." }] };
      try {
        // Pre-publish guardrail check
        const guardrails = await fetchGuardrails();
        const violations = checkGuardrails(params.content, guardrails);
        const blocks = violations.filter((v: any) => v.guardrail.severity === "block");
        const warns = violations.filter((v: any) => v.guardrail.severity === "warn");
        if (blocks.length > 0) {
          const msg = "\ud83d\uded1 POST BLOCKED by guardrails:\n" + blocks.map((v: any) => "- " + v.guardrail.name + ": matched \"" + v.match + "\"").join("\n") + "\n\nThe post was NOT queued. Fix the content and try again.";
          return { content: [{ type: "text", text: msg }] };
        }
        let warnText = "";
        if (warns.length > 0) {
          warnText = "\n\n\u26a0\ufe0f Guardrail warnings:\n" + warns.map((v: any) => "- " + v.guardrail.name + ": matched \"" + v.match + "\"").join("\n");
        }
        const isDraft = params.status === "draft";
        if (!isDraft && !params.scheduledFor) {
          return { content: [{ type: "text", text: "scheduledFor is required when status is 'scheduled'. Use status='draft' to save without a schedule." }] };
        }
        const result = await queuePost({
          platform: params.platform,
          postType: params.type,
          text: params.content,
          scheduledFor: params.scheduledFor,
          status: isDraft ? "draft" : "scheduled",
        });
        if (isDraft) {
          logAuditEvent({
            category: 'content',
            eventType: 'post_drafted',
            platform: params.platform,
            title: `Drafted ${params.type}: "${params.content.slice(0, 80)}"`,
            itemId: result.id,
            itemType: 'post',
            severity: 'info',
          });
          return { content: [{ type: "text", text: `Post saved as draft (id: ${result.id}) on ${params.platform}. Use social_publish_next with approveDraft=${result.id} and scheduledFor to approve and schedule it.` }] };
        }
        const dt = new Date(params.scheduledFor!);
        logAuditEvent({
          category: 'content',
          eventType: 'post_scheduled',
          platform: params.platform,
          title: `Scheduled ${params.type}: "${params.content.slice(0, 80)}" for ${dt.toISOString()}`,
          itemId: result.id,
          itemType: 'post',
          severity: 'info',
        });
        return { content: [{ type: "text", text: `Post queued (id: ${result.id}). Will publish at ${dt.toLocaleString("en-US", { timeZone: "America/New_York" })} ET on ${params.platform}.` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Failed to queue post: ${err}` }] };
      }
    },
  });

  // ── Tool: Get next scheduled post to publish ──────────────────────────
  api.registerTool({
    name: "social_publish_next",
    description: "Get the next scheduled post that's due for publishing. Returns null if nothing is due. After posting via browser, call this again with the post ID and URL to mark it published. Use approveDraft to approve a draft and schedule it.",
    parameters: {
      type: "object",
      properties: {
        platform: { type: "string", enum: ["twitter", "linkedin", "youtube"], description: "Filter by platform" },
        markPublished: { type: "string", description: "Post ID to mark as published (after posting)" },
        url: { type: "string", description: "Published post URL (when marking published)" },
        approveDraft: { type: "string", description: "Draft post ID to approve and schedule" },
        scheduledFor: { type: "string", description: "ISO timestamp to schedule the approved draft for" },
      },
      required: [],
    },
    async execute(_id: string, params: { platform?: string; markPublished?: string; url?: string; approveDraft?: string; scheduledFor?: string }) {
      if (!getApiConfig()) return { content: [{ type: "text", text: "API not configured." }] };

      // Approve a draft → move to scheduled
      if (params.approveDraft) {
        try {
          const updates: any = { status: "scheduled" };
          if (params.scheduledFor) updates.scheduledFor = params.scheduledFor;
          const result = await updatePostStatus(params.approveDraft, updates);
          const dt = params.scheduledFor ? new Date(params.scheduledFor) : null;
          logAuditEvent({
            category: 'content',
            eventType: 'post_approved',
            platform: result.platform,
            title: `Draft approved → scheduled: "${(result.text || '').slice(0, 80)}"`,
            metadata: { scheduledFor: params.scheduledFor },
            itemId: result.id,
            itemType: 'post',
            severity: 'success',
          });
          return { content: [{ type: "text", text: `Draft ${result.id} approved and scheduled${dt ? ` for ${dt.toLocaleString("en-US", { timeZone: "America/New_York" })} ET` : ''}.` }] };
        } catch (err) {
          return { content: [{ type: "text", text: `Failed to approve draft: ${err}` }] };
        }
      }
      
      if (params.markPublished) {
        const result = await markPostPublished(params.markPublished, params.url);
        logAuditEvent({
          category: 'content',
          eventType: 'post_published',
          platform: result.platform,
          title: `Published scheduled post: "${(result.text || '').slice(0, 80)}"`,
          metadata: { url: params.url },
          itemId: result.id,
          itemType: 'post',
          severity: 'success',
        });
        return { content: [{ type: "text", text: `Post ${result.id} marked as published.` }] };
      }

      const post = await getNextScheduledPost(params.platform);
      if (!post) return { content: [{ type: "text", text: "No scheduled posts due right now." }] };
      return { content: [{ type: "text", text: JSON.stringify(post, null, 2) }] };
    },
  });
  api.registerCommand({ name: "watch-status", description: "Twitter watcher status", handler: () => {
    if (!watcher) return { text: "Watcher not running." };
    const s = watcher.getStatus();
    const n = watcher.drainNotifications();
    return { text: n.length === 0 ? `Watching: ${s.watchList.join(", ")}. No new tweets.` : `New tweets:\n${n.map((e: any) => `@${e.handle}: ${e.url}`).join("\n")}` };
  }});

  api.registerCommand({ name: "rate-status", description: "Action counts this hour", handler: () => {
    return { text: `LinkedIn: ${getActionCount("linkedin")}/30\nTwitter: ${getActionCount("twitter")}/120` };
  }});

  api.registerCommand({ name: "watch-list", description: "Watched Twitter accounts", handler: () => {
    const watches = getEnabledWatches(getDb());
    return { text: watches.length === 0 ? "No watches." : watches.map(w => `@${w.handle} — last: ${w.last_checked_at ?? "never"}`).join("\n") };
  }});

  // ── Tool: Write a journal entry ──────────────────────────────────────
  api.registerTool({
    name: "social_write_journal",
    description: "Write or update a personal experience journal entry. Use this to document real events, quotes, execution details, failures, fixes, and specific numbers — not just high-level summaries. The content writer reads these journals to create authentic posts.",
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["daily", "weekly", "monthly", "quarterly"], description: "Journal entry type" },
        date: { type: "string", description: "Date string: YYYY-MM-DD for daily, YYYY-Www for weekly, YYYY-MM for monthly, YYYY-Qq for quarterly" },
        content: { type: "string", description: "Full markdown content of the journal entry. Include specific quotes, execution details, real numbers, failures and fixes. Both detail-level AND high-level context." },
      },
      required: ["type", "date", "content"],
    },
    async execute(_id: string, params: { type: string; date: string; content: string }) {
      const journalEnabled = cfg.journal?.enabled ?? false;
      if (!journalEnabled) {
        return { content: [{ type: "text", text: "Journaling is disabled. Enable it in plugin config (set journal.enabled: true)." }] };
      }
      if (!getApiConfig()) {
        return { content: [{ type: "text", text: "API not configured. Set SOCIAL_APP_URL, SOCIAL_APP_KEY, SOCIAL_ACCOUNT_ID." }] };
      }
      const entry = await writeJournalEntry({ type: params.type, date: params.date, content: params.content });
      logAuditEvent({
        category: 'pipeline',
        eventType: 'journal_written',
        title: `Journal entry: ${params.type} for ${params.date}`,
        itemId: entry.id,
        itemType: 'journal',
        severity: 'info',
      });
      return { content: [{ type: "text", text: `Journal entry saved (id: ${entry.id}, type: ${entry.type}, date: ${entry.date}).` }] };
    },
  });

  // ── Tool: Get journal context for content writing ─────────────────────
  api.registerTool({
    name: "social_get_journal_context",
    description: "Get the latest journal entries for content writing context. Returns the most recent daily, weekly, monthly, and quarterly entries. The content writer uses this to create authentic, experience-based posts.",
    parameters: { type: "object", properties: {}, required: [] },
    async execute(_id: string, _params: Record<string, never>) {
      const journalEnabled = cfg.journal?.enabled ?? false;
      if (!journalEnabled || !getApiConfig()) {
        return { content: [{ type: "text", text: JSON.stringify({ daily: null, weekly: null, monthly: null, quarterly: null }) }] };
      }
      const context = await getJournalContext();
      const parts: string[] = [];
      for (const [type, entry] of Object.entries(context)) {
        if (entry && entry.content) {
          const label = type.charAt(0).toUpperCase() + type.slice(1);
          parts.push(`## ${label} (${entry.date})\n${entry.content}`);
        }
      }
      if (parts.length === 0) {
        return { content: [{ type: "text", text: "No journal entries yet." }] };
      }
      return { content: [{ type: "text", text: parts.join("\n\n---\n\n") }] };
    },
  });

  // ── Tool: List journal entries ────────────────────────────────────────
  api.registerTool({
    name: "social_get_journal",
    description: "List journal entries from the Social Activity app.",
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["daily", "weekly", "monthly", "quarterly"], description: "Filter by entry type" },
        limit: { type: "number", description: "Max entries to return (default 10)" },
      },
      required: [],
    },
    async execute(_id: string, params: { type?: string; limit?: number }) {
      if (!getApiConfig()) {
        return { content: [{ type: "text", text: "API not configured." }] };
      }
      const entries = await listJournalEntries(params.type, params.limit);
      if (!entries.length) return { content: [{ type: "text", text: "No journal entries found." }] };
      const text = entries.map((e: any) => {
        const preview = e.content.slice(0, 200) + (e.content.length > 200 ? "..." : "");
        return `[${e.type}] ${e.date}\n${preview}`;
      }).join("\n\n---\n\n");
      return { content: [{ type: "text", text: text }] };
    },
  });

  api.registerCommand({ name: "watch-status", description: "Twitter watcher status", handler: () => {
    if (!watcher) return { text: "Watcher not running." };
    const s = watcher.getStatus();
    const n = watcher.drainNotifications();
    return { text: n.length === 0 ? `Watching: ${s.watchList.join(", ")}. No new tweets.` : `New tweets:\n${n.map((e: any) => `@${e.handle}: ${e.url}`).join("\n")}` };
  }});

  api.registerCommand({ name: "rate-status", description: "Action counts this hour", handler: () => {
    return { text: `LinkedIn: ${getActionCount("linkedin")}/30\nTwitter: ${getActionCount("twitter")}/120` };
  }});

  api.registerCommand({ name: "watch-list", description: "Watched Twitter accounts", handler: () => {
    const watches = getEnabledWatches(getDb());
    return { text: watches.length === 0 ? "No watches." : watches.map(w => `@${w.handle} — last: ${w.last_checked_at ?? "never"}`).join("\n") };
  }});

  // ── Schedules: Expose real OpenClaw crons via HTTP ──────────────────

  api.registerHttpRoute({
    path: "/api/agentpresence/schedules",
    auth: "plugin",
    async handler(req: any, res: any) {
      if (req.method !== "GET") {
        res.writeHead(405).end("Method Not Allowed");
        return;
      }

      // Verify bot API key
      const authHeader = req.headers["authorization"] || "";
      const token = authHeader.replace("Bearer ", "");
      const config = getApiConfig();
      if (!config || token !== config.apiKey) {
        res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }

      try {
        // Read cron jobs from OpenClaw's cron store
        const configDir = process.env["OPENCLAW_CONFIG_DIR"] || path.join(process.env["HOME"] || "", ".openclaw");
        const cronPath = path.join(configDir, "cron", "jobs.json");
        
        if (!fs.existsSync(cronPath)) {
          res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ schedules: [], connected: true }));
          return;
        }

        const raw = fs.readFileSync(cronPath, "utf-8");
        const store = JSON.parse(raw);
        const jobs = store.jobs || [];

        // Map to schedule format the web app expects
        const schedules = jobs.map((job: any) => {
          let schedule = "";
          let kind = job.schedule?.kind || "unknown";
          if (kind === "cron") schedule = job.schedule.expr || "";
          else if (kind === "every") schedule = `every ${Math.round((job.schedule.everyMs || 0) / 60000)}m`;
          else if (kind === "at") schedule = `once at ${job.schedule.at || ""}`;

          return {
            id: job.id,
            name: job.name || "Unnamed",
            schedule,
            kind,
            enabled: job.enabled !== false,
            platform: detectPlatform(job.name || ""),
            type: detectType(job.name || "", job.payload),
            lastRun: job.state?.lastRunAtMs ? new Date(job.state.lastRunAtMs).toISOString() : undefined,
            lastStatus: job.state?.lastStatus === "ok" ? "success" : job.state?.lastStatus === "error" ? "fail" : undefined,
            nextRun: undefined, // computed by gateway, not stored
            payload: job.payload?.kind === "agentTurn" ? job.payload.message?.slice(0, 100) : job.payload?.text?.slice(0, 100),
            sessionTarget: job.sessionTarget || "main",
          };
        });

        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ schedules, connected: true }));
      } catch (err) {
        api.logger.error(`agentpresence schedules: failed to read crons: ${err}`);
        res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Failed to read crons", connected: false }));
      }
    },
  });

  function detectPlatform(name: string): string | undefined {
    const lower = name.toLowerCase();
    if (lower.includes("twitter") || lower.includes(" x ") || lower.includes("tweet")) return "twitter";
    if (lower.includes("linkedin")) return "linkedin";
    return undefined;
  }

  function detectType(name: string, payload: any): string {
    const lower = name.toLowerCase();
    if (lower.includes("publish")) return "publish";
    if (lower.includes("content writer") || lower.includes("content")) return "content";
    if (lower.includes("scan") || lower.includes("news")) return "scan";
    if (lower.includes("journal")) return "journal";
    if (lower.includes("engage")) return "engagement";
    if (lower.includes("reminder")) return "reminder";
    if (lower.includes("heartbeat")) return "system";
    if (lower.includes("accountability")) return "system";
    if (payload?.kind === "agentTurn") return "agent";
    return "other";
  }

  // ── Chat Channel: Agent Presence as a communication channel ──────────

  // ── Agent Presence Chat Channel ─────────────────────────────────────
  // Register as a proper OpenClaw channel so inbound chat messages get
  // routed through the agent and responses come back automatically.

  const chatWebhookSecret = `ap_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  let chatWebhookRegistered = false;
  // Callback set by the gateway adapter to dispatch inbound messages
  let dispatchInbound: ((from: string, text: string, authorName: string) => void) | null = null;

  // HTTP route: receives webhook POSTs from Agent Presence web app
  api.registerHttpRoute({
    path: "/api/agentpresence/inbound",
    auth: "plugin",
    async handler(req: any, res: any) {
      if (req.method !== "POST") {
        res.writeHead(405).end("Method Not Allowed");
        return;
      }
      const secret = req.headers["x-webhook-secret"];
      if (secret !== chatWebhookSecret) {
        res.writeHead(401).end("Unauthorized");
        return;
      }
      let body = "";
      for await (const chunk of req) body += chunk;
      let payload: any;
      try { payload = JSON.parse(body); } catch { res.writeHead(400).end("Bad JSON"); return; }

      const { event, message } = payload;
      if (event !== "chat.message" || !message?.text) {
        res.writeHead(200).end("ignored");
        return;
      }

      api.logger.info(`agentpresence channel: inbound from ${message.authorName}: "${message.text.slice(0, 80)}"`);

      if (dispatchInbound) {
        dispatchInbound(message.authorEmail || message.authorName || "web-user", message.text, message.authorName || "User");
      } else {
        api.logger.warn("agentpresence channel: dispatchInbound not ready yet");
      }

      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
    },
  });

  // Register Agent Presence as a proper channel
  api.registerChannel({
    id: "agentpresence",
    meta: {
      id: "agentpresence",
      label: "Agent Presence",
      selectionLabel: "Agent Presence Chat",
      docsPath: "channels/agentpresence",
      blurb: "Chat via the Agent Presence web dashboard",
      order: 100,
    },
    capabilities: {
      chatTypes: ["direct" as any],
      media: false,
      polls: false,
      reactions: false,
      edit: false,
      unsend: false,
      reply: false,
      effects: false,
      groupManagement: false,
      threads: false,
      nativeCommands: false,
    },
    config: {
      listAccountIds: () => accountId ? [accountId] : [],
      resolveAccount: () => ({
        accountId: accountId || "default",
        appUrl: appUrl || "",
        apiKey: apiKey || "",
        enabled: !!(appUrl && apiKey && accountId),
      }),
      isEnabled: (account: any) => !!account?.enabled,
      isConfigured: (account: any) => !!(account?.appUrl && account?.apiKey),
    },
    outbound: {
      deliveryMode: "direct" as any,
      textChunkLimit: 4000,
      async sendText(ctx: any) {
        const text = ctx.text;
        if (!text || text === "NO_REPLY" || text === "HEARTBEAT_OK") {
          return { ok: true, messageId: "skipped" };
        }
        try {
          const result = await chatPostMessage(text, "Novalystrix");
          api.logger.info(`agentpresence channel: sent response (${text.length} chars)`);
          return { ok: true, messageId: result?.id || "sent" };
        } catch (err) {
          api.logger.error(`agentpresence channel: send failed: ${err}`);
          return { ok: false, error: String(err) };
        }
      },
    },
    gateway: {
      async startAccount(ctx: any) {
        const channelRuntime = ctx.channelRuntime;
        if (!channelRuntime) {
          api.logger.warn("agentpresence channel: channelRuntime not available");
          return;
        }

        // Set up the dispatch callback that the HTTP webhook handler calls
        dispatchInbound = (from: string, text: string, authorName: string) => {
          channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher({
            ctx: {
              Channel: "agentpresence",
              ChannelId: "agentpresence",
              From: from,
              To: accountId || "default",
              ChatType: "direct",
              Body: text,
              SenderName: authorName,
              AccountId: accountId || "default",
            },
            cfg: api.config,
            dispatcherOptions: {
              deliver: async (payload: any) => {
                const responseText = typeof payload === "string" ? payload : (payload?.text || payload?.content || "");
                if (!responseText || responseText === "NO_REPLY" || responseText === "HEARTBEAT_OK") return;
                try {
                  await chatPostMessage(responseText, "Novalystrix");
                  api.logger.info(`agentpresence channel: delivered response (${responseText.length} chars)`);
                } catch (err) {
                  api.logger.error(`agentpresence channel: delivery failed: ${err}`);
                }
              },
            },
          });
        };

        // Register webhook with web app
        if (!getApiConfig()) {
          api.logger.warn("agentpresence channel: API not configured");
          return;
        }

        const gatewayPort = api.config?.gateway?.port ?? 18789;
        const baseUrl = cfg.webhookBaseUrl || process.env["OPENCLAW_WEBHOOK_URL"] || `http://localhost:${gatewayPort}`;
        const webhookUrl = `${baseUrl}/api/agentpresence/inbound`;

        try {
          await chatRegisterWebhook(webhookUrl, chatWebhookSecret);
          chatWebhookRegistered = true;
          api.logger.info(`agentpresence channel: webhook registered at ${webhookUrl}`);
          logAuditEvent({ category: "system", eventType: "plugin_connected", title: "Agent Presence channel connected", metadata: { webhookUrl }, severity: "success" });

          await chatPostMessage("Connected! 💠 I'm now live on this chat as a proper channel — messages route directly to me and responses come right back.", "Novalystrix");
        } catch (err) {
          api.logger.error(`agentpresence channel: failed to start: ${err}`);
          logAuditEvent({ category: "system", eventType: "plugin_connection_failed", title: `Channel start failed: ${err}`, severity: "error" });
        }

        // Keep the account "alive" — return a promise that resolves when aborted.
        // This prevents the health monitor from thinking the account has stopped.
        const abortSignal: AbortSignal | undefined = ctx.abortSignal;
        if (abortSignal) {
          await new Promise<void>((resolve) => {
            if (abortSignal.aborted) { resolve(); return; }
            abortSignal.addEventListener("abort", () => resolve(), { once: true });
          });
        } else {
          // Fallback: keep alive forever (resolved on stop)
          await new Promise<void>((resolve) => {
            (ctx as any)._stopResolve = resolve;
          });
        }
      },
      async stopAccount(ctx: any) {
        dispatchInbound = null;
        chatWebhookRegistered = false;
        if ((ctx as any)?._stopResolve) (ctx as any)._stopResolve();
        logAuditEvent({ category: "system", eventType: "plugin_disconnected", title: "Agent Presence channel disconnected", severity: "warning" });
      },
    },
  });

}
