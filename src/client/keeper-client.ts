import { ConnectorError } from '@sailpoint/connector-sdk'
import axios from 'axios'
import { RequestResultResponse, SubmitRequestResponse } from '../model/service-mode-api'
import { SourceConfig } from '../model/config'
import { handleAPIErrorResponse } from '../utils/api-error'
import { requireConfigValue } from '../utils/errors'

const POLL_TIMEOUT_MS = 60_000
const INITIAL_POLL_DELAY_MS = 500
const MAX_POLL_DELAY_MS = 5_000

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

export class KeeperClient {
    private readonly serviceModeApiUrl: string
    private readonly serviceModeApiKey: string

    constructor(config: SourceConfig) {
        this.serviceModeApiUrl = requireConfigValue(config?.serviceModeApiUrl, 'serviceModeApiUrl')
        this.serviceModeApiKey = requireConfigValue(config?.serviceModeApiKey, 'serviceModeApiKey')
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
        const deadline = Date.now() + POLL_TIMEOUT_MS
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

        throw new ConnectorError('Keeper API poll timed out after 60 seconds')
    }

    async testConnection(): Promise<Record<string, never>> {
        await this.executeCommand('this-device')
        return {}
    }    
}
