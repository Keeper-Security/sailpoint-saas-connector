import axios from 'axios'
import { ConnectorError } from '@sailpoint/connector-sdk'
import { KeeperClient } from '../../../src/client/keeper-client'
import { ResourceNotFoundError } from '../../../src/utils/api-error'
import { invalidConfig, mockConfig } from '../../fixtures/mock-config'
import { mockVaultTree } from '../../fixtures/vault-tree'

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

function mockCommandSuccess(data: unknown = []) {
    mockAcceptedSubmit()
    mockedAxios.get.mockResolvedValueOnce({
        status: 200,
        data: { data, status: 'success', message: 'done', error: '' },
    })
}

function lastCommand(): string {
    const calls = mockedAxios.post.mock.calls
    return (calls[calls.length - 1][1] as { command: string }).command
}

describe('KeeperClient', () => {
    let client: KeeperClient

    beforeEach(() => {
        mockedAxios.post.mockReset()
        mockedAxios.get.mockReset()
        jest.restoreAllMocks()
        jest.spyOn(global, 'setTimeout').mockImplementation((callback: TimerHandler) => {
            if (typeof callback === 'function') callback()
            return 0 as unknown as NodeJS.Timeout
        })
        client = new KeeperClient(mockConfig)
    })

    it('rejects invalid config', () => {
        expect(() => new KeeperClient(invalidConfig)).toThrow(ConnectorError)
    })

    it('defaults pollTimeoutSeconds to 60 when omitted', () => {
        expect((new KeeperClient(mockConfig) as any).pollTimeoutMs).toBe(60_000)
    })

    it('uses pollTimeoutSeconds from config', () => {
        expect(
            (new KeeperClient({ ...mockConfig, pollTimeoutSeconds: '90' }) as any).pollTimeoutMs
        ).toBe(90_000)
    })

    it('falls back to 60 seconds for invalid pollTimeoutSeconds', () => {
        expect(
            (new KeeperClient({ ...mockConfig, pollTimeoutSeconds: 'abc' }) as any).pollTimeoutMs
        ).toBe(60_000)
        expect((new KeeperClient({ ...mockConfig, pollTimeoutSeconds: 30 }) as any).pollTimeoutMs).toBe(
            30_000
        )
        expect((new KeeperClient({ ...mockConfig, pollTimeoutSeconds: 0 }) as any).pollTimeoutMs).toBe(
            60_000
        )
        expect((new KeeperClient({ ...mockConfig, pollTimeoutSeconds: '' }) as any).pollTimeoutMs).toBe(
            60_000
        )
    })

    it('testConnection submits whoami and polls until success', async () => {
        mockAcceptedSubmit('req-123')
        mockedAxios.get
            .mockResolvedValueOnce({ status: 202, data: {} })
            .mockResolvedValueOnce({
                status: 200,
                data: {
                    data: { user: 'service@example.test' },
                    status: 'success',
                    message: 'done',
                    error: '',
                },
            })

        await expect(client.testConnection()).resolves.toStrictEqual({})

        expect(mockedAxios.post).toHaveBeenCalledWith(
            'https://keeper.example.com/api/v2/executecommand-async',
            { command: 'whoami' },
            expect.objectContaining({
                headers: {
                    'api-key': 'xxx123',
                    'Content-Type': 'application/json',
                },
            })
        )
        expect(mockedAxios.get).toHaveBeenCalledTimes(2)
    })

    it('throws when submit receives a non-202 response', async () => {
        mockedAxios.post.mockResolvedValueOnce({
            status: 400,
            data: { message: 'invalid command' },
        })
        await expect(client.testConnection()).rejects.toThrow('bad request (400): invalid command')
    })

    it('throws unexpected status when submit returns 2xx other than 202', async () => {
        mockedAxios.post.mockResolvedValueOnce({
            status: 200,
            data: { message: 'ok but sync' },
        })
        await expect(client.testConnection()).rejects.toThrow(/unexpected Keeper API response status 200/)
    })

    it('validateStatus callbacks always accept', async () => {
        mockCommandSuccess({ user: 'a@example.test' })
        await client.testConnection()
        const postCfg = mockedAxios.post.mock.calls[0][2] as { validateStatus: (s: number) => boolean }
        const getCfg = mockedAxios.get.mock.calls[0][1] as { validateStatus: (s: number) => boolean }
        expect(postCfg.validateStatus(500)).toBe(true)
        expect(getCfg.validateStatus(404)).toBe(true)
    })

    it('throws when accepted submit lacks request_id', async () => {
        mockedAxios.post.mockResolvedValueOnce({
            status: 202,
            data: { success: true, status: 'accepted' },
        })
        await expect(client.testConnection()).rejects.toThrow(/did not return request_id/)
    })

    it('throws when poll result status is not success', async () => {
        mockAcceptedSubmit()
        mockedAxios.get.mockResolvedValueOnce({
            status: 200,
            data: { data: null, status: 'failed', message: 'command failed', error: '' },
        })
        await expect(client.testConnection()).rejects.toThrow('command failed')
    })

    it('falls back to generic failure message when poll message and error are empty', async () => {
        mockAcceptedSubmit()
        mockedAxios.get.mockResolvedValueOnce({
            status: 200,
            data: { data: null, status: 'failed', message: '', error: '' },
        })
        await expect(client.testConnection()).rejects.toThrow('Keeper API request failed')
    })

    it('createUser with email only omits optional flags', async () => {
        mockCommandSuccess([])
        await client.createUser({ email: 'min@example.test' })
        expect(lastCommand()).toBe('enterprise-user "min@example.test" --add')
    })

    it('parseObjectData rethrows ConnectorError from JSON.parse path', async () => {
        mockCommandSuccess('[1,2,3]')
        await expect(client.listVaultTree()).rejects.toThrow(/not an object/)
    })

    it('maps poll 500 not found to ResourceNotFoundError', async () => {
        mockAcceptedSubmit()
        mockedAxios.get.mockResolvedValueOnce({
            status: 500,
            data: { message: 'record not found' },
        })
        await expect(client.testConnection()).rejects.toThrow(ResourceNotFoundError)
    })

    it('throws on poll timeout', async () => {
        const shortClient = new KeeperClient({ ...mockConfig, pollTimeoutSeconds: '1' })
        mockAcceptedSubmit()
        mockedAxios.get.mockResolvedValue({ status: 202, data: {} })
        const now = jest.spyOn(Date, 'now')
        now.mockReturnValueOnce(1_000).mockReturnValueOnce(1_000).mockReturnValue(3_000)
        await expect(shortClient.testConnection()).rejects.toThrow(/poll timed out/)
        now.mockRestore()
        mockedAxios.get.mockReset()
    })

    it('getWhoami caches; refreshWhoami refetches', async () => {
        mockCommandSuccess({ user: 'service@example.test' })
        await expect(client.getWhoami()).resolves.toEqual({ user: 'service@example.test' })
        await expect(client.getWhoami()).resolves.toEqual({ user: 'service@example.test' })
        expect(mockedAxios.post).toHaveBeenCalledTimes(1)

        mockCommandSuccess({ user: 'service@example.test' })
        await client.refreshWhoami()
        expect(mockedAxios.post).toHaveBeenCalledTimes(2)
    })

    it('strips trailing slash from base URL', async () => {
        const slashClient = new KeeperClient({
            ...mockConfig,
            serviceModeApiUrl: 'https://keeper.example.com/',
        })
        mockCommandSuccess({ user: 'a@example.test' })
        await slashClient.testConnection()
        expect(mockedAxios.post.mock.calls[0][0]).toBe(
            'https://keeper.example.com/api/v2/executecommand-async'
        )
    })

    it('listUsers parses array and string payloads', async () => {
        mockCommandSuccess([{ user_id: 1, email: 'a@example.test' }])
        await expect(client.listUsers()).resolves.toEqual([{ user_id: 1, email: 'a@example.test' }])

        mockCommandSuccess(JSON.stringify([{ user_id: 2, email: 'b@example.test' }]))
        await expect(client.listUsers()).resolves.toEqual([{ user_id: 2, email: 'b@example.test' }])

        mockCommandSuccess('   ')
        await expect(client.listUsers()).resolves.toEqual([])

        mockCommandSuccess(null)
        await expect(client.listUsers()).resolves.toEqual([])

        mockCommandSuccess('{"not":"array"}')
        await expect(client.listUsers()).rejects.toThrow(/not an array/)

        mockCommandSuccess('{bad')
        await expect(client.listUsers()).rejects.toThrow(/Failed to parse/)

        mockCommandSuccess(42)
        await expect(client.listUsers()).rejects.toThrow(/Unexpected Keeper users/)
    })

    it('getUser matches exact email and rejects empty', async () => {
        await expect(client.getUser('  ')).rejects.toThrow(/empty email/)
        mockCommandSuccess([
            { user_id: 1, email: 'alice@example.test' },
            { user_id: 2, email: 'alice@example.test.extra' },
        ])
        await expect(client.getUser('Alice@Example.test')).resolves.toEqual({
            user_id: 1,
            email: 'alice@example.test',
        })
        mockCommandSuccess([{ user_id: 2, email: 'other@example.test' }])
        await expect(client.getUser('alice@example.test')).resolves.toBeNull()
    })

    it('lock/unlock/delete/sync/list commands', async () => {
        mockCommandSuccess([])
        await client.lockUser('a@example.test')
        mockCommandSuccess([])
        await client.unlockUser('a@example.test')
        mockCommandSuccess([])
        await client.deleteUser('a@example.test')
        mockCommandSuccess([])
        await client.syncEnterprise()
        mockCommandSuccess([])
        await client.syncVault()
        mockCommandSuccess([])
        await client.listTeams()
        mockCommandSuccess([])
        await client.listRoles()
        mockCommandSuccess([])
        await client.listNodes()
        expect(lastCommand()).toContain('enterprise-info --nodes')
    })

    it('createUser and updateUser emit optional flags', async () => {
        mockCommandSuccess([])
        await client.createUser({
            email: 'new@example.test',
            name: 'New "User"',
            jobTitle: 'Eng',
            nodeId: '100',
            addRoleValues: ['1'],
            addTeamValues: ['t1'],
        })
        expect(lastCommand()).toContain('--add')
        expect(lastCommand()).toContain('--name "New \\"User\\""')
        expect(lastCommand()).toContain('--add-role "1"')

        mockedAxios.post.mockClear()
        await client.updateUser({ email: 'a@example.test' })
        expect(mockedAxios.post).not.toHaveBeenCalled()

        mockCommandSuccess([])
        await client.updateUser({
            email: 'a@example.test',
            name: 'N',
            jobTitle: '',
            nodeId: '2',
            removeRoleValues: ['1'],
            removeTeamValues: ['t'],
            addRoleValues: ['2'],
            addTeamValues: ['t2'],
        })
        const cmd = lastCommand()
        expect(cmd).toContain('--remove-role')
        expect(cmd).toContain('--add-team')
    })

    it('updateRecordPermissions covers classic/nsf codes and rejects OW/invalid', async () => {
        for (const id of [
            'r1:RO',
            'r1:CE',
            'r1:CS',
            'r1:VW',
            'r1:SM',
            'r1:FM',
            'r1:CSM',
            'r1:CM',
        ]) {
            mockCommandSuccess([])
            await client.updateRecordPermissions({ email: 'a@example.test', addRecordValues: [id] })
        }
        mockCommandSuccess([])
        await client.updateRecordPermissions({
            email: 'a@example.test',
            removeRecordValues: ['r1:RO'],
        })
        expect(lastCommand()).toContain('--action revoke')

        await expect(
            client.updateRecordPermissions({ email: 'a@example.test', addRecordValues: ['r1:OW'] })
        ).rejects.toThrow(/Ownership change is restricted/)
        await expect(
            client.updateRecordPermissions({ email: 'a@example.test', addRecordValues: ['r1:XX'] })
        ).rejects.toThrow(/Invalid permission/)
    })

    it('listVaultTree / listAllFolders and folder share commands', async () => {
        mockCommandSuccess(mockVaultTree)
        await expect(client.listVaultTree()).resolves.toEqual(mockVaultTree)

        mockCommandSuccess(JSON.stringify(mockVaultTree))
        await expect(client.listVaultTree()).resolves.toEqual(mockVaultTree)

        mockCommandSuccess('   ')
        await expect(client.listVaultTree()).rejects.toThrow(/empty/)
        mockCommandSuccess('123')
        await expect(client.listVaultTree()).rejects.toThrow(/not an object \(got number\)/)
        mockCommandSuccess('null')
        await expect(client.listVaultTree()).rejects.toThrow(/not an object/)
        mockCommandSuccess('{bad')
        await expect(client.listVaultTree()).rejects.toThrow(/Failed to parse/)
        mockCommandSuccess(null)
        await expect(client.listVaultTree()).rejects.toThrow(/Unexpected Keeper vaultTree/)

        mockCommandSuccess(mockVaultTree)
        const folders = await client.listAllFolders()
        expect(folders.some((f) => f.uid === 'sf-classic-001')).toBe(true)

        mockCommandSuccess([])
        await client.grantClassicFolderShare('sf-1', 'a@example.test', 'on', 'off')
        expect(lastCommand()).toContain('share-folder -a grant')

        mockCommandSuccess([])
        await client.removeClassicFolderShare('sf-1', 'a@example.test')
        expect(lastCommand()).toContain('share-folder -a remove')

        mockCommandSuccess([])
        await client.grantNsfFolderShare('nsf-1', 'a@example.test', 'viewer')
        expect(lastCommand()).toContain('nsf-share-folder -a grant')

        mockCommandSuccess([])
        await client.removeNsfFolderShare('nsf-1', 'a@example.test')
        expect(lastCommand()).toContain('nsf-share-folder -a remove')
    })
})
