import type { Database } from "../database";

const TOOL_NAME_MAP: Readonly<Record<string, string>> = {
  search_knowledge: "knowledge_search",
  get_knowledge_document: "knowledge_read",
  manage_knowledge_base: "knowledge_manage",
  web_open: "web_read",
};

/** 将存量 Agent 的检索工具权限一次性迁移到规范名称。 */
export const retrievalToolNamesMigration = {
  version: 2,
  apply(database: Database): void {
    for (const row of database.read<{ id: string; profile_json: string }>("SELECT id, profile_json FROM agents")) {
      const profile = JSON.parse(row.profile_json) as Record<string, unknown> & { allowedTools?: unknown };
      if (!Array.isArray(profile.allowedTools)) continue;

      const allowedTools = [...new Set(profile.allowedTools.flatMap((name) => {
        if (typeof name !== "string") return [];
        return [TOOL_NAME_MAP[name] ?? name];
      }))];
      database.write(
        "UPDATE agents SET profile_json = ? WHERE id = ?",
        [JSON.stringify({ ...profile, allowedTools }), row.id],
      );
    }
  },
} as const;
