/** 局域网 HTTP 也可生成随机请求键，不依赖仅安全上下文支持的 randomUUID。 */
export function workflowClientId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
