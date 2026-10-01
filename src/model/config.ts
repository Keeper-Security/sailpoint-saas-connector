/**
 * Source configuration from connector-spec.json / Identity Security Cloud.
 */
export interface SourceConfig {
    serviceModeApiUrl: string
    serviceModeApiKey: string
    /** Poll timeout in seconds for async command results. Defaults to 60. */
    pollTimeoutSeconds?: string | number
    /**
     * How long a successful `enterprise-down -f` / `sync-down -f` is
     * considered fresh before the next std:account/entitlement request
     * forces another one. Defaults to 30.
     */
    syncCacheTtlSeconds?: string | number
}
