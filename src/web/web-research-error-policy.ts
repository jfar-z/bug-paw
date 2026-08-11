import type { ApiTaskPolicy } from "./api-task-provider";

/** 将联网搜索配置和凭证的可恢复业务错误保留在当前表单。 */
export function webResearchExpected(setError: (message: string) => void): ApiTaskPolicy["expected"] {
  const show = (error: { message: string }) => setError(error.message);
  return {
    VERSION_CONFLICT: show,
    VALIDATION_FAILED: show,
    INVALID_CREDENTIAL: show,
    CREDENTIAL_NOT_FOUND: show,
    INVALID_PROVIDER_ID: show,
    INVALID_PROVIDER_REQUEST: show,
    INVALID_PROVIDER_BASE_URL: show,
    PROVIDER_ID_EXISTS: show,
    PROVIDER_INVALID: show,
    PROVIDER_NOT_FOUND: show,
    UNSUPPORTED_PROVIDER_API: show,
  };
}
