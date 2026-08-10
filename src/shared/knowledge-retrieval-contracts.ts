/** 可安全返回给浏览器的单一 Embedding 配置。 */
export interface EmbeddingConfigSummary {
  baseUrl: string;
  model: string;
  batchSize: number;
  hasApiKey: boolean;
  /** 是否为部署随附且无需管理员配置密钥的内部服务。 */
  isManaged: boolean;
  /** 是否在资料上传和查询时启用语义向量检索。 */
  enabled: boolean;
}

/** 浏览器提交的 Embedding 配置字段。 */
export interface EmbeddingConfigInput {
  baseUrl: string;
  model: string;
  batchSize: number;
  /** 空字符串表示更新时保留已保存的密钥。 */
  apiKey: string;
  /** 是否在资料上传和查询时启用语义向量检索。 */
  enabled: boolean;
}

/** 带乐观锁版本的 Embedding 配置文档。 */
export interface EmbeddingSettingsDocument {
  revision: string;
  config?: EmbeddingConfigSummary;
}
