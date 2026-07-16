import axios from 'axios'
import { connector } from '../../../src/index'
import { Connector, RawResponse, ResponseType, StandardCommand } from '@sailpoint/connector-sdk'
import { PassThrough } from 'stream'
import { mockConfig } from '../../fixtures/mock-config'
import { createMockContext } from '../../helpers/mock-context'

jest.mock('axios')
const mockedAxios = axios as jest.Mocked<typeof axios>

process.env.CONNECTOR_CONFIG = Buffer.from(JSON.stringify(mockConfig)).toString('base64')

describe('connector', () => {
    beforeEach(() => {
        jest.clearAllMocks()

        mockedAxios.post.mockResolvedValue({
            status: 202,
            data: {
                success: true,
                request_id: 'req-connector',
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

    it('uses the same major SDK version as Connector.SDK_VERSION', async () => {
        expect((await connector()).sdkVersion).toStrictEqual(Connector.SDK_VERSION)
    })

    it('executes stdTestConnection', async () => {
        await (
            await connector()
        )._exec(
            StandardCommand.StdTestConnection,
            createMockContext(),
            undefined,
            new PassThrough({ objectMode: true }).on('data', (chunk) =>
                expect(chunk).toStrictEqual(new RawResponse({}, ResponseType.Output))
            )
        )
    })
})
