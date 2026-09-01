/**
 * Proactive conversation intros — deterministic, locale-aware greeting the
 * Personal Agent emits when a fresh Solo trip is created or activated. We
 * deliberately do NOT call the LLM here: the owner has not typed anything
 * yet, so the message is purely templated and identical for every new trip.
 *
 * Three short lines, no trip name, no owner identity, no extracted place,
 * no provider data — just three conversational prompts the owner can
 * answer in any combination (or skip entirely):
 *
 *   1. Where do you want to go?
 *   2. What's your budget?
 *   3. When / how long?
 *
 * Adding more locales: extend the `messages` table and pass `locale` from
 * the request header (default `zh-CN`). Tests assert the message is
 * verbatim per locale to guarantee privacy + no-leakage.
 */

export type ProactiveIntroLocale = "zh-CN" | "zh-TW" | "en-US";

const messages: Record<ProactiveIntroLocale, string> = {
  "zh-CN":
    "你好！想去哪里玩？大概多少预算？什么时候出发、玩几天？告诉我你想研究的（机票、酒店、景点都行），我会按你的情况去查找，结果稍后会置顶在这里。",
  "zh-TW":
    "你好！想去哪裡玩？大概多少預算？什麼時候出發、玩幾天？告訴我你想研究的（機票、酒店、景點都行），我會按你的情況去查找，結果稍後會置頂在這裡。",
  "en-US":
    "Hi! Where would you like to go, what's your budget, and when are you thinking of going? Let me know what you'd like me to research (flights, hotels, activities — anything), and I'll look into it and pin the result up here shortly.",
};

export function buildProactiveIntro(locale: string | undefined | null): {
  content: string;
  locale: ProactiveIntroLocale;
} {
  const normalized = (locale ?? "zh-CN") as ProactiveIntroLocale;
  const localeKey: ProactiveIntroLocale =
    normalized === "en-US" || normalized === "zh-TW" ? normalized : "zh-CN";
  return { content: messages[localeKey], locale: localeKey };
}