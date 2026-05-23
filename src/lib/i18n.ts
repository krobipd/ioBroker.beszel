import { I18n } from "@iobroker/adapter-core";
import type translations from "../../admin/i18n/en.json";

type I18nKey = keyof typeof translations;

/**
 * Translation object for the given i18n key.
 *
 * @param key Translation key from admin/i18n/en.json
 */
export function tName(key: I18nKey): ioBroker.StringOrTranslated {
  return I18n.getTranslatedObject(key);
}
