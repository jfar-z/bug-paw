#!/usr/bin/env bash
set -euo pipefail

# 选择唯一的 Compose 组合，默认只部署核心服务。
deployment_mode="core"
dry_run="false"
for deployment_arg in "$@"; do
  case "$deployment_arg" in
    core|search|vector|full)
      deployment_mode="$deployment_arg"
      ;;
    --dry-run)
      dry_run="true"
      ;;
    *)
      printf '用法: %s [core|search|vector|full] [--dry-run]\n' "$0" >&2
      exit 2
      ;;
  esac
done

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
project_dir=$(cd "$script_dir/.." && pwd -P)
cd "$project_dir"

compose_args=(--env-file .env -f compose.yaml)
case "$deployment_mode" in
  search)
    compose_args+=(-f compose.search.yaml)
    ;;
  vector)
    compose_args+=(-f compose.vector.yaml)
    ;;
  full)
    compose_args+=(-f compose.search.yaml -f compose.vector.yaml)
    ;;
esac

deploy_args=(docker compose "${compose_args[@]}" up -d --build --remove-orphans)
if [ "$dry_run" = "true" ]; then
  printf '%s' "${deploy_args[0]}"
  for deploy_arg in "${deploy_args[@]:1}"; do printf ' %s' "$deploy_arg"; done
  printf '\n'
  exit 0
fi

if ! command -v docker >/dev/null 2>&1; then
  printf '未找到 Docker，请先安装 Docker Engine 或 Docker Desktop。\n' >&2
  exit 1
fi
docker compose version >/dev/null
docker info >/dev/null

# 只在首次部署时创建环境文件，绝不覆盖部署者已有的设置。
if [ ! -f .env ]; then
  cp .env.example .env
  chmod 600 .env
  printf '已从 .env.example 创建 .env。\n'
fi

if [ "$deployment_mode" = "search" ] || [ "$deployment_mode" = "full" ]; then
  searxng_secret=$(sed -n 's/^SEARXNG_SECRET=//p' .env | tail -n 1)
  if [ -z "$searxng_secret" ]; then
    if ! command -v openssl >/dev/null 2>&1; then
      printf '搜索部署需要 SEARXNG_SECRET；请在 .env 中填写强随机值。\n' >&2
      exit 1
    fi
    generated_secret=$(openssl rand -hex 32)
    temporary_env=$(mktemp "${project_dir}/.env.XXXXXX")
    awk -v secret="$generated_secret" '
      BEGIN { replaced = 0 }
      /^SEARXNG_SECRET=/ && replaced == 0 { print "SEARXNG_SECRET=" secret; replaced = 1; next }
      { print }
      END { if (replaced == 0) print "SEARXNG_SECRET=" secret }
    ' .env > "$temporary_env"
    chmod 600 "$temporary_env"
    mv "$temporary_env" .env
    printf '已为 SearXNG 生成本机部署密钥。\n'
  fi
fi

docker compose "${compose_args[@]}" config --quiet
docker compose "${compose_args[@]}" up -d --build --remove-orphans

# 等待容器健康状态，避免启动命令成功但应用尚不可用。
web_container_id=$(docker compose "${compose_args[@]}" ps -q bug-paw-web)
if [ -z "$web_container_id" ]; then
  printf '未找到 bug-paw-web 容器。\n' >&2
  exit 1
fi

for health_attempt in $(seq 1 45); do
  web_health=$(docker inspect --format '{{.State.Health.Status}}' "$web_container_id" 2>/dev/null || true)
  if [ "$web_health" = "healthy" ]; then
    published_endpoint=$(docker compose "${compose_args[@]}" port bug-paw-web 7080)
    published_port=${published_endpoint##*:}
    curl --fail --silent --show-error "http://127.0.0.1:${published_port}/healthz" >/dev/null
    printf 'BugPaw %s 部署已通过健康检查。\n' "$deployment_mode"
    exit 0
  fi
  if [ "$web_health" = "unhealthy" ]; then
    printf 'bug-paw-web 健康检查失败。\n' >&2
    exit 1
  fi
  sleep 2
done

printf '等待 bug-paw-web 健康状态超时。\n' >&2
exit 1
