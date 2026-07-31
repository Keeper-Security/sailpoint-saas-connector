import { ConnectorError } from '@sailpoint/connector-sdk'
import { AxiosResponse } from 'axios'
import { handleAPIErrorResponse, ResourceNotFoundError } from '../../../src/utils/api-error'

describe('handleAPIErrorResponse', () => {
    it('does not throw for 2xx responses', () => {
        expect(() => handleAPIErrorResponse({ status: 200, data: {} } as AxiosResponse)).not.toThrow()
        expect(() => handleAPIErrorResponse({ status: 202, data: {} } as AxiosResponse)).not.toThrow()
    })

    it('maps known error status codes', () => {
        expect(() => handleAPIErrorResponse({ status: 503, data: {} } as AxiosResponse)).toThrow(
            'queue is full (503)'
        )
        expect(() => handleAPIErrorResponse({ status: 429, data: {} } as AxiosResponse)).toThrow(
            'rate limit exceeded (429)'
        )
        expect(() => handleAPIErrorResponse({ status: 404, data: {} } as AxiosResponse)).toThrow(
            'request id not found (404)'
        )
        expect(() => handleAPIErrorResponse({ status: 400, data: { message: 'invalid command' } } as AxiosResponse)).toThrow(
            'bad request (400): invalid command'
        )
    })

    it('maps 500 not found to ResourceNotFoundError', () => {
        expect(() =>
            handleAPIErrorResponse({ status: 500, data: { message: 'user not found' } } as AxiosResponse)
        ).toThrow(ResourceNotFoundError)
    })

    it('maps unknown status codes with response body', () => {
        expect(() =>
            handleAPIErrorResponse({ status: 418, data: { error: 'teapot' } } as AxiosResponse)
        ).toThrow('keeper Security API request failed with status 418: teapot')
    })
})
