import { ConnectorError } from '@sailpoint/connector-sdk'
import axios from 'axios'
import { RequestResultResponse, SubmitRequestResponse } from '../model/service-mode-api'
import { SourceConfig } from '../model/config'
import { KeeperNode, KeeperRole, KeeperTeam, KeeperUser } from '../model/keeper-entities'
import { handleAPIErrorResponse } from '../utils/api-error'
import { requireConfigValue } from '../utils/errors'

const USER_COLUMNS = 'name,status,transfer_status,node,team_count,teams,role_count,roles,alias,2fa_enabled,job_title'
const TEAM_COLUMNS = 'restricts,node,user_count,users,queued_user_count,queued_users,role_count,roles'
const ROLE_COLUMNS = 'visible_below,default_role,admin,node,user_count,users,team_count,teams'
const NODE_COLUMNS = 'parent_node,parent_id,user_count,users,team_count,teams,role_count,roles,provisioning,isolated'

const DEFAULT_POLL_TIMEOUT_SECONDS = 60
const INITIAL_POLL_DELAY_MS = 500
const MAX_POLL_DELAY_MS = 5_000

/**
 * Inputs for `KeeperClient.createUser`. Only `email` is required — every other
 * field is optional and will be omitted from the underlying Commander call if
 * left blank. `roleIds` and `teamUids` accept the stable IDs we hand out in
 * entitlement:list responses (role_id / team_uid).
 */
export interface CreateUserOptions {
    email: string
    name?: string
    jobTitle?: string
    nodeId?: string
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

function resolvePollTimeoutMs(value: string | number | undefined | null): number {
    if (value == null || value === '') {
        return DEFAULT_POLL_TIMEOUT_SECONDS * 1000
    }

    const seconds = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(seconds) || seconds <= 0) {
        return DEFAULT_POLL_TIMEOUT_SECONDS * 1000
    }

    return seconds * 1000
}

export class KeeperClient {
    private readonly serviceModeApiUrl: string
    private readonly serviceModeApiKey: string
    private readonly pollTimeoutMs: number

    constructor(config: SourceConfig) {
        this.serviceModeApiUrl = requireConfigValue(config?.serviceModeApiUrl, 'serviceModeApiUrl')
        this.serviceModeApiKey = requireConfigValue(config?.serviceModeApiKey, 'serviceModeApiKey')
        this.pollTimeoutMs = resolvePollTimeoutMs(config?.pollTimeoutSeconds)
    }

    private get baseUrl(): string {
        return this.serviceModeApiUrl.replace(/\/$/, '')
    }

    private get headers(): Record<string, string> {
        return {
            'api-key': this.serviceModeApiKey,
            'Content-Type': 'application/json',
        }
    }

    /**
     * Run a Commander command via the async execute + poll pipeline.
     *
     * By default we refresh both Commander caches before running the payload
     * so read commands never operate on stale local data:
     *   - `sync-down -f`       refreshes the vault cache (records, shared folders)
     *   - `enterprise-down -f` refreshes the enterprise cache (users, teams,
     *                          roles, nodes, node hierarchy)
     *
     * The refreshes run sequentially — enterprise-down only fires if
     * sync-down succeeded, which keeps error handling and log ordering
     * predictable at the cost of ~1 extra refresh worth of latency.
     *
     * Callers that only need connectivity/auth checks (e.g. test-connection)
     * can opt out via `{ syncFirst: false }`.
     */
    private async executeCommand(
        command: string,
        options: { syncFirst?: boolean } = {}
    ): Promise<RequestResultResponse> {
        const syncFirst = options.syncFirst ?? true
        if (syncFirst) {
            await this.runCommand('sync-down -f')
            await this.runCommand('enterprise-down -f')
        }
        return this.runCommand(command)
    }

    private async runCommand(command: string): Promise<RequestResultResponse> {
        const requestId = await this.submitRequest(command)
        return this.pollRequestResult(requestId)
    }

