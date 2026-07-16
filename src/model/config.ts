/**
 * Source configuration from connector-spec.json / Identity Security Cloud.
 */
export interface SourceConfig {
    serviceModeApiUrl: string
    serviceModeApiKey: string
    /** Poll timeout in seconds for async command results. Defaults to 60. */
    pollTimeoutSeconds?: string | number
}
