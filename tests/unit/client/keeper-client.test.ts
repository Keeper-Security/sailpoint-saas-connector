import axios from 'axios'
import { ConnectorError } from '@sailpoint/connector-sdk'
import { KeeperClient } from '../../../src/client/keeper-client'
import { ResourceNotFoundError } from '../../../src/utils/api-error'
import { invalidConfig, mockConfig } from '../../fixtures/mock-config'

jest.mock('axios')
const mockedAxios = axios as jest.Mocked<typeof axios>

function mockAcceptedSubmit(requestId = 'req-123') {
    mockedAxios.post.mockResolvedValueOnce({
        status: 202,
        data: {
            success: true,
            request_id: requestId,
            status: 'accepted',
            message: 'queued',
        },
    })
}

describe('KeeperClient', () => {
    const client = new KeeperClient(mockConfig)

    beforeEach(() => {
        jest.clearAllMocks()
    })

    it('rejects invalid config', () => {
        expect(() => new KeeperClient(invalidConfig)).toThrow(ConnectorError)
    })

    it('testConnection submits this-device and polls until success', async () => {
        mockAcceptedSubmit('req-123')
        mockedAxios.get
            .mockResolvedValueOnce({ status: 202, data: {} })
            .mockResolvedValueOnce({
                status: 200,
                data: {
                    data: ['account-1'],
                    status: 'success',
                    message: 'done',
                    error: '',
                },
            })

        jest.spyOn(global, 'setTimeout').mockImplementation((callback: TimerHandler) => {
            if (typeof callback === 'function') {
                callback()
            }
            return 0 as unknown as NodeJS.Timeout
        })

        await expect(client.testConnection()).resolves.toStrictEqual({})

        expect(mockedAxios.post).toHaveBeenCalledWith(
            'https://keeper.example.com/api/v2/executecommand-async',
            { command: 'this-device' },
            expect.objectContaining({
                headers: {
                    'api-key': 'xxx123',
                    'Content-Type': 'application/json',
                },
            })
        )
        expect(mockedAxios.get).toHaveBeenCalledTimes(2)
        expect(mockedAxios.get).toHaveBeenCalledWith(
            'https://keeper.example.com/api/v2/result/req-123',
            expect.objectContaining({
                headers: {
                    'api-key': 'xxx123',
                    'Content-Type': 'application/json',
                },
            })
        )
    })

    it('throws when submit receives a non-202 response', async () => {
        mockedAxios.post.mockResolvedValueOnce({
            status: 400,
            data: { message: 'invalid command' },
        })

        await expect(client.testConnection()).rejects.toThrow('bad request (400): invalid command')
    })

    it('throws when poll result status is not success', async () => {
        mockAcceptedSubmit()
        mockedAxios.get.mockResolvedValueOnce({
            status: 200,
            data: {
                data: null,
                status: 'failed',
                message: 'command failed',
                error: '',
            },
        })

        await expect(client.testConnection()).rejects.toThrow('command failed')
    })

    it('maps poll 500 not found to ResourceNotFoundError', async () => {
        mockAcceptedSubmit()
        mockedAxios.get.mockResolvedValueOnce({
            status: 500,
            data: { message: 'record not found' },
        })

        await expect(client.testConnection()).rejects.toThrow(ResourceNotFoundError)
    })
})
