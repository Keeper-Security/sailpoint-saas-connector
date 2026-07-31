import { ConnectorError } from '@sailpoint/connector-sdk'
import { AxiosResponse } from 'axios'
import { RequestResultResponse } from '../model/service-mode-api'

export class ResourceNotFoundError extends ConnectorError {
    constructor(message: string) {
        super(message)
        this.name = 'ResourceNotFoundError'
    }
}

function extractErrorMessage(data: unknown): string {
    if (data == null) {
        return ''
    }

    if (typeof data === 'string') {
        return data
    }

    if (typeof data === 'object') {
        const body = data as Partial<RequestResultResponse> & Record<string, unknown>
        if (body.message) {
            return String(body.message)
        }
        if (body.error) {
            return String(body.error)
        }
    }

    try {
        return JSON.stringify(data)
    } catch {
        return String(data)
    }
}

/**
 * Validates an HTTP response from the Keeper Service Mode API.
 * Returns without throwing for 2xx responses; throws ConnectorError otherwise.
 */
export function handleAPIErrorResponse(response: AxiosResponse): void {
    const { status, data } = response

    if (status >= 200 && status < 300) {
        return
    }

    const errorMsg = extractErrorMessage(data)

    switch (status) {
        case 503:
            throw new ConnectorError('queue is full (503): service unavailable, please try again later')
        case 429:
            throw new ConnectorError('rate limit exceeded (429): too many requests, please retry after some time')
        case 404:
            throw new ConnectorError('request id not found (404)')
        case 500:
            if (errorMsg.toLowerCase().includes('not found')) {
                throw new ResourceNotFoundError(errorMsg)
            }
            throw new ConnectorError(`internal server error (500): ${errorMsg}`)
        case 400:
            throw new ConnectorError(`bad request (400): ${errorMsg}`)
        default:
            throw new ConnectorError(`keeper Security API request failed with status ${status}: ${errorMsg}`)
    }
}
