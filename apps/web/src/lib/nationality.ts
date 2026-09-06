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

/**
 * English demonyms. The field asks what someone *is*, not where a place is,
 * and "Nationality: Singapore" answers the wrong question — a passport says
 * Singaporean. `Intl.DisplayNames` has no demonym type in any runtime, so the
 * list is written out; it is 23 entries and it changes when the market list
 * changes, which is the same moment `QUOTE_NATIONALITIES` changes.
 *
 * Hong Kong and Taiwan keep the product's explicit China notation rather than
 * a demonym. That notation is a deliberate decision recorded below, and there
 * is no demonym form of it that stays neutral.
 */
const EN_DEMONYMS: Record<QuoteNationality, string> = {
  CN: "Chinese",
  HK: "Hong Kong (China)",
  TW: "Taiwan (China)",
  SG: "Singaporean",
  MY: "Malaysian",
  JP: "Japanese",
  KR: "South Korean",
  TH: "Thai",
  ID: "Indonesian",
  PH: "Filipino",
  VN: "Vietnamese",
  AU: "Australian",
  NZ: "New Zealander",
  IN: "Indian",
  GB: "British",
  US: "American",
  CA: "Canadian",
  DE: "German",
  FR: "French",
  IT: "Italian",
  ES: "Spanish",
  NL: "Dutch",
  AE: "Emirati",
};

/**
 * How this nationality is named to the reader.
 *
 * English uses the demonym. Chinese does not: a 国籍 field there takes the
 * country — 新加坡, not 新加坡人 — so the Chinese branch stays the region name,
 * with the two territory labels the product fixed by hand.
 */
export function nationalityLabel(code: string, locale: "en" | "zh"): string {
  // Browser locale data varies in how it names these territories. The quote
  // selector uses the product's explicit China notation in both languages.
  if (code === "HK") return locale === "zh" ? "香港（中国）" : EN_DEMONYMS.HK;
  if (code === "TW") return locale === "zh" ? "台湾（中国）" : EN_DEMONYMS.TW;
  if (locale === "en") {
    const demonym = EN_DEMONYMS[code.toUpperCase() as QuoteNationality];
    if (demonym) return demonym;
  }
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
