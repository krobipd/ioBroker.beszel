"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var credential_migration_exports = {};
__export(credential_migration_exports, {
  looksLikePlaintextUsername: () => looksLikePlaintextUsername,
  migrateUsernameEncryption: () => migrateUsernameEncryption
});
module.exports = __toCommonJS(credential_migration_exports);
var import_coerce = require("./coerce");
function looksLikePlaintextUsername(value) {
  if (typeof value !== "string" || value.length === 0) {
    return false;
  }
  if (value.length < 8) {
    return false;
  }
  if (value.includes("@")) {
    return true;
  }
  if (/\s/.test(value)) {
    return true;
  }
  if (!/^[0-9a-fA-F]+$/.test(value)) {
    return true;
  }
  if (value.length % 2 !== 0) {
    return true;
  }
  return false;
}
async function migrateUsernameEncryption(adapter) {
  var _a;
  const fullId = `system.adapter.${adapter.namespace}`;
  let obj;
  try {
    obj = await adapter.getForeignObjectAsync(fullId);
  } catch (err) {
    adapter.log.debug(`migrateUsernameEncryption: getForeignObject failed: ${(0, import_coerce.errText)(err)}`);
    return;
  }
  const stored = (_a = obj == null ? void 0 : obj.native) == null ? void 0 : _a.username;
  if (typeof stored !== "string" || stored.length === 0) {
    return;
  }
  if (!looksLikePlaintextUsername(stored)) {
    adapter.log.debug("migrateUsernameEncryption: username already encrypted (or unrecognised shape), skipping");
    return;
  }
  let encrypted;
  try {
    encrypted = adapter.encrypt(stored);
  } catch (err) {
    adapter.log.warn(`migrateUsernameEncryption: encrypt() threw, skipping migration: ${(0, import_coerce.errText)(err)}`);
    return;
  }
  if (typeof encrypted !== "string" || encrypted.length === 0 || encrypted === stored) {
    adapter.log.warn("migrateUsernameEncryption: encrypt() returned unusable value, skipping");
    return;
  }
  try {
    await adapter.extendForeignObjectAsync(fullId, { native: { username: encrypted } });
  } catch (err) {
    adapter.log.warn(`migrateUsernameEncryption: extendForeignObject failed: ${(0, import_coerce.errText)(err)}`);
    return;
  }
  adapter.config.username = stored;
  adapter.log.info("Username storage migrated to encrypted (1-time, v0.5.0)");
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  looksLikePlaintextUsername,
  migrateUsernameEncryption
});
//# sourceMappingURL=credential-migration.js.map
