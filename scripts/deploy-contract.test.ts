import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const script = resolve("scripts/deploy.sh");

describe("部署脚本模式选择", () => {
  it.each([
    ["core", "docker compose --env-file .env -f compose.yaml up -d --build --remove-orphans"],
    ["search", "docker compose --env-file .env -f compose.yaml -f compose.search.yaml up -d --build --remove-orphans"],
    ["vector", "docker compose --env-file .env -f compose.yaml -f compose.vector.yaml up -d --build --remove-orphans"],
    ["full", "docker compose --env-file .env -f compose.yaml -f compose.search.yaml -f compose.vector.yaml up -d --build --remove-orphans"],
  ])("为 %s 选择唯一的 Compose 组合", (mode, expected) => {
    const output = execFileSync("bash", [script, mode, "--dry-run"], { encoding: "utf8" });

    expect(output.trim()).toBe(expected);
  });

  it("不指定模式时使用核心部署", () => {
    const output = execFileSync("bash", [script, "--dry-run"], { encoding: "utf8" });

    expect(output.trim()).toBe("docker compose --env-file .env -f compose.yaml up -d --build --remove-orphans");
  });

  it("拒绝未知部署模式", () => {
    const result = spawnSync("bash", [script, "unknown", "--dry-run"], { encoding: "utf8" });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("core|search|vector|full");
  });
});
