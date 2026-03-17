import type * as utils from "@iobroker/adapter-core";
import type { AdapterConfig, BeszelContainer, BeszelSystem, SystemStats } from "./types.js";
/**
 * Manages creation and updates of ioBroker states for Beszel systems.
 */
export declare class StateManager {
    private readonly adapter;
    constructor(adapter: utils.AdapterInstance);
    /**
     * Sanitize a name to a valid ioBroker state ID segment.
     * Lowercase, replace non-alphanumeric with _, max 50 chars, trim underscores.
     *
     * @param name
     */
    sanitize(name: string): string;
    /**
     * Update all states for a single system.
     *
     * @param system
     * @param stats
     * @param containers
     * @param config
     */
    updateSystem(system: BeszelSystem, stats: SystemStats | undefined, containers: BeszelContainer[], config: AdapterConfig): Promise<void>;
    /**
     * Remove device objects for systems that are no longer in Beszel.
     *
     * @param activeSystemNames
     */
    cleanupSystems(activeSystemNames: string[]): Promise<void>;
    /**
     * Delete states for metrics that have been disabled in the config.
     * Called on startup to clean up previously-enabled states.
     *
     * @param systemId
     * @param config
     */
    cleanupMetrics(systemId: string, config: AdapterConfig): Promise<void>;
    private updateStatsStates;
    private updateContainers;
    private ensureChannel;
    private deleteChannelIfExists;
    private createAndSetState;
    private computeTopAvgTemp;
    private formatUptime;
}
//# sourceMappingURL=state-manager.d.ts.map