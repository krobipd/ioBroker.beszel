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
function makeTestClientFactory(logger) {
  return (url, username, password) => new import_beszel_client.BeszelClient(url, username, password, void 0, logger);
}
async function dispatchMessage(obj, deps) {
  var _a, _b, _c, _d, _e;
  deps.log.debug(`onMessage: command='${obj == null ? void 0 : obj.command}' from='${obj == null ? void 0 : obj.from}' has-callback=${!!(obj == null ? void 0 : obj.callback)}`);
  if (!obj.callback) {
    return;
  }
  try {
    switch (obj.command) {
      case "checkConnection": {
        const config = obj.message;
        const url = (_a = config.url) != null ? _a : "";
        const username = (_b = config.username) != null ? _b : "";
        const password = (_c = config.password) != null ? _c : "";
        if (!url || !username || !password) {
          deps.log.debug("checkConnection: missing url/username/password in message");
          deps.sendTo(
            obj.from,
            obj.command,
            {
              success: false,
              message: "URL, username and password are required"
            },
            obj.callback
          );
          return;
        }
        const testClient = deps.createTestClient(url, username, password);
        (_d = deps.onTestClientCreated) == null ? void 0 : _d.call(deps, testClient);
        try {
          const result = await testClient.checkConnection();
          deps.log.debug(`checkConnection: result=${result.success ? "ok" : "fail"} (${result.message})`);
          deps.sendTo(obj.from, obj.command, result, obj.callback);
        } finally {
          (_e = deps.onTestClientDone) == null ? void 0 : _e.call(deps, testClient);
        }
        break;
      }
      default:
        deps.log.debug(`onMessage: unknown command '${obj.command}'`);
        deps.sendTo(obj.from, obj.command, { error: "Unknown command" }, obj.callback);
    }
  } catch (err) {
    deps.log.debug(`onMessage: '${obj.command}' failed: ${(0, import_coerce.errText)(err)}`);
    deps.sendTo(obj.from, obj.command, { success: false, message: (0, import_coerce.errText)(err) }, obj.callback);
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  dispatchMessage,
  makeTestClientFactory
});
//# sourceMappingURL=message-router.js.map
