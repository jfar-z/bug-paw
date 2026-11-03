/** 待运行任务保存已校验参数、定义指纹和工作区文件指纹，不保存凭据。 */
export interface TaskPreparation {
  /** 已应用默认值的参数；媒体保留工作区相对路径。 */
  values: Record<string, unknown>;
  /** 创建时完整业务定义的 SHA-256，用于拒绝执行前的配置变化。 */
  definitionHash: string;
  /** 工作区相对路径对应的内容与媒体元数据指纹。 */
  files: Record<string, string>;
}
