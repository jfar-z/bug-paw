import { acquireInstanceLock } from "../src/server/instance-lock";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, rm, writeFile, chmod } from "node:fs/promises";
import { join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { openDatabase } from "../src/server/database/database";
import { runMigrations } from "../src/server/database/migrator";
import { toSummary, type StoredAigcWorkflow } from "../src/server/aigc/aigc-workflow-service";
import { workflowSummary } from "../src/server/workflows/workflow-repository";
import type { WorkflowDefinition } from "../src/shared/workflow-contracts";
import { writeJsonAtomic } from "../src/server/storage";

/** 独立离线迁移参数；应用启动和部署脚本不得调用此脚本。 */
interface MigrationOptions {
  dataDir: string;
  backupDir: string;
  apply: boolean;
}

/** 预检结果只包含计数，不输出工作流正文或业务凭据。 */
interface MigrationReport {
  comfyui: number;
  dag: number;
  applied: boolean;
}

/**
 * 停服后备份数据库及工作流原件，再显式迁移到 DB 索引和独立文件。
 * 数据库导入事务前完成所有定义落盘；中断后可在原件仍保留时重新运行。
 */
export async function migrateWorkflowStorage(options: MigrationOptions): Promise<MigrationReport> {
  const app = join(resolve(options.dataDir), "app");
  if (await exists(join(app, ".bugpaw-instance.lock"))) throw new Error("请先停止 BugPaw 服务并确认实例锁已释放，再执行迁移");
  const lock = await acquireInstanceLock(app);
  try { return await migrateOffline(options); }
  finally { await lock.release(); }
}

/** 持有实例锁时执行预检、备份及导入，防止迁移期间应用重新启动。 */
async function migrateOffline(options: MigrationOptions): Promise<MigrationReport> {
  const root = resolve(options.dataDir);
  const app = join(root, "app");
  const backupDir = resolve(options.backupDir);
  if (backupDir === root || backupDir.startsWith(`${root}/`)) throw new Error("备份目录必须位于生产数据目录之外");
  const sources = [join(app, "aigc-workflows.json"), join(app, "workflows", "definitions.json")];
  const originals = await Promise.all(sources.map(readOptional));
  if (originals.every((value) => value === null)) throw new Error("未找到旧工作流文件；不重复执行已完成的迁移");
  const comfy = originals[0] === null ? [] : JSON.parse(originals[0]).workflows;
  const dag = originals[1] === null ? [] : JSON.parse(originals[1]);
  if (!Array.isArray(comfy) || !Array.isArray(dag)) throw new Error("旧工作流聚合文件结构无效");
  const entries = [
    ...comfy.map((value: StoredAigcWorkflow) => ({ kind: "comfyui", value, summary: toSummary(value), directory: join(app, "aigc-workflows", "definitions") })),
    ...dag.map((value: WorkflowDefinition) => ({ kind: "dag", value, summary: workflowSummary(value), directory: join(app, "workflows", "definitions") })),
  ];
  const ids = new Set<string>();
  for (const entry of entries) {
    const key = `${entry.kind}:${entry.value.id}`;
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(entry.value.id) || ids.has(key)) throw new Error("工作流 ID 非法或重复，停止迁移");
    ids.add(key);
    const previous = await readOptional(join(entry.directory, `${entry.value.id}.json`));
    if (previous !== null && JSON.stringify(JSON.parse(previous)) !== JSON.stringify(entry.value)) {
      throw new Error("目标定义文件已存在且内容不同，拒绝覆盖");
    }
  }
  const interfaces = await readOptional(join(app, "aigc-interfaces.json"));
  if (interfaces) {
    for (const item of JSON.parse(interfaces).interfaces ?? []) {
      if (item.protocol === "comfyui" && !ids.has(`comfyui:${item.config.workflowId}`)) throw new Error("存在引用缺失工作流的 ComfyUI 接口，停止迁移");
    }
  }
  const report = { comfyui: comfy.length, dag: dag.length, applied: false };
  if (!options.apply) return report;

  // 备份目录必须全新，禁止覆盖上一次可恢复备份。
  await mkdir(backupDir, { mode: 0o700 });
  const sourceDatabase = new DatabaseSync(join(app, "bugpaw.sqlite3"), { readOnly: true });
  try { await backup(sourceDatabase, join(backupDir, "bugpaw.sqlite3")); }
  finally { sourceDatabase.close(); }
  await chmod(join(backupDir, "bugpaw.sqlite3"), 0o600);
  const manifest: { file: string; sha256: string }[] = [];
  for (let i = 0; i < sources.length; i++) {
    if (originals[i] === null) continue;
    const file = i === 0 ? "aigc-workflows.json" : "dag-definitions.json";
    await writeFile(join(backupDir, file), originals[i]!, { encoding: "utf8", mode: 0o600 });
    manifest.push({ file, sha256: digest(originals[i]!) });
  }
  // 运行记录持有历史定义快照，单独原样备份，不参与定义拆分。
  const runs = join(app, "workflows", "runs");
  if (await exists(runs)) {
    await mkdir(join(backupDir, "dag-runs"), { mode: 0o700 });
    for (const file of await readdir(runs)) {
      if (!/^[A-Za-z0-9_-]+\.json$/.test(file)) throw new Error("运行记录目录包含非预期文件，停止迁移");
      await copyFile(join(runs, file), join(backupDir, "dag-runs", file));
      await chmod(join(backupDir, "dag-runs", file), 0o600);
      manifest.push({ file: `dag-runs/${file}`, sha256: digest(await readFile(join(backupDir, "dag-runs", file))) });
    }
  }
  manifest.push({ file: "bugpaw.sqlite3", sha256: digest(await readFile(join(backupDir, "bugpaw.sqlite3"))) });
  await writeFile(join(backupDir, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  // 在任何目标变更之前重新核对备份字节，确保回滚材料完整。
  for (const item of manifest) {
    if (digest(await readFile(join(backupDir, item.file))) !== item.sha256) throw new Error("备份校验失败，停止迁移");
  }
  const database = openDatabase(join(app, "bugpaw.sqlite3"));
  try {
    runMigrations(database);
    const existing = database.read<{ kind: string; id: string; summary_json: string; definition_file: string }>("SELECT * FROM workflow_index");
    for (const row of existing) {
      const entry = entries.find((item) => item.kind === row.kind && item.value.id === row.id);
      if (!entry || row.summary_json !== JSON.stringify(entry.summary) || row.definition_file !== `${row.id}.json`) {
        throw new Error("数据库已有不同工作流索引，拒绝覆盖");
      }
    }
    for (const entry of entries) {
      await writeJsonAtomic(join(entry.directory, `${entry.value.id}.json`), entry.value);
      const readback = JSON.parse((await readOptional(join(entry.directory, `${entry.value.id}.json`)))!);
      if (JSON.stringify(readback) !== JSON.stringify(entry.value)) throw new Error("独立定义文件回读校验失败");
    }
    database.transaction(() => {
      for (const entry of entries) database.write(
        "INSERT OR IGNORE INTO workflow_index(kind, id, definition_file, summary_json) VALUES (?, ?, ?, ?)",
        [entry.kind, entry.value.id, `${entry.value.id}.json`, JSON.stringify(entry.summary)],
      );
      for (const kind of ["comfyui", "dag"]) database.write(
        "INSERT INTO workflow_index_state(kind, revision) VALUES (?, ?) ON CONFLICT(kind) DO UPDATE SET revision=excluded.revision",
        [kind, `migration-${Date.now()}`],
      );
      if (database.readOne<{ count: number }>("SELECT COUNT(*) AS count FROM workflow_index")?.count !== entries.length) throw new Error("迁移后工作流数量不匹配");
    });
    if (database.readOne<{ quick_check: string }>("PRAGMA quick_check")?.quick_check !== "ok") throw new Error("迁移后数据库完整性检查失败");
    database.checkpoint();
    // 所有数据校验成功后才移除已备份的精确旧文件；应用不保留旧格式兼容入口。
    for (let i = 0; i < sources.length; i++) {
      if (originals[i] === null) continue;
      if (await readOptional(sources[i]) !== originals[i]) throw new Error("迁移期间旧文件被修改，停止清理");
    }
    report.applied = true;
    await writeFile(join(backupDir, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
    for (let i = 0; i < sources.length; i++) if (originals[i] !== null) await rm(sources[i]);
    return report;
  } finally { database.close(); }
}

/** 只将明确缺失作为空输入，其他文件系统故障必须中止。 */
async function readOptional(path: string): Promise<string | null> {
  try {
    if (!(await lstat(path)).isFile()) throw new Error("迁移输入或目标必须为普通文件");
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** 判断离线锁和可选输入是否存在。 */
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

/** 哈希仅用于备份校验，不参与工作流定义文件命名。 */
function digest(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  const dataDir = args[args.indexOf("--data-dir") + 1];
  const backupDir = args[args.indexOf("--backup-dir") + 1];
  if (!args.includes("--data-dir") || !args.includes("--backup-dir") || !dataDir || !backupDir) {
    throw new Error("用法：tsx scripts/migrate-workflow-storage.ts --data-dir <数据目录> --backup-dir <全新备份目录> [--apply]；必须先停服");
  }
  console.log(JSON.stringify(await migrateWorkflowStorage({ dataDir, backupDir, apply: args.includes("--apply") })));
}
