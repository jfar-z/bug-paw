import { execFileSync, spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = resolve("scripts/deploy.sh");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("部署脚本模式选择", () => {
  it.each([
    ["core", "docker compose --env-file .env -f compose.yaml up -d --build --remove-orphans"],
    ["search", "docker compose --env-file .env -f compose.yaml -f compose.search.yaml up -d --build --remove-orphans"],
    ["vector", "docker compose --env-file .env -f compose.yaml -f compose.vector.yaml up -d --build --remove-orphans"],
    ["browser", "docker compose --env-file .env -f compose.yaml -f compose.browser.yaml up -d --build --remove-orphans"],
    ["full", "docker compose --env-file .env -f compose.yaml -f compose.search.yaml -f compose.vector.yaml -f compose.browser.yaml up -d --build --remove-orphans"],
  ])("为 %s 选择唯一的 Compose 组合", (mode, expected) => {
    const output = execFileSync("bash", [script, mode, "--dry-run"], { encoding: "utf8" });

    expect(output.trim()).toBe(expected);
  });

  it("浏览器模式原子生成 600 内部密钥且不打印内容", async () => {
    const deployment = await runDeploy("127.0.0.1", "7080", "browser", "BUG_PAW_DATA_DIR=./data\n");
    const tokenPath = join(deployment.root, "data", "app", "browser-internal-token");
    const token = (await readFile(tokenPath, "utf8")).trim();
    expect(token).toMatch(/^[a-f0-9]{64}$/u);
    expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);
    expect(deployment.stdout).not.toContain(token);
  });

  it("浏览器容器使用同一专用 UID 读取内部密钥", async () => {
    const dockerfile = await readFile(resolve("Dockerfile.browser"), "utf8");
    const deployScript = await readFile(script, "utf8");

    expect(dockerfile).toContain("RUN useradd --uid 1001 --create-home browser");
    expect(dockerfile).toContain("USER browser");
    expect(deployScript).toContain('chown 1001:1001 "$browser_token_file"');
  });

  it("Fake-IP 信任范围只传给实际执行地址校验的出口代理", async () => {
    const compose = await readFile(resolve("compose.browser.yaml"), "utf8");
    const worker = compose.match(/\n  browser-worker:\n[\s\S]*?(?=\n  browser-egress-proxy:)/u)?.[0] ?? "";
    const proxy = compose.match(/\n  browser-egress-proxy:\n[\s\S]*?(?=\nnetworks:)/u)?.[0] ?? "";

    expect(worker).not.toContain("BUG_PAW_BROWSER_TRUSTED_FAKE_IP_CIDRS");
    expect(proxy).toContain("BUG_PAW_BROWSER_TRUSTED_FAKE_IP_CIDRS");
  });

  it("不指定模式时使用核心部署", () => {
    const output = execFileSync("bash", [script, "--dry-run"], { encoding: "utf8" });

    expect(output.trim()).toBe("docker compose --env-file .env -f compose.yaml up -d --build --remove-orphans");
  });

  it("拒绝未知部署模式", () => {
    const result = spawnSync("bash", [script, "unknown", "--dry-run"], { encoding: "utf8" });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("core|search|vector|browser|full");
  });

  it.each([
    ["192.168.100.5", "7080", "http://192.168.100.5:7080/healthz"],
    ["0.0.0.0", "7081", "http://127.0.0.1:7081/healthz"],
  ])("从 .env 读取 %s 的健康检查地址", async (bindAddress, port, expectedUrl) => {
    const { health } = await runDeploy(bindAddress, port);

    expect(health).toContain(expectedUrl);
  });
});

/** 在隔离目录中运行脚本，并记录模拟 curl 收到的健康检查地址。 */
async function runDeploy(bindAddress: string, port: string, mode = "core", extraEnv = ""): Promise<{ root: string; health: string; stdout: string }> {
  const root = await mkdtemp(join(tmpdir(), "bugpaw-deploy-"));
  roots.push(root);
  const bin = join(root, "bin");
  const log = join(root, "health-url.log");
  await mkdir(join(root, "scripts"), { recursive: true });
  await mkdir(bin, { recursive: true });
  await copyFile(script, join(root, "scripts", "deploy.sh"));
  await writeFile(join(root, ".env"), `BUG_PAW_BIND_ADDRESS=${bindAddress}\nBUG_PAW_PORT=${port}\n${extraEnv}`, "utf8");
  await writeFile(join(bin, "docker"), `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "info" ]; then exit 0; fi
if [ "$1" = "inspect" ]; then printf 'healthy\\n'; exit 0; fi
if [ "$1" = "compose" ]; then
  for arg in "$@"; do
    if [ "$arg" = "ps" ]; then printf 'test-web\\n'; exit 0; fi
  done
  exit 0
fi
exit 1
`, "utf8");
  await writeFile(join(bin, "curl"), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$HEALTH_URL_LOG"
`, "utf8");
  await writeFile(join(bin, "openssl"), `#!/usr/bin/env bash
set -euo pipefail
printf '%064d\n' 0
`, "utf8");
  await chmod(join(root, "scripts", "deploy.sh"), 0o755);
  await chmod(join(bin, "docker"), 0o755);
  await chmod(join(bin, "curl"), 0o755);
  await chmod(join(bin, "openssl"), 0o755);

  const result = spawnSync("bash", [join(root, "scripts", "deploy.sh"), mode], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HEALTH_URL_LOG: log },
  });

  expect(result.status, result.stderr).toBe(0);
  const health = await readFile(log, "utf8");
  return { root, health, stdout: result.stdout };
}