    private async submitRequest(command: string): Promise<string> {
        const response = await axios.post<SubmitRequestResponse>(
            `${this.baseUrl}/api/v2/executecommand-async`,
            { command },
            {
                headers: this.headers,
                validateStatus: () => true,
            }
        )

        if (response.status === 202) {
            const requestId = response.data?.request_id
            if (!requestId) {
                throw new ConnectorError('Keeper API accepted request but did not return request_id')
            }
            return requestId
        }

        handleAPIErrorResponse(response)
        throw new ConnectorError(`unexpected Keeper API response status ${response.status}`)
    }

    private async pollRequestResult(requestId: string): Promise<RequestResultResponse> {
        const deadline = Date.now() + this.pollTimeoutMs
        let delay = INITIAL_POLL_DELAY_MS
        let isFirstAttempt = true

        while (Date.now() < deadline) {
            if (!isFirstAttempt) {
                await sleep(delay)
                delay = Math.min(delay * 2, MAX_POLL_DELAY_MS)
            }
            isFirstAttempt = false

            const response = await axios.get<RequestResultResponse>(`${this.baseUrl}/api/v2/result/${requestId}`, {
                headers: this.headers,
                validateStatus: () => true,
            })

            if (response.status === 202) {
                continue
            }

            handleAPIErrorResponse(response)

            const apiResponse = response.data
            if (apiResponse.status !== 'success') {
                throw new ConnectorError(apiResponse.message || apiResponse.error || 'Keeper API request failed')
            }

            return apiResponse
        }

        const timeoutSeconds = Math.round(this.pollTimeoutMs / 1000)
        throw new ConnectorError(`Keeper API poll timed out after ${timeoutSeconds} seconds`)
    }

    async testConnection(): Promise<Record<string, never>> {
        // Test connection is a lightweight auth/connectivity ping, so skip the
        // pre-command sync-down to keep it fast and independent of vault state.
        await this.executeCommand('this-device', { syncFirst: false })
        return {}
    }

    async listUsers(): Promise<KeeperUser[]> {
        const result = await this.executeCommand(`enterprise-info --users --format json -v --columns ${USER_COLUMNS}`)
        return this.parseArrayData<KeeperUser>(result.data, 'users')
    }

    /**
     * Fetch a single Keeper user by email. Returns `null` if Commander reports no match
     * so callers can decide whether to raise a "not found" error.
     */
    async getUser(email: string): Promise<KeeperUser | null> {
        const { trimmed, safe } = this.normalizeEmailArg(email, 'getUser')

        // enterprise-info accepts a positional pattern; use the escaped form.
        const result = await this.executeCommand(
            `enterprise-info "${safe}" --users --format json -v --columns ${USER_COLUMNS}`
        )
        const users = this.parseArrayData<KeeperUser>(result.data, 'users')

        // Commander pattern is a substring/glob match, so filter to an exact email hit.
        const match = users.find((u) => u?.email?.toLowerCase() === trimmed.toLowerCase())
        return match ?? null
    }

    /**
     * Lock a Keeper enterprise user. The user's status becomes "Locked" and they
     * can no longer sign in until unlocked.
     */
    async lockUser(email: string): Promise<void> {
        const { safe } = this.normalizeEmailArg(email, 'lockUser')
        await this.executeCommand(`enterprise-user "${safe}" --lock`)
    }

    /**
     * Unlock a previously-locked Keeper enterprise user. Restores their ability
     * to sign in; their status returns to "Active".
     */
    async unlockUser(email: string): Promise<void> {
        const { safe } = this.normalizeEmailArg(email, 'unlockUser')
        await this.executeCommand(`enterprise-user "${safe}" --unlock`)
    }

