import { getDb, logPost } from "../data/db.js";
import { appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "../../");

export interface PublishPayload {
  platform: "twitter" | "linkedin" | "reddit";
  type: "post" | "thread" | "reply" | "quote";
  content: string;
  url?: string;
  targetHandle?: string;
}

/**
 * Called after a post is published.
 * - Logs the post to SQLite
 * - Appends to the platform post-log.md for human review
 */
export function onPostPublish(payload: PublishPayload): { postId: number } {
  const db = getDb();

  const postId = logPost(db, {
    platform: payload.platform,
    type: payload.type,
    content: payload.content,
    url: payload.url,
    target_handle: payload.targetHandle,
  });

  // Append to markdown log for human review
  const logPath = join(PROJECT_ROOT, "data", payload.platform, "post-log.md");
  const date = new Date().toISOString();
  const urlLine = payload.url ? `\nURL: ${payload.url}` : "";
  const entry = `\n---\n**${date}** | type: ${payload.type}${urlLine}\n\n${payload.content}\n`;

  try {
    appendFileSync(logPath, entry, "utf-8");
  } catch {
    // Log file missing — not fatal
  }

  return { postId };
}
