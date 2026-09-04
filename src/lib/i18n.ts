import { I18n } from "@iobroker/adapter-core";
import type translations from "../../admin/i18n/en.json";

type I18nKey = keyof typeof translations;

/**
 * Translation object for the given i18n key.
 *
 * @param key Translation key from admin/i18n/en.json
 * @param args Values for the `%s` placeholders of that key, substituted in every language
 */
export function tName(key: I18nKey, ...args: (string | number)[]): ioBroker.StringOrTranslated {
  return I18n.getTranslatedObject(key, ...args);
}

/**
 * Translation object for a datapoint's `common.desc`. Same lookup as {@link tName} —
 * separate name so a reader sees at the call site that this is the EXPLANATION, which
 * the fleet standard treats differently from the label: one plain sentence, never an
 * identifier, and left out entirely where there is nothing to explain.
 *
 * @param key Translation key from admin/i18n/en.json (the `desc…` keys)
 */
export function tDesc(key: I18nKey): ioBroker.StringOrTranslated {
  return I18n.getTranslatedObject(key);
}
