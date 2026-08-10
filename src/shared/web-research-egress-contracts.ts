/** 联网请求可使用的部署侧出口类型。 */
export type WebResearchEgressKind = "direct" | "fake-ip" | "http-proxy";

/** 仅在服务端内存中使用的完整出口配置。 */
export type WebResearchEgressProfile =
  | { id: "direct"; label: string; kind: "direct" }
  | { id: string; label: string; kind: "fake-ip"; fakeIpCidrs: string[] }
  | { id: string; label: string; kind: "http-proxy"; proxyUrl: string };

/** 可安全返回给配置中心的出口配置摘要。 */
export interface WebResearchEgressProfileSummary {
  id: string;
  label: string;
  kind: WebResearchEgressKind;
  available: boolean;
}
