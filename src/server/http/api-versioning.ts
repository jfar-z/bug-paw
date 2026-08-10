import type { FastifyInstance } from "fastify";

const LEGACY_API_PREFIX = "/api/";
const CURRENT_API_PREFIX = "/api/v1/";

/**
 * 在路由注册阶段统一挂载当前 API 版本，避免各业务模块自行拼接版本前缀。
 */
export function registerApiV1Namespace(app: FastifyInstance): void {
  app.addHook("onRoute", (route) => {
    if (route.url.startsWith(LEGACY_API_PREFIX) && !route.url.startsWith(CURRENT_API_PREFIX)) {
      route.url = `${CURRENT_API_PREFIX}${route.url.slice(LEGACY_API_PREFIX.length)}`;
    }
  });
}
