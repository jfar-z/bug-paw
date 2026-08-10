import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { resolve } from "node:path";

const root = process.cwd();
const budget = JSON.parse(await readFile(resolve(root, "config/bundle-budget.json"), "utf8"));
const manifest = JSON.parse(await readFile(resolve(root, "dist/web/.vite/manifest.json"), "utf8"));
const measured = new Map();

async function gzipBytes(file) {
  if (!measured.has(file)) measured.set(file, gzipSync(await readFile(resolve(root, "dist/web", file))).byteLength);
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
const cssFiles = [...new Set(Object.values(manifest).flatMap((entry) => entry.css ?? []))];
const cssBytes = (await Promise.all(cssFiles.map(gzipBytes))).reduce((sum, bytes) => sum + bytes, 0);
if (cssBytes > budget.cssGzipBytes) violations.push(`CSS: ${cssBytes} > ${budget.cssGzipBytes} bytes gzip`);

if (violations.length > 0) {
  violations.forEach((violation) => console.error(`Bundle 门禁失败: ${violation}`));
  process.exitCode = 1;
} else {
  console.log(`Bundle 预算通过：入口与懒加载块 ${measured.size} 个，CSS ${cssBytes} bytes gzip`);
}
