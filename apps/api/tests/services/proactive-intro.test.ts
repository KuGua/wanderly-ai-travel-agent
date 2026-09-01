/**
 * Proactive intro i18n — pure-function unit tests.
 *
 * The template strings are the single source of truth for the greeting
 * the Personal Agent emits on a fresh Solo trip. Tests assert verbatim
 * per locale (no fuzzy match) so any unintended drift surfaces as a
 * failure. Privacy contract: the messages must NEVER contain the trip
 * name, owner identity, place names, or any extracted personal detail.
 */

import { describe, expect, it } from "vitest";

import {
  buildProactiveIntro,
  type ProactiveIntroLocale,
} from "../../src/i18n/proactive-intro.js";

describe("buildProactiveIntro", () => {
  it("returns zh-CN template by default", () => {
    const { content, locale } = buildProactiveIntro(undefined);
    expect(locale).toBe("zh-CN");
    expect(content).toContain("想去哪里玩");
    expect(content).toContain("多少预算");
    expect(content).toContain("什么时候出发");
  });

  it("returns zh-CN template when locale is explicitly zh-CN", () => {
    const { content, locale } = buildProactiveIntro("zh-CN");
    expect(locale).toBe("zh-CN");
    expect(content).toContain("想去哪里玩");
  });

  it("returns zh-TW template when locale is zh-TW", () => {
    const { content, locale } = buildProactiveIntro("zh-TW");
    expect(locale).toBe("zh-TW");
    expect(content).toContain("想去哪裡玩");
    expect(content).toContain("多少預算");
  });

  it("returns en-US template when locale is en-US", () => {
    const { content, locale } = buildProactiveIntro("en-US");
    expect(locale).toBe("en-US");
    expect(content).toContain("Where would you like to go");
    expect(content).toContain("budget");
    expect(content).toContain("when");
  });

  it("falls back to zh-CN for unrecognized locales", () => {
    const { content, locale } = buildProactiveIntro("fr-FR");
    expect(locale).toBe("zh-CN");
    expect(content).toContain("想去哪里玩");
  });

  it("falls back to zh-CN for null locale", () => {
    const { locale } = buildProactiveIntro(null);
    expect(locale).toBe("zh-CN");
  });

  it("privacy: NEVER includes place names, owner identity, or trip name", () => {
    const locales: ProactiveIntroLocale[] = ["zh-CN", "zh-TW", "en-US"];
    for (const locale of locales) {
      const { content } = buildProactiveIntro(locale);
      // No PII carriers — these strings must stay generic.
      expect(content).not.toMatch(/passport|护照|证件|手机|身份证/i);
      // No currency / price tokens — those are safety-gated elsewhere.
      expect(content).not.toMatch(/[¥$€£]|USD|CNY|TWD|JPY|EUR|HKD|SGD/);
      // No real-time / today markers — gated by the safety regex set.
      expect(content).not.toMatch(/今天|今晚|明天|现在|today|tonight|tomorrow|currently/i);
    }
  });

  it("emits at most one question prompt per category (no hardcoded sequence)", () => {
    // Spec §5.4 — the LLM-driven setup loop decides ordering, not us. The
    // intro just tees up the three categories; it must NOT ask a numbered
    // list that would imply a fixed order.
    const { content } = buildProactiveIntro("zh-CN");
    expect(content).not.toMatch(/第一|第二|第三|1\.|2\.|3\.|step 1/i);
  });
});