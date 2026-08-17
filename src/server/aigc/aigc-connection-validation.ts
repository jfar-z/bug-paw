import type { AigcChannelConfig } from "../../shared/aigc-contracts";

interface AigcConnectionTestResult {
  ok: boolean;
  message: string;
}

type RequestFunction = typeof fetch;

/** 只验证地址可达与凭证有效，不向客户端回显任何认证细节。 */
export class AigcConnectionValidation {
  /**
   * @param request 可注入的请求函数，便于隔离外部服务测试
   */
  constructor(private readonly request: RequestFunction = fetch) {}

  /** 按协议探测渠道健康状态。 */
  async test(channel: AigcChannelConfig, apiKey?: string): Promise<AigcConnectionTestResult> {
    const url = channel.type === "comfyui"
      ? `${channel.baseUrl}/system_stats`
      : `${channel.baseUrl}/models`;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (channel.type !== "comfyui" || apiKey) {
      headers.Authorization = `Bearer ${apiKey ?? ""}`;
    }

    try {
      const response = await this.request(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(Math.max(1_000, channel.timeoutMs)),
      });
      if (response.ok) return { ok: true, message: "渠道连接正常" };
      const status = response.status;
      if (status === 401 || status === 403) return { ok: false, message: "服务可达但凭证校验失败" };
      return { ok: false, message: `上游服务返回 ${status}` };
    } catch {
      return { ok: false, message: "渠道当前不可用，请检查地址和网络" };
    }
  }
}
