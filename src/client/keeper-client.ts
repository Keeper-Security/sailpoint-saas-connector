import { ConnectorError } from '@sailpoint/connector-sdk'
import axios from 'axios'
import { RequestResultResponse, SubmitRequestResponse } from '../model/service-mode-api'
import { SourceConfig } from '../model/config'
import { KeeperNode, KeeperRole, KeeperTeam, KeeperUser, KeeperRecord, KeeperFolder, KeeperVaultTreeData } from '../model/keeper-entities'
import { handleAPIErrorResponse } from '../utils/api-error'
import { requireConfigValue } from '../utils/errors'
import { getManageableFolders } from '../utils/helper'

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
 * left blank. `addRoleValues` / `addTeamValues` accept the stable IDs we hand
 * out in entitlement:list responses (role_id / team_uid).
 */
export interface CreateUserOptions {
    email: string
    name?: string
    jobTitle?: string
    nodeId?: string
    addRoleValues?: string[]
    addTeamValues?: string[]
}

/**
 * Snapshot of the Keeper Commander session backing this connector. Populated
 * during `testConnection` and cached on the client so subsequent handlers can
 * read it without a round-trip. Sourced from Commander's `whoami --json`.
 */
export interface WhoamiInfo {
    /** Email of the Commander service account driving this connector. */
    user: string
}

/**
 * Inputs for `KeeperClient.updateUser`. Every attribute field is optional and
 * only emitted if the caller sets it. The distinction between `undefined`
 * (attribute untouched) and `''` (attribute cleared) matters for `jobTitle`,
 * which Commander clears when passed an empty value — so callers use
 * `!== undefined` semantics, not truthiness.
 *
 * `addRoleValues` / `removeRoleValues` / `addTeamValues` / `removeTeamValues`
 * are the pre-computed membership deltas. Each entry may be either a stable
 * ID (role_id / team_uid) or a display name — Commander accepts both.
 */
export interface UpdateUserOptions {
    email: string
    name?: string
    jobTitle?: string
    nodeId?: string
    addRoleValues?: string[]
    removeRoleValues?: string[]
    addTeamValues?: string[]
    removeTeamValues?: string[]
    addRecordValues?: string[]
    removeRecordValues?: string[]
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