    /**
     * Invite a new Keeper enterprise user and optionally seed their initial
     * attributes and entitlement memberships. Commander sends an invitation
     * email; the user's status is "Invited" until they accept and set up a
     * vault, at which point it becomes "Active".
     *
     * Commander's `enterprise-user --add` accepts `--add-role` and `--add-team`
     * (repeatable) so we can create + assign initial memberships atomically in
     * a single command. Both flags accept the entity's name or its stable ID
     * (role_id / team_uid) — we always pass IDs since that's what ISC hands us
     * in `attributes.roles` / `attributes.teams`.
     *
     * Only `email` is required. Any option left blank/undefined is simply
     * omitted from the command so Commander uses its defaults.
     */
    async createUser(options: CreateUserOptions): Promise<void> {
        const { safe: safeEmail } = this.normalizeEmailArg(options.email, 'createUser')

        const parts: string[] = [`enterprise-user "${safeEmail}" --add`]

        if (options.name) parts.push(`--name "${this.escapeArg(options.name)}"`)
        if (options.jobTitle) parts.push(`--job-title "${this.escapeArg(options.jobTitle)}"`)
        if (options.nodeId) parts.push(`--node "${this.escapeArg(options.nodeId)}"`)

        await this.executeCommand(parts.join(' '))
    }

    /**
     * Trim, validate and shell-escape an email argument used as a positional
     * argument in Commander commands.
     *
     * Returns both forms:
     * - `trimmed`: cleaned value for comparisons / logging (still contains any
     *              literal quotes the user may have supplied).
     * - `safe`:    quote-escaped form suitable for interpolation into a
     *              Commander command string.
     */
    private normalizeEmailArg(email: string, methodName: string): { trimmed: string; safe: string } {
        const trimmed = email?.trim()
        if (!trimmed) {
            throw new ConnectorError(`${methodName} called with empty email`)
        }
        return { trimmed, safe: this.escapeArg(trimmed) }
    }

    /**
     * Escape double quotes inside an argument value so Commander's argparse
     * parser doesn't split the string. Values are wrapped in `"..."` at the
     * call site; this ensures embedded quotes don't terminate that wrap.
     */
    private escapeArg(value: string): string {
        return value.replace(/"/g, '\\"')
    }

    async listTeams(): Promise<KeeperTeam[]> {
        const result = await this.executeCommand(`enterprise-info --teams --format json -v --columns ${TEAM_COLUMNS}`)
        return this.parseArrayData<KeeperTeam>(result.data, 'teams')
    }

    async listRoles(): Promise<KeeperRole[]> {
        const result = await this.executeCommand(`enterprise-info --roles --format json -v --columns ${ROLE_COLUMNS}`)
        return this.parseArrayData<KeeperRole>(result.data, 'roles')
    }

    async listNodes(): Promise<KeeperNode[]> {
        const result = await this.executeCommand(`enterprise-info --nodes --format json -v --columns ${NODE_COLUMNS}`)
        return this.parseArrayData<KeeperNode>(result.data, 'nodes')
    }

    /**
     * Commander's Service Mode returns command output either as a parsed JSON array
     * (queue-mode v2) or as a raw stdout string that must be parsed. Handle both.
     */
    private parseArrayData<T>(data: unknown, kind: string): T[] {
        if (Array.isArray(data)) {
            return data as T[]
        }

        if (typeof data === 'string') {
            const trimmed = data.trim()
            if (trimmed === '') {
                return []
            }
            try {
                const parsed = JSON.parse(trimmed)
                if (Array.isArray(parsed)) {
                    return parsed as T[]
                }
                throw new ConnectorError(`Keeper ${kind} response parsed but is not an array (got ${typeof parsed})`)
            } catch (err) {
                if (err instanceof ConnectorError) {
                    throw err
                }
                throw new ConnectorError(`Failed to parse Keeper ${kind} response as JSON: ${(err as Error).message}`)
            }
        }

        if (data == null) {
            return []
        }

        throw new ConnectorError(`Unexpected Keeper ${kind} response type: ${typeof data}`)
    }
}
