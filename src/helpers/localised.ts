/** The language a `lang -> text` map answers `lang` in: that language, its primary subtag, then English */
export function servedLang (texts: Readonly<Record<string, unknown>>, lang?: string | null) {
  return [lang, lang?.split('-')[0]].find(tag => tag != null && texts[tag] != null) ?? 'en'
}

export function localised (texts: Readonly<Record<string, string>>, lang?: string | null) {
  return texts[servedLang(texts, lang)] ?? ''
}

/** As the schema's `LocalisedString`s, by language */
export function localisedStrings (texts: Readonly<Record<string, string>>) {
  return Object.entries(texts)
    .map(([lang, value]) => ({ lang, value }))
    .sort((a, b) => a.lang.localeCompare(b.lang))
}
