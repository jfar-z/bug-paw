import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface DataPaths {
  rootDir: string;
  appDir: string;
  piDir: string;
  workspaceDir: string;
  agentsDir: string;
  transactionDir: string;
  deletionTransactionDir: string;
  historyDir: string;
  trashDir: string;
  knowledgeDir: string;
  databaseFile: string;
  instanceLockFile: string;
  runDir: string;
  userAvatarFile: string;
}

/**
 * 创建服务运行所需的持久化目录，并返回统一路径定义。
 */
export async function createDataPaths(root: string): Promise<DataPaths> {
  const rootDir = resolve(root);
  const appDir = join(rootDir, "app");
  const piDir = join(rootDir, "pi");
  const workspaceDir = join(rootDir, "workspace");
  const agentsDir = join(appDir, "agents");
  const runDir = join(appDir, "chat-runs");
  const transactionDir = join(appDir, "config-transactions");
  const deletionTransactionDir = join(appDir, "deletion-transactions");
  const historyDir = join(appDir, "config-history");
  const trashDir = join(appDir, "trash");
  const knowledgeDir = join(appDir, "knowledge");

  await Promise.all([
    mkdir(appDir, { recursive: true, mode: 0o700 }),
    mkdir(piDir, { recursive: true, mode: 0o700 }),
    mkdir(workspaceDir, { recursive: true, mode: 0o700 }),
    mkdir(agentsDir, { recursive: true, mode: 0o700 }),
    mkdir(runDir, { recursive: true, mode: 0o700 }),
    mkdir(transactionDir, { recursive: true, mode: 0o700 }),
    mkdir(deletionTransactionDir, { recursive: true, mode: 0o700 }),
    mkdir(historyDir, { recursive: true, mode: 0o700 }),
    mkdir(trashDir, { recursive: true, mode: 0o700 }),
    mkdir(knowledgeDir, { recursive: true, mode: 0o700 }),
  ]);

  return {
    rootDir,
    appDir,
    piDir,
    workspaceDir,
    agentsDir,
    transactionDir,
    deletionTransactionDir,
    historyDir,
    trashDir,
    knowledgeDir,
    databaseFile: join(appDir, "bugpaw.sqlite3"),
    instanceLockFile: join(appDir, ".bugpaw-instance.lock"),
    runDir,
    userAvatarFile: join(appDir, "user-avatar"),
  };
}
