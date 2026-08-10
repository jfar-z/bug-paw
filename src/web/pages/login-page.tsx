import { ArrowRight, BookOpen, Eye, EyeOff, HardDrive, LockKeyhole, Wifi, Wrench } from "lucide-react";
import { useState } from "react";
import { ProductMark } from "../components/product-mark";

interface LoginPageProps {
  onLogin?: (password: string, remember: boolean) => Promise<void>;
}

/**
 * 展示 BugPaw 品牌登录入口，并提交单密码认证请求。
 */
export function LoginPage({ onLogin }: LoginPageProps) {
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submitLogin = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!onLogin || submitting) return;
    const data = new FormData(event.currentTarget);
    setError("");
    setSubmitting(true);
    try {
      await onLogin(String(data.get("password") ?? ""), remember);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "登录失败，请稍后重试。");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="login-page">
      <section className="login-brand-panel" aria-labelledby="login-brand-title">
        <div className="login-brand-top">
          <div>
            <ProductMark />
            <span className="brand-subtitle">YOUR AI AGENT · BUILT FOR DEVELOPERS</span>
          </div>
          <span className="private-state"><i aria-hidden="true" /> private by default</span>
        </div>

        <div className="hero-copy">
          <span className="hero-kicker">Built for developers</span>
          <h1 id="login-brand-title">让聪明的爪印，<br />留在你的代码里。</h1>
          <p>一个理解上下文、会使用工具，也能持续积累知识的本地 Agent 工作台。</p>
          <div className="hero-points" aria-label="产品特性">
            <span><HardDrive size={16} aria-hidden="true" /><strong>本地优先</strong></span>
            <span><Wrench size={16} aria-hidden="true" /><strong>工具原生</strong></span>
            <span><BookOpen size={16} aria-hidden="true" /><strong>知识增强</strong></span>
          </div>
        </div>

        <img
          className="hero-art"
          src="/brand/bugpaw/bugpaw-og-hero.png"
          alt="BUG 猫咪与 BugPaw 品牌像素插画"
        />

        <div className="login-brand-bottom">
          <span>BugPaw v0.1</span>
          <span>Made with a cat named BUG.</span>
        </div>
      </section>

      <section className="login-form-panel" aria-labelledby="login-title">
        <div className="login-form-wrap">
          <div className="mobile-brand">
            <ProductMark compact />
            <span className="brand-subtitle">YOUR AI AGENT · BUILT FOR DEVELOPERS</span>
          </div>

          <div className="login-heading">
            <span>Welcome back</span>
            <h2 id="login-title">回到你的工作区</h2>
            <p className="login-intro">输入访问密码，继续和 BugPaw 一起工作。</p>
          </div>

          <form className="login-form" onSubmit={submitLogin}>
            <label className="login-field">
              <span>访问密码</span>
              <span className="password-field">
                <input
                  name="password"
                  type={passwordVisible ? "text" : "password"}
                  autoComplete="current-password"
                  required
                />
                <button
                  type="button"
                  aria-label={passwordVisible ? "隐藏密码" : "显示密码"}
                  onClick={() => setPasswordVisible((visible) => !visible)}
                >
                  {passwordVisible ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
                </button>
              </span>
            </label>

            <div className="remember-row">
              <label>
                <input
                  name="remember"
                  type="checkbox"
                  checked={remember}
                  onChange={(event) => setRemember(event.currentTarget.checked)}
                />
                <span>保持登录</span>
              </label>
            </div>

            <button className="login-submit" type="submit" disabled={submitting}>
              {submitting ? "正在进入…" : "进入 BugPaw"}
              <ArrowRight size={18} aria-hidden="true" />
            </button>
          </form>

          {error ? <p className="login-error" role="alert">{error}</p> : null}

          <div className="login-security" id="login-security">
            <LockKeyhole size={17} aria-hidden="true" />
            <span><strong><Wifi size={13} aria-hidden="true" />连接到本地服务</strong>访问凭据不会离开当前部署环境。</span>
          </div>
        </div>

        <footer>© 2026 BugPaw <span>·</span> 私有部署工作台</footer>
      </section>
    </main>
  );
}
