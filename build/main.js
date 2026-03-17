"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const utils = __importStar(require("@iobroker/adapter-core"));
const beszel_client_js_1 = require("./lib/beszel-client.js");
const state_manager_js_1 = require("./lib/state-manager.js");
class BeszelAdapter extends utils.Adapter {
    client = null;
    stateManager = null;
    pollTimer = null;
    isPolling = false;
    constructor(options = {}) {
        super({
            ...options,
            name: "beszel",
        });
        this.on("ready", this.onReady.bind(this));
        this.on("unload", this.onUnload.bind(this));
        this.on("message", this.onMessage.bind(this));
    }
    async onReady() {
        const config = this.config;
        // Validate required config
        if (!config.url || !config.username || !config.password) {
            this.log.error("Beszel adapter: URL, username, and password are required. Please configure the adapter.");
            await this.setStateAsync("info.connection", { val: false, ack: true });
            return;
        }
        this.client = new beszel_client_js_1.BeszelClient(config.url, config.username, config.password);
        this.stateManager = new state_manager_js_1.StateManager(this);
        // Initial poll
        await this.poll();
        // Set up recurring poll
        const intervalMs = Math.max(10, config.pollInterval ?? 60) * 1000;
        this.pollTimer = setInterval(() => {
            void this.poll();
        }, intervalMs);
        this.log.info(`Beszel adapter started. Polling every ${config.pollInterval ?? 60}s from ${config.url}`);
    }
    async onUnload(callback) {
        try {
            if (this.pollTimer) {
                clearInterval(this.pollTimer);
                this.pollTimer = null;
            }
            await this.setStateAsync("info.connection", { val: false, ack: true });
        }
        catch {
            // ignore
        }
        callback();
    }
    async onMessage(obj) {
        if (obj.command === "checkConnection") {
            const config = obj.message;
            const url = config.url ?? "";
            const username = config.username ?? "";
            const password = config.password ?? "";
            if (!url || !username || !password) {
                this.sendTo(obj.from, obj.command, {
                    success: false,
                    message: "URL, username and password are required",
                }, obj.callback);
                return;
            }
            const testClient = new beszel_client_js_1.BeszelClient(url, username, password);
            const result = await testClient.checkConnection();
            this.sendTo(obj.from, obj.command, result, obj.callback);
        }
    }
    async poll() {
        if (this.isPolling) {
            this.log.debug("Skipping poll — previous poll still running");
            return;
        }
        if (!this.client || !this.stateManager) {
            return;
        }
        this.isPolling = true;
        try {
            const config = this.config;
            // Fetch all data
            const [systems, containers] = await Promise.all([
                this.client.getSystems(),
                config.metrics_containers
                    ? this.client.getContainers()
                    : Promise.resolve([]),
            ]);
            const systemIds = systems.map((s) => s.id);
            const statsMap = await this.client.getLatestStats(systemIds);
            // Update connection state
            await this.setStateAsync("info.connection", { val: true, ack: true });
            // Update each system
            for (const system of systems) {
                const stats = statsMap.get(system.id);
                const sysContainers = containers.filter((c) => c.system === system.id);
                await this.stateManager.updateSystem(system, stats, sysContainers, config);
            }
            // Cleanup stale systems
            await this.stateManager.cleanupSystems(systems.map((s) => s.name));
            this.log.debug(`Polled ${systems.length} systems successfully`);
        }
        catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            this.log.error(`Poll failed: ${errMsg}`);
            // On 401, invalidate token so next poll re-authenticates
            if (err instanceof Error &&
                err.code === "UNAUTHORIZED") {
                this.client?.invalidateToken();
            }
            await this.setStateAsync("info.connection", { val: false, ack: true });
        }
        finally {
            this.isPolling = false;
        }
    }
}
if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = (options) => new BeszelAdapter(options);
}
else {
    (() => new BeszelAdapter())();
}