    /**
     * Cached `whoami` snapshot. Populated the first time `testConnection` or
     * `getWhoami` runs and kept for the lifetime of this KeeperClient (i.e.
     * this connector process). Refresh by calling `refreshWhoami()`.
     */
    private whoamiCache: WhoamiInfo | null = null

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
     * Submit a Commander command via Service Mode and wait for its result.
     * Callers are responsible for calling `syncVault()` / `syncEnterprise()`
     * beforehand when they need fresh local Commander state — this method
     * never syncs implicitly.
     */
    private async executeCommand(
        command: string,
    ): Promise<RequestResultResponse> {
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

    /**
     * Lightweight auth/connectivity check. Also warms the whoami cache so
     * downstream handlers can read the Commander session identity without
     * making their own round-trip. Throws if Commander is not logged in.
     */
    async testConnection(): Promise<Record<string, never>> {
        await this.refreshWhoami()
        return {}
    }

    /**
     * Return the cached whoami snapshot, fetching it on demand if this is the
     * first call in the current process. Prefer this over `refreshWhoami` when
     * you just want to read stable session info (Commander user, data center).
     */
    async getWhoami(): Promise<WhoamiInfo> {
        if (!this.whoamiCache) {
            this.whoamiCache = await this.fetchWhoami()
        }
        return this.whoamiCache
    }

    /** Force a fresh whoami round-trip and update the cache. */
    async refreshWhoami(): Promise<WhoamiInfo> {
        this.whoamiCache = await this.fetchWhoami()
        return this.whoamiCache
    }

    /**
     * Actually hit Commander's `whoami --json`. No syncVault / syncEnterprise
     * needed because whoami is a session lookup, not vault or enterprise data.
     */
    private async fetchWhoami(): Promise<WhoamiInfo> {
        const result = await this.executeCommand('whoami')
        const data = result.data as WhoamiInfo

        return {
            user: data.user,
        }
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
     * Permanently delete a Keeper enterprise user. Destructive — removes the
     * user from the enterprise and (unless vault data was transferred first)
     * destroys their vault records along with the account. Commander is called
     * with `--force` to suppress the interactive "are you sure?" prompt that
     * would otherwise stall in Service Mode.
     *
     * Callers wanting idempotent semantics should check with `getUser()` first
     * and short-circuit on `null` — this method assumes the user exists and
     * will surface a Commander error if they don't.
     */
    async deleteUser(email: string): Promise<void> {
        const { safe } = this.normalizeEmailArg(email, 'deleteUser')
        await this.executeCommand(`enterprise-user "${safe}" --delete --force`)
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

        for (const v of options.addRoleValues ?? []) parts.push(`--add-role "${this.escapeArg(v)}"`)
        for (const v of options.addTeamValues ?? []) parts.push(`--add-team "${this.escapeArg(v)}"`)

        await this.executeCommand(parts.join(' '))
    }

    /**
     * Apply an update to an existing Keeper enterprise user. Every option is
     * optional and only fields the caller has set are emitted as Commander
     * flags. Multiple flags are batched into a single `enterprise-user "<email>"`
     * invocation so the update is applied atomically from Commander's point
     * of view.
     *
     * Ordering: `--remove-*` flags are emitted before `--add-*` flags to
     * reduce the chance of Commander rejecting an add for a membership the
     * user already has (e.g. during a Set-diff where we happen to re-add an
     * unrelated membership Commander would otherwise consider a duplicate).
     */
    async updateUser(options: UpdateUserOptions): Promise<void> {
        const { safe: safeEmail } = this.normalizeEmailArg(options.email, 'updateUser')

        const parts: string[] = [`enterprise-user "${safeEmail}" -f`]

        if (options.name !== undefined) parts.push(`--name "${this.escapeArg(options.name)}"`)
        if (options.jobTitle !== undefined) parts.push(`--job-title "${this.escapeArg(options.jobTitle)}"`)
        if (options.nodeId !== undefined) parts.push(`--node "${this.escapeArg(options.nodeId)}"`)

        for (const v of options.removeRoleValues ?? []) parts.push(`--remove-role "${this.escapeArg(v)}"`)
        for (const v of options.removeTeamValues ?? []) parts.push(`--remove-team "${this.escapeArg(v)}"`)
        for (const v of options.addRoleValues ?? []) parts.push(`--add-role "${this.escapeArg(v)}"`)
        for (const v of options.addTeamValues ?? []) parts.push(`--add-team "${this.escapeArg(v)}"`)

        await this.updateRecord(options)

        if (parts.length === 1) {
            throw new ConnectorError('updateUser called with no attributes to change')
        }

        await this.executeCommand(parts.join(' '))

    }

    private async updateRecord(options: UpdateUserOptions): Promise<void> {
        for (const v of options.addRecordValues ?? []) {
            await this.executeCommand(this.createRecordCommand(v, options.email)+' --action grant')
        }

        for (const v of options.removeRecordValues ?? []) {
            await this.executeCommand(this.createRecordCommand(v, options.email)+' --action revoke')
        }
    }
    private createRecordCommand(recordId: string, email: string): string {

        const assign_perm = recordId.split(':')[1]

            switch (assign_perm) {
                case "RO":
                    return `share-record -e ${email} "${recordId.split(':')[0]}"`
                case "CE":
                    return `share-record -e ${email} "${recordId.split(':')[0]}" --write`
                case "CS":
                    return `share-record -e ${email} "${recordId.split(':')[0]}" --share`
                
                case "VW":
                    return `nsf-share-record -e ${email} "${recordId.split(':')[0]}" -r viewer`
                case "SM":
                    return `nsf-share-record -e ${email} "${recordId.split(':')[0]}" -r share-manager`
                case "FM":
                    return `nsf-share-record -e ${email} "${recordId.split(':')[0]}" -r full-manager`
                case "CSM":
                    return `nsf-share-record -e ${email} "${recordId.split(':')[0]}" -r content-share-manager`
                case "CM":
                    return `nsf-share-record -e ${email} "${recordId.split(':')[0]}" -r content-manager`
                default:
                        throw new ConnectorError(`Invalid permission: ${assign_perm}`)

        }

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

    async syncEnterprise(): Promise<void>{
        await this.runCommand('enterprise-down -f')
    }

    async syncVault(): Promise<void>{
        await this.runCommand('sync-down -f')
    }

    async listVaultTree(): Promise<KeeperVaultTreeData> {
        const result = await this.runCommand('tree -s -ns -r -v --format json')
        return this.parseObjectData<KeeperVaultTreeData>(result.data, 'vaultTree')
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
     * Whoami catalog folders (classic MU; NSF OW).
     * Used for entitlement aggregation and account/team folder attributes.
     */
    async listManageableFolders(): Promise<KeeperFolder[]> {
        const [vaultTree, whoami] = await Promise.all([this.listVaultTree(), this.getWhoami()])
        return getManageableFolders(vaultTree, whoami.user)
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

    /**
     * Same as parseArrayData, but for a single JSON object (e.g. vault tree).
     */
    private parseObjectData<T extends object>(data: unknown, kind: string): T {
        if (data != null && typeof data === 'object' && !Array.isArray(data)) {
            return data as T
        }

        if (typeof data === 'string') {
            const trimmed = data.trim()
            if (trimmed === '') {
                throw new ConnectorError(`Keeper ${kind} response was empty`)
            }
            try {
                const parsed = JSON.parse(trimmed)
                if (parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    return parsed as T
                }
                throw new ConnectorError(
                    `Keeper ${kind} response parsed but is not an object (got ${Array.isArray(parsed) ? 'array' : typeof parsed})`
                )
            } catch (err) {
                if (err instanceof ConnectorError) {
                    throw err
                }
                throw new ConnectorError(`Failed to parse Keeper ${kind} response as JSON: ${(err as Error).message}`)
            }
        }

        throw new ConnectorError(`Unexpected Keeper ${kind} response type: ${typeof data}`)
    }
}
