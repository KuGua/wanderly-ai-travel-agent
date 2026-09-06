/**
 * The nationalities a hotel quote can be priced against.
 *
 * One definition, because there used to be two answers to "what does a
 * nationality look like". The Profile form asked for a country name — the
 * label said 国籍 / Nationality, `autoComplete` said `country-name`, and the
 * field took 64 characters — while activation required an ISO-3166-1 alpha-2
 * code and answered 422 to anything else. A traveller who wrote 中国, exactly
 * what the form asked for, could never start planning, and the picker that
 * produces valid codes is hidden the moment the Profile field is non-empty.
 * So the one control that could have repaired the value was the one control
 * they could no longer reach.
 *
 * A short list rather than every ISO code: this asks a traveller for the
 * nationality their hotel prices are quoted against, and a 250-entry select is
 * a worse answer to that than the markets the product actually serves.
 */
export const QUOTE_NATIONALITIES = [
  "CN", "HK", "TW", "SG", "MY", "JP", "KR", "TH", "ID", "PH", "VN",
  "AU", "NZ", "IN", "GB", "US", "CA", "DE", "FR", "IT", "ES", "NL", "AE",
] as const;

export type QuoteNationality = (typeof QUOTE_NATIONALITIES)[number];

/** The country's own name in the reader's language, not an English label. */
export function countryLabel(code: string, locale: "en" | "zh"): string {
  // Browser locale data varies in how it names these territories. The quote
  // selector uses the product's explicit China notation in both languages.
  if (code === "HK") return locale === "zh" ? "香港（中国）" : "Hong Kong (China)";
  if (code === "TW") return locale === "zh" ? "台湾（中国）" : "Taiwan (China)";
  try {
    return new Intl.DisplayNames([locale], { type: "region" }).of(code) ?? code;
  } catch {
    // `DisplayNames` is absent in some runtimes (older jsdom included); the
    // code is still a usable answer and the select still works.
    return code;
  }
}

/**
 * Whether a stored value is one this product can actually send to a provider.
 *
 * A Profile written before the picker existed can hold anything — 中国, China,
 * a sentence. Treating those as "set" is what hid the picker; treating them as
 * unset is what lets someone fix their own record.
 */
export function isQuoteNationality(value: string | null | undefined): boolean {
  return typeof value === "string"
    && (QUOTE_NATIONALITIES as readonly string[]).includes(value.trim().toUpperCase());
}
