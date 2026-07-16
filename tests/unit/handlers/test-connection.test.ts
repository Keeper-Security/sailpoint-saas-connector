import axios from 'axios'
import { Response } from '@sailpoint/connector-sdk'
import { KeeperClient } from '../../../src/client/keeper-client'
import { createTestConnectionHandler } from '../../../src/handlers/test-connection'
import { mockConfig } from '../../fixtures/mock-config'
import { createMockContext } from '../../helpers/mock-context'

jest.mock('axios')
const mockedAxios = axios as jest.Mocked<typeof axios>

describe('test-connection handler', () => {
    beforeEach(() => {
        jest.clearAllMocks()

        mockedAxios.post.mockResolvedValue({
            status: 202,
            data: {
                success: true,
                request_id: 'req-handler',
                status: 'accepted',
                message: 'queued',
            },
        })

        mockedAxios.get.mockResolvedValue({
            status: 200,
            data: {
                data: [],
                status: 'success',
                message: 'done',
                error: '',
            },
        })
    })

    it('sends an empty successful response', async () => {
        const client = new KeeperClient(mockConfig)
        const sent: unknown[] = []
        const res = {
            send(output: unknown) {
                sent.push(output)
            },
        } as Response<any>

        await createTestConnectionHandler(client)(createMockContext(), {} as any, res)

        expect(sent).toStrictEqual([{}])
    })
})
