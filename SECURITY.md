# 安全策略 / Security Policy

## 中文

BugPaw 能执行命令、读写持久化工作区并代表部署者调用外部模型和网站，因此安全问题可能影响凭证和用户数据。

请优先使用 GitHub 仓库 **Security → Report a vulnerability** 的私密漏洞报告功能联系维护者。如果该入口暂不可用，可以创建一个不包含漏洞细节的公开 Issue，请求维护者提供私密沟通渠道。报告应包含受影响版本、部署模式、影响、最小复现步骤和建议修复方向，但不得附带真实密钥或第三方个人数据。

在维护者确认修复并同意披露前，请勿公开可利用细节。普通配置问题、无法复现的可用性问题和不涉及安全边界的功能建议可以提交公开 Issue。

当前支持范围：

| 版本 | 是否支持安全更新 |
| --- | --- |
| `0.1.x` | 是 |
| `< 0.1.0` | 否 |

项目目前由个人维护，将尽力在 7 天内确认收到有效报告，并在完成影响评估后同步修复计划；复杂问题可能需要更长时间。

## English

BugPaw can execute commands, read and write persistent workspaces, and access external models and websites on behalf of its operator. Security issues may therefore affect credentials and user data.

Use **Security → Report a vulnerability** in the GitHub repository to contact the maintainers privately. If private reporting is temporarily unavailable, open a public issue without vulnerability details and ask for a private contact channel. Include the affected version, deployment mode, impact, minimal reproduction steps, and a suggested remediation direction. Never include real secrets or third-party personal data.

Do not publish exploitable details until maintainers confirm a fix and coordinate disclosure. Ordinary configuration questions, non-reproducible availability reports, and feature requests that do not cross a security boundary may use public issues.

Supported versions:

| Version | Security updates |
| --- | --- |
| `0.1.x` | Yes |
| `< 0.1.0` | No |

This is currently a personal-maintainer project. The maintainer aims to acknowledge valid reports within 7 days and share a remediation plan after assessing impact; complex issues may take longer.
