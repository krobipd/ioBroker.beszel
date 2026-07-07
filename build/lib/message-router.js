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
var message_router_exports = {};
__export(message_router_exports, {
  dispatchMessage: () => dispatchMessage,
  makeTestClientFactory: () => makeTestClientFactory
});
module.exports = __toCommonJS(message_router_exports);
var import_beszel_client = require("./beszel-client");
var import_coerce = require("./coerce");
function makeTestClientFactory(logger, delay) {
  return (url, username, password) => new import_beszel_client.BeszelClient(url, username, password, void 0, logger, delay);
}
async function dispatchMessage(obj, deps) {
  var _a, _b, _c;
  deps.log.debug(`onMessage: command='${obj == null ? void 0 : obj.command}' from='${obj == null ? void 0 : obj.from}' has-callback=${!!(obj == null ? void 0 : obj.callback)}`);
  if (!obj.callback) {
    return;
  }
  try {
    switch (obj.command) {
      case "checkConnection": {
        const from = typeof obj.from === "string" ? obj.from : "";
        if (from && !from.startsWith("system.adapter.admin.") && !from.startsWith("system.adapter.web.")) {
          deps.log.warn(`checkConnection rejected from '${from}' \u2014 only the admin/web config UI may run it`);
          deps.sendTo(
            obj.from,
            obj.command,
            { error: "checkConnection is only available from the admin UI" },
            obj.callback
          );
          return;
        }
        const msg = (_a = (0, import_coerce.coerceObject)(obj.message)) != null ? _a : {};
        const config = msg;
        const url = typeof config.url === "string" ? config.url : "";
        const username = typeof config.username === "string" ? config.username : "";
        const password = typeof config.password === "string" ? config.password : "";
        if (!url || !username || !password) {
          deps.log.debug("checkConnection: missing url/username/password in message");
          deps.sendTo(obj.from, obj.command, { error: "URL, username and password are required" }, obj.callback);
          return;
        }
        const testClient = deps.createTestClient(url, username, password);
        (_b = deps.onTestClientCreated) == null ? void 0 : _b.call(deps, testClient);
        try {
          const result = await testClient.checkConnection();
          deps.log.debug(`checkConnection: result=${result.success ? "ok" : "fail"} (${result.message})`);
          deps.sendTo(
            obj.from,
            obj.command,
            result.success ? { result: result.message } : { error: result.message },
            obj.callback
          );
        } finally {
          (_c = deps.onTestClientDone) == null ? void 0 : _c.call(deps, testClient);
        }
        break;
      }
      default:
        deps.log.debug(`onMessage: unknown command '${obj.command}'`);
        deps.sendTo(obj.from, obj.command, { error: "Unknown command" }, obj.callback);
    }
  } catch (err) {
    deps.log.debug(`onMessage: '${obj.command}' failed: ${(0, import_coerce.errText)(err)}`);
    deps.sendTo(obj.from, obj.command, { error: (0, import_coerce.errText)(err) }, obj.callback);
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  dispatchMessage,
  makeTestClientFactory
});
//# sourceMappingURL=message-router.js.map
