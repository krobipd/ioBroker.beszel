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
    lastSystemCount = 0;
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
        // Ensure info objects exist before any setState calls
        await this.setObjectNotExistsAsync("info", {
            type: "channel",
            common: { name: "Information" },
            native: {},
        });
        await this.setObjectNotExistsAsync("info.connection", {
            type: "state",
            common: {
                name: "Connection status",
                type: "boolean",
                role: "indicator.connected",
                read: true,
                write: false,
                def: false,
            },
            native: {},
        });
        await this.setStateAsync("info.connection", { val: false, ack: true });
        // Validate required config
        if (!config.url || !config.username || !config.password) {
            this.log.error("Beszel adapter: URL, username, and password are required. Please configure the adapter.");
            return;
        }
        this.client = new beszel_client_js_1.BeszelClient(config.url, config.username, config.password);
        this.stateManager = new state_manager_js_1.StateManager(this);
        // Cleanup disabled metric states for existing systems (config may have changed)
        const existingObjects = await this.getObjectViewAsync("system", "device", {
            startkey: `${this.namespace}.systems.`,
            endkey: `${this.namespace}.systems.\u9999`,
        });
        if (existingObjects?.rows) {
            for (const row of existingObjects.rows) {
                const relId = row.id.startsWith(`${this.namespace}.`)
                    ? row.id.slice(this.namespace.length + 1)
                    : row.id;
                const parts = relId.split(".");
                if (parts.length === 2 && parts[0] === "systems") {
                    await this.stateManager.cleanupMetrics(parts[1], config);
                }
            }
        }
        // Initial poll
        await this.poll();
        // Set up recurring poll
        const intervalMs = Math.max(10, config.pollInterval ?? 60) * 1000;
        this.pollTimer = setInterval(() => {
            void this.poll();
        }, intervalMs);
        this.log.info(`Beszel adapter started — ${this.lastSystemCount} system(s), polling every ${config.pollInterval ?? 60}s`);
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
                await this.stateManager.updateSystem(system, stats, containers, config);
            }
            // Cleanup stale systems
            await this.stateManager.cleanupSystems(systems.map((s) => s.name));
            this.lastSystemCount = systems.length;
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
