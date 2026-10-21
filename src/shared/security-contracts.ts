/** 工作台双因素认证只公开状态，不包含绑定密钥或恢复码摘要。 */
export interface SecurityStatus {
  enabled: boolean;
  enabledAt: string | null;
  recoveryCodesRemaining: number;
}

/** 绑定信息只在当前会话短期展示，禁止写入浏览器缓存。 */
export interface TotpSetup {
  secret: string;
  qrCode: string;
  expiresAt: string;
}

/** 密码通过后可能仍需完成第二因素，不可据此进入工作台。 */
export type LoginResponse = { authenticated: true } | {
  authenticated: false;
  requiresTwoFactor: true;
  expiresAt: string;
};

/** 关闭或重新生成恢复码时必须重新验证两项凭据。 */
export interface SecurityProof {
  password: string;
  code: string;
  recovery?: boolean;
}
