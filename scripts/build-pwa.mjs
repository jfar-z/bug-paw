import { readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLACEHOLDER = "__BUGPAW_PRECACHE__";

/** 从 Vite manifest 递归收集应用入口与浏览器配置页分包并原子注入 Service Worker。 */
export async function injectPwaPrecache(outputRoot) {
  const manifestPath = join(outputRoot, ".vite", "manifest.json");
  const workerPath = join(outputRoot, "sw.js");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const selected = Object.entries(manifest)
    .filter(([key, value]) => key === "index.html"
      || key.endsWith("/browser-automation-page.tsx")
      || key.endsWith("/aigc-workbench-page.tsx")
      || key.endsWith("/aigc-channels-page.tsx")
      || value.isEntry)
    .map(([key]) => key);
  if (!selected.some((key) => key.endsWith("/browser-automation-page.tsx"))) throw new Error("Vite manifest 缺少浏览器配置页分包");
  if (!selected.some((key) => key.endsWith("/aigc-workbench-page.tsx"))) throw new Error("Vite manifest 缺少 AIGC 工作台分包");
  if (!selected.some((key) => key.endsWith("/aigc-channels-page.tsx"))) throw new Error("Vite manifest 缺少 AIGC 渠道页分包");
  const assets = new Set();
  const visited = new Set();
  const visit = (key) => {
    if (visited.has(key)) return;
    visited.add(key);
    const entry = manifest[key];
    if (!entry || typeof entry.file !== "string") throw new Error(`Vite manifest 引用不存在: ${key}`);
    assets.add(`/${entry.file}`);
    for (const css of entry.css ?? []) assets.add(`/${css}`);
    // 只递归静态 imports；主入口的其他懒加载页面不属于浏览器配置页离线范围。
    for (const imported of entry.imports ?? []) visit(imported);
  };
  selected.forEach(visit);
  const source = await readFile(workerPath, "utf8");
  if (!source.includes(PLACEHOLDER)) throw new Error("Service Worker 缺少唯一预缓存占位符");
  if (source.indexOf(PLACEHOLDER) !== source.lastIndexOf(PLACEHOLDER)) throw new Error("Service Worker 预缓存占位符不唯一");
  const temporaryPath = `${workerPath}.tmp`;
  await writeFile(temporaryPath, source.replace(PLACEHOLDER, JSON.stringify([...assets].sort())), "utf8");
  await rename(temporaryPath, workerPath);
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (entryPath === fileURLToPath(import.meta.url)) {
  await injectPwaPrecache(resolve("dist/web"));
}
