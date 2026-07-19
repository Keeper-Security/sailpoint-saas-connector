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

    private async executeCommand(command: string): Promise<RequestResultResponse> {
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
        await this.executeCommand('this-device')
        return {}
    }

    async listUsers(): Promise<KeeperUser[]> {
        const result = await this.executeCommand(
            `enterprise-info --users --format json -v --columns ${USER_COLUMNS}`
        )
        return this.parseArrayData<KeeperUser>(result.data, 'users')
    }

    /**
     * Fetch a single Keeper user by email. Returns `null` if Commander reports no match
     * so callers can decide whether to raise a "not found" error.
     */
    async getUser(email: string): Promise<KeeperUser | null> {
        const trimmed = email?.trim()
        if (!trimmed) {
            throw new ConnectorError('getUser called with empty email')
        }

        // enterprise-info accepts a positional pattern; wrap in quotes and escape any
        // embedded quote to keep the Commander argparse-style parser happy.
        const safe = trimmed.replace(/"/g, '\\"')
        const result = await this.executeCommand(
            `enterprise-info "${safe}" --users --format json -v --columns ${USER_COLUMNS}`
        )
        const users = this.parseArrayData<KeeperUser>(result.data, 'users')

        // Commander pattern is a substring/glob match, so filter to an exact email hit.
        const match = users.find((u) => u?.email?.toLowerCase() === trimmed.toLowerCase())
        return match ?? null
    }

    async listTeams(): Promise<KeeperTeam[]> {
        const result = await this.executeCommand(
            `enterprise-info --teams --format json -v --columns ${TEAM_COLUMNS}`
        )
        return this.parseArrayData<KeeperTeam>(result.data, 'teams')
    }

    async listRoles(): Promise<KeeperRole[]> {
        const result = await this.executeCommand(
            `enterprise-info --roles --format json -v --columns ${ROLE_COLUMNS}`
        )
        return this.parseArrayData<KeeperRole>(result.data, 'roles')
    }

    async listNodes(): Promise<KeeperNode[]> {
        const result = await this.executeCommand(
            `enterprise-info --nodes --format json -v --columns ${NODE_COLUMNS}`
        )
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
                throw new ConnectorError(
                    `Keeper ${kind} response parsed but is not an array (got ${typeof parsed})`
                )
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
