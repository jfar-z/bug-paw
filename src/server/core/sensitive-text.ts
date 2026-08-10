/**
 * 对不可信文本执行保守秘密清洗并限制 Unicode 字符数。
 *
 * 网络错误与 Provider 响应都可能回显请求头、URL 凭证或自定义 Token，必须先清洗再返回浏览器。
 *
 * @param value 原始不可信文本
 * @param maxCharacters 返回的最大 Unicode 字符数
 */
export function redactSensitiveText(value: string, maxCharacters: number): string {
  const normalized = value.replace(/[\u0000-\u001F\u007F-\u009F]/gu, " ");
  const redacted = normalized
    .replace(/([a-z][a-z\d+.-]*:\/\/)[^/\s@]*@/giu, "$1[已隐藏]@")
    .replace(/\b(?:bearer|basic|token)\s+[A-Za-z\d._~+/=-]+/giu, "[已隐藏]")
    .replace(
      /([?&](?:api[_-]?key|access[_-]?token|auth|authorization|client[_-]?secret|credential|key|password|secret|signature|token)=)[^&#\s]*/giu,
      "$1[已隐藏]",
    )
    .replace(
      /(["']?(?:api[_ -]?key|access[_ -]?token|auth(?:orization)?|client[_ -]?secret|credential|cookie|password|proxy[_ -]?authorization|secret|set[_ -]?cookie|signature|token)["']?\s*[:=]\s*)["']?[^\s,;}&]+/giu,
      "[已隐藏]",
    );
  return Array.from(redacted).slice(0, maxCharacters).join("").trim();
}
