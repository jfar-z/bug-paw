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
  const media = [...style.sheet!.cssRules]
    .find((rule): rule is CSSMediaRule => rule instanceof CSSMediaRule && rule.conditionText === condition);
  const rule = media ? [...media.cssRules]
    .find((candidate): candidate is CSSStyleRule => candidate instanceof CSSStyleRule && candidate.selectorText === selector) : undefined;
  const value = rule?.style.getPropertyValue(property).trim() ?? "";
  style.remove();
  return value;
}

describe("BugPaw 生产视觉合同", () => {
  it("三套主题使用已确认的语义画布和 BUG 硬阴影", async () => {
    const source = await readFile("src/web/bugpaw-theme.css", "utf8").catch(() => "");
    const rules = parseStyleRules(source);

    expect(declaration(rules, ':root[data-theme="dark"]', "--canvas")).toBe("#171c22");
    expect(declaration(rules, ':root[data-theme="light"]', "--canvas")).toBe("#f7f6f2");
    expect(declaration(rules, ':root[data-theme="bug"]', "--canvas")).toBe("#ded2bf");
    expect(declaration(rules, ':root[data-theme="bug"]', "--shadow-pixel").replaceAll(" ", ""))
      .toBe("4px4px0#7a5a3a");
    expect(declaration(rules, ".product-mark__image", "width")).toBe("36px");
    expect(declaration(rules, ".bugpaw-auth-visual img", "object-fit")).toBe("contain");
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
    expect(declaration(themeRules, ':root[data-theme="dark"]', "--text-tertiary")).toBe("#98a4b2");
    expect(declaration(themeRules, ':root[data-theme="light"]', "--text-tertiary")).toBe("#596676");
    expect(declaration(themeRules, ':root[data-theme="bug"] .session-row:hover', "background")).toBe("rgb(89, 70, 52)");
    expect(declaration(themeRules, ':root[data-theme="bug"] .session-row:hover .session-row__open', "background")).toBe("transparent");
  });

  it("聊天容器使用动态视口高度，避免移动端输入区越过可视底部", async () => {
    const source = await readFile("src/web/styles.css", "utf8");
    const rules = parseStyleRules(source);

    expect(declaration(rules, ".chat-shell", "height")).toBe("100dvh");
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
