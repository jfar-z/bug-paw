# 贡献指南 / Contributing Guide

## 中文

感谢你考虑为 BugPaw 做贡献。

1. 提交 Issue 前先搜索已有问题，并提供版本、部署模式、复现步骤、预期结果和脱敏日志。
2. Pull Request 应聚焦一个问题，说明行为变化，并为新功能或缺陷修复添加测试。
3. 不得提交 `.env`、生产数据、API Key、认证 Header、用户文件或包含身份信息的截图。
4. 使用 Node 24 容器运行 `npm run verify`，并验证受影响的 Compose 组合。
5. 提交说明使用简体中文，格式为 `feat: 提交说明` 或 `fix: 提交说明`。
6. 新增代码应包含必要的中文注释，不使用行尾注释。

安全问题不要提交公开 Issue，请遵循 [SECURITY.md](SECURITY.md)。

## English

Thank you for considering a contribution to BugPaw.

1. Search existing issues first. Include the version, deployment mode, reproduction steps, expected behavior, and sanitized logs.
2. Keep each pull request focused, explain behavior changes, and add tests for features and fixes.
3. Never submit `.env`, production data, API keys, authentication headers, user files, or screenshots containing personal information.
4. Run `npm run verify` in a Node 24 container and validate affected Compose combinations.
5. Commit messages follow the repository convention: `feat: 简体中文说明` or `fix: 简体中文说明`.
6. New code includes necessary Chinese comments and avoids end-of-line comments.

Do not open public issues for vulnerabilities. Follow [SECURITY.md](SECURITY.md).
