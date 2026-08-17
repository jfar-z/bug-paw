import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 检查生产构建的 JavaScript 与分层 CSS 预算。
 *
 * CSS 页面预算只计算相对应用入口新增的静态依赖，避免公共样式重复计费。
 */
export async function checkBundle(root = process.cwd()) {
  const budget = JSON.parse(await readFile(resolve(root, "config/bundle-budget.json"), "utf8"));
  const manifest = JSON.parse(await readFile(resolve(root, "dist/web/.vite/manifest.json"), "utf8"));
  const measured = new Map();

  async function gzipBytes(file) {
    if (!measured.has(file)) {
      measured.set(file, gzipSync(await readFile(resolve(root, "dist/web", file))).byteLength);
    }
    return measured.get(file);
  }

  const violations = [];
  const visited = new Set();
  const active = new Set();
  const path = [];

  function visitImports(name) {
    if (active.has(name)) {
      const cycle = [...path.slice(path.indexOf(name)), name];
      violations.push(`Chunk 循环依赖: ${cycle.join(" -> ")}`);
      return;
    }
    if (visited.has(name)) return;
    visited.add(name);
    active.add(name);
    path.push(name);
    for (const imported of manifest[name]?.imports ?? []) visitImports(imported);
    path.pop();
    active.delete(name);
  }

  for (const name of Object.keys(manifest)) visitImports(name);

  for (const [name, entry] of Object.entries(manifest)) {
    if (!entry.file?.endsWith(".js")) continue;
    const bytes = await gzipBytes(entry.file);
    const limit = entry.isEntry ? budget.entryJsGzipBytes : budget.lazyChunkGzipBytes;
    if (bytes > limit) violations.push(`${name}: ${bytes} > ${limit} bytes gzip`);
  }

  /** 递归收集指定 Manifest 入口的静态 CSS 依赖。 */
  function collectStaticCss(name, cssFiles = new Set(), seen = new Set()) {
    if (seen.has(name)) return cssFiles;
    seen.add(name);
    const entry = manifest[name];
    if (!entry) return cssFiles;
    for (const file of entry.css ?? []) cssFiles.add(file);
    for (const imported of entry.imports ?? []) collectStaticCss(imported, cssFiles, seen);
    return cssFiles;
  }

  async function sumGzipBytes(files) {
    return (await Promise.all([...files].map(gzipBytes))).reduce((sum, bytes) => sum + bytes, 0);
  }

  const entryNames = Object.entries(manifest)
    .filter(([, entry]) => entry.isEntry)
    .map(([name]) => name);
  const entryCssFiles = new Set();
  for (const name of entryNames) collectStaticCss(name, entryCssFiles);
  const entryCssBytes = await sumGzipBytes(entryCssFiles);
  if (entryCssBytes > budget.css.entryGzipBytes) {
    violations.push(`CSS 首屏: ${entryCssBytes} > ${budget.css.entryGzipBytes} bytes gzip`);
  }

  const allCssFiles = new Set(Object.values(manifest).flatMap((entry) => entry.css ?? []));
  const totalCssBytes = await sumGzipBytes(allCssFiles);
  if (totalCssBytes > budget.css.totalGzipBytes) {
    violations.push(`CSS 总量: ${totalCssBytes} > ${budget.css.totalGzipBytes} bytes gzip`);
  }

  const routes = [];
  for (const [name, routeBudget] of Object.entries(budget.css.routes ?? {})) {
    if (!manifest[name]) {
      violations.push(`CSS 页面入口缺失: ${routeBudget.label} (${name})`);
      continue;
    }
    const routeCssFiles = collectStaticCss(name);
    const incrementalCssFiles = new Set([...routeCssFiles].filter((file) => !entryCssFiles.has(file)));
    const bytes = await sumGzipBytes(incrementalCssFiles);
    routes.push({ name, label: routeBudget.label, bytes, limit: routeBudget.gzipBytes });
    if (bytes > routeBudget.gzipBytes) {
      violations.push(`CSS 页面 ${routeBudget.label}: ${bytes} > ${routeBudget.gzipBytes} bytes gzip`);
    }
  }

  return {
    violations,
    measuredChunks: measured.size,
    css: {
      entryBytes: entryCssBytes,
      entryLimit: budget.css.entryGzipBytes,
      totalBytes: totalCssBytes,
      totalLimit: budget.css.totalGzipBytes,
      routes,
    },
  };
}

/** 输出适合 CI 日志阅读的门禁结果。 */
function printResult(result) {
  if (result.violations.length > 0) {
    result.violations.forEach((violation) => console.error(`Bundle 门禁失败: ${violation}`));
    process.exitCode = 1;
    return;
  }
  const routeSummary = result.css.routes
    .map((route) => `${route.label} ${route.bytes}/${route.limit}`)
    .join("，");
  console.log(
    `Bundle 预算通过：入口与懒加载块 ${result.measuredChunks} 个，`
    + `CSS 首屏 ${result.css.entryBytes}/${result.css.entryLimit} bytes gzip，`
    + `总量 ${result.css.totalBytes}/${result.css.totalLimit} bytes gzip`
    + (routeSummary ? `，页面 ${routeSummary} bytes gzip` : ""),
  );
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (entryPath === fileURLToPath(import.meta.url)) {
  printResult(await checkBundle());
}
