/**
 * Proactive conversation intros — deterministic, locale-aware greeting the
 * Personal Agent emits when a fresh Solo trip is created or activated. We
 * deliberately do NOT call the LLM here: the owner has not typed anything
 * yet, so the message is purely templated and identical for every new trip.
 *
 * Three short lines, no trip name, no owner identity, no extracted place,
 * no provider data or service promotion — just three conversational prompts the owner can
 * answer in any combination (or skip entirely):
 *
 *   1. Where do you want to go?
 *   2. When / how long?
 *   3. What kind of trip?
 *
 * Adding more locales: extend the `messages` table and pass `locale` from
 * the request header (default `zh-CN`). Tests assert the message is
 * verbatim per locale to guarantee privacy + no-leakage.
 */

export type ProactiveIntroLocale = "zh-CN" | "zh-TW" | "en-US";

const messages: Record<ProactiveIntroLocale, string> = {
  "zh-CN":
    "你好！想去哪里玩？大概什么时候、玩几天？更想轻松逛逛、自然风景，还是美食和文化？你想到哪一步，我们就从哪一步开始。",
  "zh-TW":
    "你好！想去哪裡玩？大概什麼時候、玩幾天？更想輕鬆逛逛、自然風景，還是美食和文化？你想到哪一步，我們就從哪一步開始。",
  "en-US":
    "Hi! Where would you like to go, roughly when, and for how long? Are you after a relaxed break, nature, food, or culture? We can start wherever you are in the idea.",
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
