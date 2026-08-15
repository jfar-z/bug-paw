import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

interface ParsedStyleRule {
  selector: string;
  declarations: CSSStyleDeclaration;
}

/** 将样式表中的普通规则递归展开，便于验证浏览器实际可解析的声明。 */
function parseStyleRules(source: string): ParsedStyleRule[] {
  const style = document.createElement("style");
  style.textContent = source;
  document.head.append(style);
  const rules: ParsedStyleRule[] = [];

  const visit = (ruleList: CSSRuleList) => {
    for (const rule of ruleList) {
      if (rule instanceof CSSStyleRule) {
        rules.push({ selector: rule.selectorText, declarations: rule.style });
        continue;
      }
      if ("cssRules" in rule) {
        visit((rule as CSSGroupingRule).cssRules);
      }
    }
  };

  visit(style.sheet!.cssRules);
  style.remove();
  return rules;
}

function declaration(rules: ParsedStyleRule[], selector: string, property: string): string {
  const rule = rules.find((candidate) => candidate.selector === selector);
  return rule?.declarations.getPropertyValue(property).trim() ?? "";
}

/** 把十六进制颜色转换为 WCAG 相对亮度。 */
function relativeLuminance(hex: string): number {
  const channels = hex.slice(1).match(/../gu)?.map((value) => Number.parseInt(value, 16) / 255) ?? [];
  const [red = 0, green = 0, blue = 0] = channels.map((value) => (
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  ));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/** 计算两种不透明颜色之间的 WCAG 对比度。 */
function contrastRatio(foreground: string, background: string): number {
  const values = [relativeLuminance(foreground), relativeLuminance(background)]
    .sort((left, right) => right - left);
  return ((values[0] ?? 0) + 0.05) / ((values[1] ?? 0) + 0.05);
}

/** 从组合选择器中读取指定元素的样式声明。 */
function groupedDeclaration(rules: ParsedStyleRule[], selector: string, property: string): string {
  const rule = rules.find((candidate) => candidate.selector
    .split(",")
    .map((item) => item.trim())
    .includes(selector));
  return rule?.declarations.getPropertyValue(property).trim() ?? "";
}

/** 读取指定媒体查询中的普通样式声明。 */
function mediaDeclaration(source: string, condition: string, selector: string, property: string): string {
  const style = document.createElement("style");
  style.textContent = source;
  document.head.append(style);
  const rule = [...style.sheet!.cssRules]
    .filter((candidate): candidate is CSSMediaRule => candidate instanceof CSSMediaRule && candidate.conditionText === condition)
    .flatMap((media) => [...media.cssRules])
    .find((candidate): candidate is CSSStyleRule => candidate instanceof CSSStyleRule && candidate.selectorText === selector);
  const value = rule?.style.getPropertyValue(property).trim() ?? "";
  style.remove();
  return value;
}

describe("BugPaw 生产视觉合同", () => {
  it("三套主题使用已确认的语义画布和 BUG 硬阴影", async () => {
    const source = await readFile("src/web/bugpaw-theme.css", "utf8").catch(() => "");
    const rules = parseStyleRules(source);

    expect(declaration(rules, ':root[data-theme="dark"]', "--canvas")).toBe("#151517");
    expect(declaration(rules, ':root[data-theme="light"]', "--canvas")).toBe("#f7f6f2");
    expect(declaration(rules, ':root[data-theme="bug"]', "--canvas")).toBe("#ded2bf");
    expect(declaration(rules, ':root[data-theme="bug"]', "--shadow-pixel").replaceAll(" ", ""))
      .toBe("4px4px0#7a5a3a");
    expect(declaration(rules, ".product-mark__image", "width")).toBe("36px");
    expect(declaration(rules, ".bugpaw-auth-visual img", "object-fit")).toBe("contain");
  });

  it("暗色主题使用深海灰蓝色阶与猫眼绿状态信号", async () => {
    const [baseSource, themeSource] = await Promise.all([
      readFile("src/web/styles.css", "utf8"),
      readFile("src/web/bugpaw-theme.css", "utf8"),
    ]);
    const baseRules = parseStyleRules(baseSource);
    const themeRules = parseStyleRules(themeSource);
    const darkSelector = ':root[data-theme="dark"]';
    const expectedThemeTokens = new Map([
      ["--eye", "#a4c66d"],
      ["--canvas", "#151517"],
      ["--panel", "#1c1c1f"],
      ["--surface", "#24252a"],
      ["--surface-soft", "#2c2d32"],
      ["--surface-hover", "#34353a"],
      ["--text-primary", "#f4f1ec"],
      ["--text-secondary", "#b7bac2"],
      ["--text-tertiary", "#888d98"],
      ["--border", "#383940"],
      ["--border-strong", "#4a4d56"],
      ["--accent", "#5f6d8a"],
      ["--accent-strong", "#8190ad"],
      ["--accent-foreground", "var(--accent-strong)"],
      ["--accent-soft", "rgba(95,109,138,0.18)"],
      ["--danger", "#d77c78"],
      ["--focus", "#a4c66d"],
      ["--primary-bg", "#5f6d8a"],
      ["--primary-text", "#f7f5f1"],
      ["--rail", "#18191b"],
      ["--backdrop", "#0f0f11"],
    ]);

    for (const [property, expected] of expectedThemeTokens) {
      expect(declaration(themeRules, darkSelector, property), property).toBe(expected);
    }

    for (const property of [
      "--canvas", "--panel", "--surface", "--surface-soft", "--surface-hover",
      "--text-primary", "--text-secondary", "--text-tertiary", "--border",
      "--border-strong", "--accent", "--accent-strong", "--accent-foreground", "--accent-soft",
      "--danger", "--focus", "--primary-bg", "--primary-text",
    ]) {
      expect(declaration(baseRules, darkSelector, property), property)
        .toBe(expectedThemeTokens.get(property));
    }

    expect(contrastRatio("#f7f5f1", "#5f6d8a")).toBeGreaterThanOrEqual(4.5);
    for (const background of ["#151517", "#1c1c1f", "#24252a"]) {
      expect(contrastRatio("#8190ad", background), background).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrastRatio("#888d98", "#151517")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#a4c66d", "#151517")).toBeGreaterThanOrEqual(4.5);
    expect(declaration(baseRules, ":root", "--accent-foreground")).toBe("var(--accent)");
    expect(declaration(themeRules, ":root", "--accent-foreground")).toBe("var(--accent)");
    expect(declaration(baseRules, ".markdown-content a", "color")).toBe("var(--accent-foreground)");
  });

  it("暗色运行与成功状态消费猫眼绿而不是主要交互色", async () => {
    const [baseSource, themeSource] = await Promise.all([
      readFile("src/web/styles.css", "utf8"),
      readFile("src/web/bugpaw-theme.css", "utf8"),
    ]);
    const baseRules = parseStyleRules(baseSource);
    const rules = parseStyleRules(themeSource);
    const backgroundSelectors = [
      ':root[data-theme="dark"] .live-tool-card.is-preparing::before',
      ':root[data-theme="dark"] .live-tool-card.is-running::before',
      ':root[data-theme="dark"] .thinking-card.is-streaming::before',
      ':root[data-theme="dark"] .service-state i',
      ':root[data-theme="dark"] .agent-run-indicator::before',
      ':root[data-theme="dark"] .tool-output.is-live code > span::after',
      ':root[data-theme="dark"] .streaming-label i',
      ':root[data-theme="dark"] .status-dot',
      ':root[data-theme="dark"] .agent-card__title i',
      ':root[data-theme="dark"] .agent-detail-header__status i',
      ':root[data-theme="dark"] .private-state i',
    ];
    const colorSelectors = [
      ':root[data-theme="dark"] .session-refresh-hint .is-ready',
      ':root[data-theme="dark"] .session-row.is-opening .session-row__open svg',
      ':root[data-theme="dark"] .tool-status.is-running',
      ':root[data-theme="dark"] .spinner',
      ':root[data-theme="dark"] .tool-output.is-live code > span',
      ':root[data-theme="dark"] .streaming-label',
      ':root[data-theme="dark"] .scheduled-task-state.is-enabled',
      ':root[data-theme="dark"] .scheduled-task-runs li strong[data-status="completed"]',
      ':root[data-theme="dark"] .knowledge-base-status.is-indexed',
      ':root[data-theme="dark"] .task-log li[data-status="completed"]',
    ];

    for (const selector of backgroundSelectors) {
      expect(groupedDeclaration(rules, selector, "background"), selector).toBe("var(--eye)");
    }
    for (const selector of colorSelectors) {
      expect(groupedDeclaration(rules, selector, "color"), selector).toBe("var(--eye)");
    }
    expect(declaration(rules, ':root[data-theme="dark"] .scheduled-task-state.is-enabled', "border-color"))
      .toBe("color-mix(in srgb, var(--eye) 30%, var(--border))");
    expect(declaration(baseRules, ".private-state i", "background")).toBe("rgb(124, 194, 107)");
    expect(declaration(baseRules, ".private-state i", "box-shadow"))
      .toBe("0 0 0 4px rgba(124, 194, 107, 0.12)");
    expect(declaration(rules, ':root[data-theme="dark"] .private-state i', "box-shadow"))
      .toBe("0 0 0 4px color-mix(in srgb, var(--eye) 18%, transparent)");
  });

  it("暗色主要操作统一消费灰蓝按钮语义令牌", async () => {
    const source = await readFile("src/web/styles.css", "utf8");
    const rules = parseStyleRules(source);
    const selectors = [
      ':root[data-theme="dark"] .primary-button',
      ':root[data-theme="dark"] .send-button',
      ':root[data-theme="dark"] .mobile-entry-gate__enter',
    ];

    for (const selector of selectors) {
      expect(declaration(rules, selector, "color"), selector).toBe("var(--primary-text)");
      expect(declaration(rules, selector, "background"), selector).toBe("var(--primary-bg)");
    }
    expect(source).not.toContain("#102018");
  });

  it("三套主题为全部滚动区域提供统一的非原生滚动条", async () => {
    const [source, baseSource] = await Promise.all([
      readFile("src/web/bugpaw-theme.css", "utf8"),
      readFile("src/web/styles.css", "utf8"),
    ]);
    const rules = parseStyleRules(source);
    const baseRules = parseStyleRules(baseSource);

    expect(declaration(rules, ':root[data-theme="dark"]', "--scrollbar-track")).toBe("transparent");
    expect(declaration(rules, ':root[data-theme="light"]', "--scrollbar-track")).toBe("transparent");
    expect(declaration(rules, ':root[data-theme="bug"]', "--scrollbar-track")).toBe("var(--surface-soft)");
    expect(declaration(rules, ':root[data-theme="bug"]', "--scrollbar-thumb")).toBe("var(--tabby)");
    expect(declaration(rules, "*", "scrollbar-width")).toBe("thin");
    expect(declaration(rules, "*", "scrollbar-color")).toBe("var(--scrollbar-thumb) var(--scrollbar-track)");
    expect(declaration(rules, "::-webkit-scrollbar", "width")).toBe("8px");
    expect(declaration(rules, "::-webkit-scrollbar-thumb", "background")).toBe("var(--scrollbar-thumb)");
    expect(groupedDeclaration(baseRules, ".reference-composer__candidate-menu", "scrollbar-color")).toBe("");
  });

  it("会话整行悬停连续且输入区与三级文字保持清晰", async () => {
    const [baseSource, themeSource] = await Promise.all([
      readFile("src/web/styles.css", "utf8"),
      readFile("src/web/bugpaw-theme.css", "utf8"),
    ]);
    const baseRules = parseStyleRules(baseSource);
    const themeRules = parseStyleRules(themeSource);

    expect(declaration(baseRules, ".composer-dock", "background")).toBe("var(--canvas)");
    expect(declaration(themeRules, ':root[data-theme="dark"]', "--text-tertiary")).toBe("#888d98");
    expect(declaration(themeRules, ':root[data-theme="light"]', "--text-tertiary")).toBe("#596676");
    expect(declaration(themeRules, ':root[data-theme="bug"] .session-row:hover', "background")).toBe("rgb(89, 70, 52)");
    expect(declaration(themeRules, ':root[data-theme="bug"] .session-row:hover .session-row__open', "background")).toBe("transparent");
  });

  it("聊天容器使用动态视口高度，避免移动端输入区越过可视底部", async () => {
    const source = await readFile("src/web/styles.css", "utf8");
    const rules = parseStyleRules(source);

    expect(declaration(rules, ".chat-shell", "height")).toBe("100dvh");
  });

  it("用户消息正文不在气泡底部额外留白", async () => {
    const source = await readFile("src/web/styles.css", "utf8");
    const rules = parseStyleRules(source);

    expect(declaration(rules, ".is-user .message-content p", "margin-bottom")).toBe("0px");
  });

  it("会话输入区使用单一焦点框、可收缩底栏和多行消息排版", async () => {
    const source = await readFile("src/web/styles.css", "utf8");
    const rules = parseStyleRules(source);

    expect(declaration(rules, ".composer textarea:focus-visible", "outline")).toBe("none");
    expect(declaration(rules, ".reference-composer__footer", "display")).toBe("flex");
    expect(declaration(rules, ".reference-composer__footer", "gap")).toBe("8px");
    expect(declaration(rules, ".reference-composer__control-rail", "position")).toBe("static");
    expect(declaration(rules, ".reference-composer__control-rail", "min-width")).toBe("0px");
    expect(declaration(rules, ".reference-composer__control-rail", "flex")).toBe("1 1 auto");
    expect(declaration(rules, ".user-message-text", "white-space")).toBe("pre-wrap");
    expect(declaration(rules, ".user-message-text", "overflow-wrap")).toBe("anywhere");
    expect(declaration(rules, ".agent-turn-footer", "display")).toBe("flex");
    expect(declaration(rules, ".agent-turn-footer", "justify-content")).toBe("space-between");
    expect(declaration(rules, ".agent-turn-footer.message-actions--separated", "margin-top")).toBe("8px");
    expect(declaration(rules, ".agent-turn-footer.message-actions--separated", "padding-top")).toBe("6px");
    expect(declaration(rules, ".agent-turn-footer .agent-turn-activity-controls", "display")).toBe("flex");
    expect(mediaDeclaration(source, "(max-width: 760px)", ".composer-model-control", "flex"))
      .toBe("1 1 156px");
    expect(mediaDeclaration(source, "(max-width: 760px)", ".composer-model-trigger", "max-width"))
      .toBe("156px");
    expect(mediaDeclaration(source, "(max-width: 760px)", ".composer-model-trigger", "width"))
      .toBe("100%");
  });

  it("提问处理框保持触控目标和窄屏单列布局", async () => {
    const [source, themeSource] = await Promise.all([
      readFile("src/web/styles.css", "utf8"),
      readFile("src/web/bugpaw-theme.css", "utf8"),
    ]);
    const rules = parseStyleRules(source);
    const themeRules = parseStyleRules(themeSource);

    expect(declaration(rules, ".question-composer", "width")).toBe("min(100%, 790px)");
    expect(groupedDeclaration(rules, ".question-composer__footer button", "min-height")).toBe("44px");
    expect(declaration(rules, ".question-composer__question legend", "overflow-wrap")).toBe("anywhere");
    expect(mediaDeclaration(source, "(max-width: 760px)", ".question-composer__footer", "grid-template-columns")).toBe("1fr");
    expect(groupedDeclaration(themeRules, ".question-composer", "background")).toBe("var(--surface)");
  });

  it("BUG 主题的会话菜单和账户信息在深色侧栏中保持可读", async () => {
    const source = await readFile("src/web/bugpaw-theme.css", "utf8");
    const rules = parseStyleRules(source);

    expect(declaration(rules, ':root[data-theme="bug"] .session-actions__popover > button', "color"))
      .toBe("var(--text-primary)");
    expect(declaration(rules, ':root[data-theme="bug"] .session-actions__popover > button:hover:not(:disabled)', "background"))
      .toBe("var(--surface-hover)");
    expect(declaration(rules, ':root[data-theme="bug"] .session-actions__popover .is-danger', "color"))
      .toBe("color-mix(in srgb, var(--danger) 90%, var(--deep-brown))");
    expect(declaration(rules, ':root[data-theme="bug"] .chat-sidebar .account-button strong', "color"))
      .toBe("rgb(255, 249, 238)");
    expect(declaration(rules, ':root[data-theme="bug"] .chat-sidebar .account-button small', "color"))
      .toBe("rgb(222, 210, 191)");
  });

  it("BUG 主题二级导航选中态在深色侧栏中保持可读", async () => {
    const source = await readFile("src/web/bugpaw-theme.css", "utf8");
    const rules = parseStyleRules(source);
    const activeSelectors = [
      ':root[data-theme="bug"] .session-row.is-active',
      ':root[data-theme="bug"] .configuration-nav > button.is-active',
      ':root[data-theme="bug"] .workspace-agent-navigation nav button.is-active',
      ':root[data-theme="bug"] .knowledge-base-navigation nav button.is-active',
    ];

    for (const selector of activeSelectors) {
      expect(groupedDeclaration(rules, selector, "color")).toBe("rgb(255, 249, 238)");
      expect(groupedDeclaration(rules, selector, "background")).toBe("rgb(89, 70, 52)");
      expect(groupedDeclaration(rules, selector, "box-shadow")).toBe("inset 4px 0 0 var(--paw)");
    }

    for (const selector of [
      ':root[data-theme="bug"] .session-row.is-active .session-row__open',
      ':root[data-theme="bug"] .session-row.is-active .session-actions__trigger',
      ':root[data-theme="bug"] .configuration-nav > button.is-active small',
      ':root[data-theme="bug"] .workspace-agent-navigation nav button.is-active small',
      ':root[data-theme="bug"] .knowledge-base-navigation nav button.is-active small',
    ]) {
      expect(groupedDeclaration(rules, selector, "color")).toBe("inherit");
    }

    expect(declaration(rules, ':root[data-theme="bug"] .session-row.is-active .session-actions__trigger:hover', "background"))
      .toBe("rgb(122, 90, 58)");
    expect(declaration(rules, ':root[data-theme="bug"] .session-row.is-active .session-actions__trigger:hover', "color"))
      .toBe("rgb(255, 249, 238)");
  });

  it("五个二级侧边栏共用宽度与标题视觉合同", async () => {
    const [source, themeSource] = await Promise.all([
      readFile("src/web/styles.css", "utf8"),
      readFile("src/web/bugpaw-theme.css", "utf8"),
    ]);
    const rules = parseStyleRules(source);
    const themeRules = parseStyleRules(themeSource);

    expect(declaration(rules, ":root", "--secondary-sidebar-width")).toBe("272px");
    expect(declaration(rules, ".chat-shell", "grid-template-columns"))
      .toBe("var(--secondary-sidebar-width) minmax(0, 1fr)");
    expect(declaration(rules, ".configuration-shell", "grid-template-columns"))
      .toBe("var(--secondary-sidebar-width) minmax(0, 1fr)");
    expect(declaration(rules, ".workspace-resources-page", "grid-template-columns"))
      .toBe("var(--secondary-sidebar-width) minmax(0, 1fr) auto");
    expect(declaration(rules, ".knowledge-base-page", "grid-template-columns"))
      .toBe("var(--secondary-sidebar-width) minmax(0, 1fr)");
    expect(declaration(rules, ".secondary-sidebar-header__heading", "gap")).toBe("3px");
    expect(declaration(rules, ".secondary-sidebar-header__eyebrow", "color"))
      .toBe("var(--accent-foreground)");
    expect(declaration(rules, ".secondary-sidebar-header__eyebrow", "font-size")).toBe("11px");
    expect(declaration(rules, ".secondary-sidebar-header__eyebrow", "font-weight")).toBe("650");
    expect(declaration(rules, ".secondary-sidebar-header__title", "color")).toBe("inherit");
    expect(declaration(rules, ".secondary-sidebar-header__title", "font-size")).toBe("17px");
    expect(declaration(rules, ".secondary-sidebar-header__title", "font-weight")).toBe("650");

    // 资源与定时任务共用 Agent 导航，四个容器选择器覆盖五个侧边栏实例。
    const bugSidebarSelectors = [
      ':root[data-theme="bug"] .chat-sidebar',
      ':root[data-theme="bug"] .configuration-sidebar',
      ':root[data-theme="bug"] .workspace-agent-navigation',
      ':root[data-theme="bug"] .knowledge-base-navigation',
    ];
    for (const selector of bugSidebarSelectors) {
      expect(groupedDeclaration(themeRules, selector, "color")).toBe("rgb(255, 249, 238)");
    }
  });

  it("知识库与其他工作区页面使用一致的主画布背景", async () => {
    const source = await readFile("src/web/bugpaw-theme.css", "utf8");
    const rules = parseStyleRules(source);

    expect(groupedDeclaration(rules, ".knowledge-base-workspace", "background")).toBe("var(--canvas)");
    expect(groupedDeclaration(rules, ".workspace-resources-page__main", "background")).toBe("var(--canvas)");
    expect(groupedDeclaration(rules, ".configuration-content", "background")).toBe("var(--canvas)");
  });

  it("一级工作区标题具有一致且舒展的容器边界", async () => {
    const source = await readFile("src/web/bugpaw-theme.css", "utf8");
    const rules = parseStyleRules(source);
    const headings = [".workspace-resources-page__heading", ".knowledge-base-workspace__heading"];

    for (const selector of headings) {
      expect(groupedDeclaration(rules, selector, "padding")).toBe("18px 20px");
      expect(groupedDeclaration(rules, selector, "border")).toBe("1px solid var(--border)");
      expect(groupedDeclaration(rules, selector, "border-radius")).toBe("10px");
      expect(groupedDeclaration(rules, selector, "background")).toBe("var(--surface)");
    }

    for (const selector of headings.map((item) => `:root[data-theme="bug"] ${item}`)) {
      expect(groupedDeclaration(rules, selector, "border")).toBe("2px solid var(--border-strong)");
      expect(groupedDeclaration(rules, selector, "border-radius")).toBe("6px");
      expect(groupedDeclaration(rules, selector, "box-shadow")).toBe("var(--shadow-pixel)");
    }

    expect(declaration(rules, ':root[data-theme="bug"] .danger-button', "border-radius")).toBe("4px");
  });

  it("配置概览入口留白充足，普通配置标题保持纵向文档流", async () => {
    const [baseSource, themeSource] = await Promise.all([
      readFile("src/web/styles.css", "utf8"),
      readFile("src/web/bugpaw-theme.css", "utf8"),
    ]);
    const baseRules = parseStyleRules(baseSource);
    const themeRules = parseStyleRules(themeSource);

    expect(declaration(baseRules, ".configuration-entry", "padding")).toBe("15px 16px");
    expect(declaration(themeRules, ".configuration-page__heading", "display")).toBe("");
    expect(declaration(themeRules, ".configuration-overview-page .configuration-page__heading", "display")).toBe("flex");
    expect(declaration(themeRules, ".configuration-overview-page .configuration-page__heading", "justify-content")).toBe("space-between");
    expect(declaration(baseRules, ".configuration-page__heading--actions", "display")).toBe("flex");
  });

  it("运行设置分组让标题与字段远离容器边界", async () => {
    const source = await readFile("src/web/styles.css", "utf8");
    const rules = parseStyleRules(source);

    expect(declaration(rules, ".settings-section .configuration-section__heading", "padding-inline")).toBe("16px");
    expect(declaration(rules, ".settings-section > div:last-child", "padding-inline")).toBe("16px");
  });

  it("全部生产样式不再声明小于 10px 的可见字号", async () => {
    const sources = await Promise.all([
      readFile("src/web/styles.css", "utf8"),
      readFile("src/web/bugpaw-theme.css", "utf8").catch(() => ""),
    ]);
    const violations = sources.flatMap(parseStyleRules).flatMap((rule) => {
      const value = rule.declarations.fontSize;
      const pixels = /^(\d+(?:\.\d+)?)px$/u.exec(value);
      return pixels && Number(pixels[1]) < 10 ? [`${rule.selector}: ${value}`] : [];
    });

    expect(violations).toEqual([]);
  });

  it("覆盖层包含移动端与减少动效分支", async () => {
    const source = await readFile("src/web/bugpaw-theme.css", "utf8").catch(() => "");
    const style = document.createElement("style");
    style.textContent = source;
    document.head.append(style);
    const mediaConditions = [...style.sheet!.cssRules]
      .filter((rule): rule is CSSMediaRule => rule instanceof CSSMediaRule)
      .map((rule) => rule.conditionText);
    style.remove();

    expect(mediaConditions).toContain("(max-width: 760px)");
    expect(mediaConditions).toContain("(prefers-reduced-motion: reduce)");
  });

  it("登录页保持 v0 双栏几何、品牌画面和移动端收拢方式", async () => {
    const [baseSource, themeSource] = await Promise.all([
      readFile("src/web/styles.css", "utf8"),
      readFile("src/web/bugpaw-theme.css", "utf8"),
    ]);
    const baseRules = parseStyleRules(baseSource);
    const themeRules = parseStyleRules(themeSource);

    expect(declaration(baseRules, ".login-page", "grid-template-columns"))
      .toBe("minmax(520px, 1.25fr) minmax(390px, 0.75fr)");
    expect(declaration(baseRules, ".login-brand-panel", "background")).toBe("rgb(27, 34, 43)");
    expect(declaration(baseRules, ".hero-art", "transform")).toBe("rotate(-2deg)");
    expect(declaration(baseRules, ".login-form-wrap", "max-width")).toBe("340px");
    expect(declaration(themeRules, ':root[data-theme="bug"] .login-brand-panel', "background"))
      .toBe("rgb(47, 36, 27)");
    expect(mediaDeclaration(baseSource, "(max-width: 860px)", ".login-brand-panel", "display")).toBe("none");
    expect(mediaDeclaration(baseSource, "(max-width: 860px)", ".mobile-brand", "display")).toBe("flex");
  });
});
