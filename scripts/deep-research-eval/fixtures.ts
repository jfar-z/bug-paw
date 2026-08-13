import { getEvaluationCase, type EvaluationCase, type EvaluationPage } from "./cases";

/** 搜索夹具返回值，故意不包含评测器的来源链标准答案。 */
export interface SearchFixtureResult {
  query: string;
  results: EvaluationCase["results"];
}

/** 页面读取夹具返回值。 */
export type PageFixture = EvaluationPage;

/**
 * 返回稳定排序的候选摘要，同时保留查询以便审阅研究轨迹。
 *
 * @param caseId 案例标识
 * @param query 模型发出的查询
 */
export function searchFixture(caseId: string, query: string): SearchFixtureResult {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) throw new Error("评测查询不能为空");
  return { query: normalizedQuery, results: getEvaluationCase(caseId).results };
}

/**
 * 读取当前案例拥有的完整页面，拒绝跨案例地址。
 *
 * @param caseId 案例标识
 * @param url 模型选择读取的页面地址
 */
export function readFixture(caseId: string, url: string): PageFixture {
  const page = getEvaluationCase(caseId).pages[url];
  if (!page) throw new Error(`评测页面不存在：${url}`);
  return page;
}
