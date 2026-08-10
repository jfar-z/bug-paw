import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export interface ArchitectureViolation {
  file: string;
  rule: string;
  message: string;
}

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);
const LEGACY_STATE_FILES = [
  "config.json",
  "agent-order.json",
  "session-metadata.json",
  "scheduled-tasks.json",
  "knowledge-bases.json",
  "knowledge-bindings.json",
] as const;

/** 扫描生产源码的依赖方向和数据所有权，返回可供测试断言的稳定违规清单。 */
export function checkArchitecture(root: string): ArchitectureViolation[] {
  const sourceRoot = resolve(root, "src");
  const files = walk(sourceRoot).filter((file) => SOURCE_EXTENSIONS.has(extname(file)) && !file.includes(".test."));
  return files.flatMap((file) => inspectFile(sourceRoot, file));
}

function inspectFile(sourceRoot: string, absoluteFile: string): ArchitectureViolation[] {
  const file = relative(sourceRoot, absoluteFile).split(sep).join("/");
  const source = readFileSync(absoluteFile, "utf8");
  const imports = [...source.matchAll(/import\s+(?:type\s+)?[^;]*?from\s+["']([^"']+)["']/gu)].map((match) => match[1]);
  const violations: ArchitectureViolation[] = [];
  if (file.startsWith("web/") && imports.some((specifier) => specifier.includes("/server/") || specifier.startsWith("../server"))) {
    violations.push({ file, rule: "WEB_SERVER_BOUNDARY", message: "Web 不得导入 Server 实现" });
  }
  if (file.startsWith("web/") && file !== "web/api.ts" && /\bfetch\s*\(/u.test(source)) {
    violations.push({ file, rule: "WEB_API_CLIENT_BOUNDARY", message: "Web 网络请求必须通过统一 API Client" });
  }
  if (file.startsWith("shared/") && imports.some((specifier) => /(?:server|web)|^(?:node:|fastify|react)/u.test(specifier))) {
    violations.push({ file, rule: "SHARED_PORTABILITY", message: "Shared 只能包含跨端可移植契约" });
  }
  if (file.startsWith("server/routes/")
    && !file.endsWith("auth.ts")
    && !file.endsWith("setup.ts")
    && imports.some((specifier) => specifier.includes("/database/"))) {
    violations.push({ file, rule: "ROUTE_DATABASE_BOUNDARY", message: "Route 不得直接依赖数据库实现" });
  }
  if (source.includes(".prepare(") && !file.startsWith("server/database/")) {
    violations.push({ file, rule: "SQL_OWNERSHIP", message: "SQL 只能由 Database/Repository 层执行" });
  }
  if ((file === "server/main.ts" || (file.startsWith("server/routes/") && file !== "server/routes/http.ts"))
    && /\.send\(\s*\{\s*error\s*:/u.test(source)) {
    violations.push({ file, rule: "API_ERROR_BOUNDARY", message: "API 错误必须通过统一错误出口并使用共享错误码" });
  }
  if (LEGACY_STATE_FILES.some((name) => source.includes(name))) {
    violations.push({ file, rule: "LEGACY_STATE_OWNERSHIP", message: "不得重新引入已由 SQLite 接管的旧 JSON 状态文件" });
  }
  return violations;
}

function walk(directory: string): string[] {
  if (!statSync(directory).isDirectory()) return [];
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function main(): void {
  const root = resolve(process.cwd());
  const violations = checkArchitecture(root);
  if (violations.length === 0) {
    console.log("架构边界检查通过");
    return;
  }
  violations.forEach((violation) => console.error(`${violation.file}: [${violation.rule}] ${violation.message}`));
  process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main();
