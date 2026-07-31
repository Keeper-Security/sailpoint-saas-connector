import { ConnectorError } from '@sailpoint/connector-sdk'
import { requireConfigValue } from '../../../src/utils/errors'
import { resolveAccountEmail, safeKeyId } from '../../../src/utils/identity'
import { handleAPIErrorResponse, ResourceNotFoundError } from '../../../src/utils/api-error'
import { AxiosResponse } from 'axios'
import { loadAccountView } from '../../../src/utils/account-view'
import { asKeeperClient, createMockKeeperClient } from '../../helpers/mock-keeper-client'
import { mockVaultTree } from '../../fixtures/vault-tree'

describe('errors.requireConfigValue', () => {
    it('returns value or throws', () => {
        expect(requireConfigValue('x', 'apiUrl')).toBe('x')
        expect(() => requireConfigValue('', 'apiUrl')).toThrow(ConnectorError)
        expect(() => requireConfigValue(null, 'apiUrl')).toThrow(/apiUrl must be provided/)
        expect(() => requireConfigValue(undefined, 'apiKey')).toThrow(/apiKey must be provided/)
    })
})

describe('identity', () => {
    it('safeKeyId returns null without key or on KeyID throw', () => {
        expect(safeKeyId(null)).toBeNull()
        expect(safeKeyId({})).toBeNull()
        expect(safeKeyId({ key: { simple: { id: 'a@example.test' } } as any })).toBe('a@example.test')
        expect(safeKeyId({ key: { invalid: true } as any })).toBeNull()
    })

    it('resolveAccountEmail prefers key then identity', () => {
        expect(
            resolveAccountEmail(
                { key: { simple: { id: 'key@example.test' } } as any, identity: 'id@example.test' },
                'std:account:read'
            )
        ).toBe('key@example.test')
        expect(resolveAccountEmail({ identity: 'id@example.test' }, 'std:account:read')).toBe(
            'id@example.test'
        )
        expect(() => resolveAccountEmail({}, 'std:account:read')).toThrow(/without an identity/)
    })
})

describe('api-error extract paths', () => {
    it('handles string body, missing message, and 500 non-not-found', () => {
        expect(() =>
            handleAPIErrorResponse({ status: 400, data: 'plain error' } as AxiosResponse)
        ).toThrow('bad request (400): plain error')
        expect(() => handleAPIErrorResponse({ status: 400, data: null } as AxiosResponse)).toThrow(
            'bad request (400): '
        )
        expect(() =>
            handleAPIErrorResponse({ status: 500, data: { message: 'boom' } } as AxiosResponse)
        ).toThrow('internal server error (500): boom')
        expect(() =>
            handleAPIErrorResponse({ status: 500, data: { message: 'NOT FOUND' } } as AxiosResponse)
        ).toThrow(ResourceNotFoundError)
    })

    it('stringifies object bodies without message/error', () => {
        expect(() =>
            handleAPIErrorResponse({ status: 418, data: { code: 1 } } as AxiosResponse)
        ).toThrow(/status 418/)
    })

    it('falls back when JSON.stringify throws', () => {
        const circular: any = {}
        circular.self = circular
        expect(() =>
            handleAPIErrorResponse({ status: 418, data: circular } as AxiosResponse)
        ).toThrow(/status 418/)
    })
})

describe('loadAccountView', () => {
    it('throws NotFound when user missing', async () => {
        const client = createMockKeeperClient({ getUser: jest.fn().mockResolvedValue(null) })
        await expect(loadAccountView(asKeeperClient(client), 'missing@example.test')).rejects.toThrow(
            /not found/
        )
        await expect(
            loadAccountView(asKeeperClient(client), 'missing@example.test', {
                notFoundMessage: 'still propagating',
            })
        ).rejects.toThrow('still propagating')
    })

    it('builds account from user + vault tree', async () => {
        const client = createMockKeeperClient({
            getUser: jest.fn().mockResolvedValue({
                user_id: 1,
                email: 'alice@example.test',
                name: 'Alice',
                status: 'Active',
                node: '100',
                teams: ['team-uid-001'],
                roles: ['1'],
            }),
            listVaultTree: jest.fn().mockResolvedValue(mockVaultTree),
        })
        const account = await loadAccountView(asKeeperClient(client), 'alice@example.test')
        expect(account.identity).toBe('alice@example.test')
        expect(account.attributes.folders).toEqual(
            expect.arrayContaining(['sf-classic-001:MUR', 'nsf-folder-001:FM'])
        )
        expect(account.attributes.records as string[]).toEqual(expect.any(Array))
        expect((account.attributes.records as string[]).length).toBeGreaterThan(0)
        expect(client.listVaultTree).toHaveBeenCalled()
    })

    it('reuses provided vaultTree without listing again', async () => {
        const client = createMockKeeperClient({
            getUser: jest.fn().mockResolvedValue({
                user_id: 2,
                email: 'bob@example.test',
                status: 'Invited',
            }),
        })
        const account = await loadAccountView(asKeeperClient(client), 'bob@example.test', {
            vaultTree: mockVaultTree,
        })
        expect(account.disabled).toBe(true)
        expect(client.listVaultTree).not.toHaveBeenCalled()
    })
})
