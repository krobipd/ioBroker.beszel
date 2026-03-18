import type * as utils from "@iobroker/adapter-core";
import type { AdapterConfig, BeszelContainer, BeszelSystem, SystemStats } from "./types.js";
/**
 * Manages creation, update and cleanup of ioBroker objects and states for Beszel systems.
 */
export declare class StateManager {
    private readonly adapter;
    /**
     * @param adapter The ioBroker adapter instance
     */
    constructor(adapter: utils.AdapterInstance);
    /**
     * Sanitize a name to a valid ioBroker state ID segment.
     * Lowercase, replace non-alphanumeric with _, max 50 chars, trim underscores.
     *
     * @param name Raw name to sanitize
     */
    sanitize(name: string): string;
    /**
     * Update all states for a single system.
     *
     * @param system Beszel system record
     * @param stats Latest stats for this system, or undefined if unavailable
     * @param containers Container records belonging to this system
     * @param config Current adapter configuration
     */
    updateSystem(system: BeszelSystem, stats: SystemStats | undefined, containers: BeszelContainer[], config: AdapterConfig): Promise<void>;
    /**
     * Remove device objects for systems that are no longer in Beszel.
     *
     * @param activeSystemNames Sanitized names of currently active systems
     */
    cleanupSystems(activeSystemNames: string[]): Promise<void>;
    /**
     * Delete states for metrics that have been disabled in the config.
     * Called on startup to clean up previously-enabled states.
     *
     * @param systemId Sanitized system name (the part after "systems.")
     * @param config Current adapter configuration
     */
    cleanupMetrics(systemId: string, config: AdapterConfig): Promise<void>;
    private updateStatsStates;
    private updateContainers;
    private ensureChannel;
    private deleteChannelIfExists;
    /**
     * Create or update the three load average states.
     *
     * @param sysId - State ID prefix (e.g. "systems.my_server")
     * @param la - Load average tuple [1m, 5m, 15m], or undefined
     */
    private createLoadAvgStates;
    private createAndSetState;
    private computeTopAvgTemp;
    private formatUptime;
}
//# sourceMappingURL=state-manager.d.ts.map