import { describe, expect, it } from "vitest";

import { sensitiveHighlightCategory } from "../src/memory/sensitive-highlight.js";

/**
 * Three fields are withheld from the conversation on purpose, and typed
 * highlight extraction already refuses them. The fallback then kept the whole
 * sentence as a free-text note, and notes go into the prompt on every turn —
 * so the guard was bypassed by the fallback of the check enforcing it.
 *
 * Verified against the running system before this existed: a note saying
 * "膝盖不好走不了长路" produced a reply opening
 * "我会重点考虑你提到的膝盖不便的情况".
 */
describe("sensitiveHighlightCategory", () => {
  it("catches the sentence that actually leaked", () => {
    expect(sensitiveHighlightCategory("我持中国护照，出生日期 1990-05-12，膝盖不好走不了长路"))
      .not.toBeNull();
  });

  it("catches each withheld field on its own, in both languages", () => {
    for (const text of ["我是中国国籍", "我的护照是新加坡的", "I travel on a US passport", "my citizenship is French"]) {
      expect(sensitiveHighlightCategory(text)).toBe("nationality");
    }
    for (const text of ["我的生日是 5 月 12 日", "出生日期 1990-05-12", "my date of birth is 1990-05-12", "born on 12 May 1990"]) {
      expect(sensitiveHighlightCategory(text)).toBe("date_of_birth");
    }
    for (const text of ["我需要无障碍通道", "坐轮椅", "膝盖不好走不了长路", "I use a wheelchair", "I cannot walk far"]) {
      expect(sensitiveHighlightCategory(text)).toBe("mobility_notes");
    }
  });

  it("leaves ordinary travel preferences alone", () => {
    for (const text of [
      "我在京都只想住町屋",
      "早餐一定要有现磨咖啡",
      "我喜欢清晨在巷子里散步",
      "I like ramen and jazz bars",
      "budget around 200 a night",
    ]) {
      expect(sensitiveHighlightCategory(text)).toBeNull();
    }
  });
});
