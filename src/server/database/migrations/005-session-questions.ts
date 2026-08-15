import type { Database } from "../database";

/** 持久化可跨重启恢复的 Session 用户提问，并一次性迁移存量权限。 */
export const sessionQuestionsMigration = {
  version: 5,
  apply(database: Database): void {
    database.exec(`
      CREATE TABLE session_questions (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        tool_call_id TEXT NOT NULL,
        branch_anchor_id TEXT,
        state TEXT NOT NULL CHECK(state IN ('pending','resolving','submitted','discarded')),
        version INTEGER NOT NULL CHECK(version >= 1),
        questions_json TEXT NOT NULL CHECK(json_valid(questions_json)),
        resolution_json TEXT CHECK(resolution_json IS NULL OR json_valid(resolution_json)),
        resolution_id TEXT,
        resumed_run_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE UNIQUE INDEX idx_session_questions_unresolved
        ON session_questions(session_id)
        WHERE state IN ('pending', 'resolving');
      CREATE INDEX idx_session_questions_agent_session
        ON session_questions(agent_id, session_id);
      CREATE INDEX idx_session_questions_resolution
        ON session_questions(resolution_id);
    `);

    for (const row of database.read<{ id: string; profile_json: string }>(
      "SELECT id, profile_json FROM agents",
    )) {
      const profile: unknown = JSON.parse(row.profile_json);
      if (!isProfileWithStringTools(profile) || profile.allowedTools.includes("ask_user")) continue;
      database.write(
        "UPDATE agents SET profile_json = ? WHERE id = ?",
        [JSON.stringify({ ...profile, allowedTools: [...profile.allowedTools, "ask_user"] }), row.id],
      );
    }
  },
} as const;

function isProfileWithStringTools(
  value: unknown,
): value is Record<string, unknown> & { allowedTools: string[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const allowedTools = (value as { allowedTools?: unknown }).allowedTools;
  return Array.isArray(allowedTools) && allowedTools.every((tool) => typeof tool === "string");
}
