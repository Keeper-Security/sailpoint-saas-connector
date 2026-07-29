import { ConnectorError, ConnectorErrorType } from '@sailpoint/connector-sdk'
import { createAccountCreateHandler } from '../../../src/handlers/account-create'
import { createAccountDeleteHandler } from '../../../src/handlers/account-delete'
import { createAccountDisableHandler, createAccountEnableHandler } from '../../../src/handlers/account-lock'
import { createAccountListHandler } from '../../../src/handlers/account-list'
import { createAccountReadHandler } from '../../../src/handlers/account-read'
import { createEntitlementListHandler } from '../../../src/handlers/entitlement-list'
import { createEntitlementReadHandler } from '../../../src/handlers/entitlement-read'
import { asKeeperClient, createMockKeeperClient } from '../../helpers/mock-keeper-client'
import { createMockContext } from '../../helpers/mock-context'
import { createMockResponse } from '../../helpers/mock-response'
import { mockVaultTree } from '../../fixtures/vault-tree'

const alice = {
    user_id: 1,
    email: 'alice@example.test',
    name: 'Alice',
    status: 'Active',
    node: '100',
    teams: ['team-uid-001'],
    roles: ['1'],
}

const nodes = [
    { node_id: 100, name: 'Root' },
    { node_id: 200, name: 'Eng', parent_id: 100, parent_node: 'Root' },
]
const teams = [{ team_uid: 'team-uid-001', name: 'Alpha', node: 'Root' }]
const roles = [{ role_id: 1, name: 'User', node: 'Root' }]

describe('account handlers', () => {
    it('account-list sends mapped users', async () => {
        const client = createMockKeeperClient({
            listUsers: jest.fn().mockResolvedValue([alice]),
            listVaultTree: jest.fn().mockResolvedValue(mockVaultTree),
        })
        const { res, sent } = createMockResponse()
        await createAccountListHandler(asKeeperClient(client))(createMockContext(), {} as any, res)
        expect(sent).toHaveLength(1)
        expect(sent[0].identity).toBe('alice@example.test')
        expect(client.syncEnterprise).toHaveBeenCalled()
        expect(client.syncVault).toHaveBeenCalled()
    })

    it('account-read resolves email and returns view', async () => {
        const client = createMockKeeperClient({
            getUser: jest.fn().mockResolvedValue(alice),
            listVaultTree: jest.fn().mockResolvedValue(mockVaultTree),
        })
        const { res, sent } = createMockResponse()
        await createAccountReadHandler(asKeeperClient(client))(
            createMockContext(),
            { identity: 'alice@example.test' } as any,
            res
        )
        expect(sent[0].uuid).toBe('1')
    })

    it('account-create validates and creates', async () => {
        const client = createMockKeeperClient({
            getUser: jest.fn().mockResolvedValue({ ...alice, status: 'Invited' }),
            listVaultTree: jest.fn().mockResolvedValue(mockVaultTree),
        })
        const handler = createAccountCreateHandler(asKeeperClient(client))

        await expect(
            handler(createMockContext(), { attributes: {} } as any, createMockResponse().res)
        ).rejects.toThrow(/requires an email/)
        await expect(
            handler(createMockContext(), {} as any, createMockResponse().res)
        ).rejects.toThrow(/requires an email/)
        await expect(
            handler(
                createMockContext(),
                { attributes: { email: 'new@example.test' } } as any,
                createMockResponse().res
            )
        ).rejects.toThrow(/missing required attribute "name"/)
        await expect(
            handler(
                createMockContext(),
                { attributes: { email: 'new@example.test', name: 'New' } } as any,
                createMockResponse().res
            )
        ).rejects.toThrow(/missing required attribute "node"/)

        const { res, sent } = createMockResponse()
        await handler(
            createMockContext(),
            {
                attributes: {
                    email: 'new@example.test',
                    name: 'New User',
                    node: ['100'],
                    jobTitle: 'Engineer',
                    roles: ['1'],
                    teams: ['team-uid-001'],
                },
            } as any,
            res
        )
        expect(client.createUser).toHaveBeenCalledWith(
            expect.objectContaining({
                email: 'new@example.test',
                name: 'New User',
                nodeId: '100',
                addRoleValues: ['1'],
                addTeamValues: ['team-uid-001'],
            })
        )
        expect(sent[0].attributes.status).toBe('Invited')

        const { res: resId } = createMockResponse()
        await handler(
            createMockContext(),
            {
                identity: 'via-identity@example.test',
                attributes: { name: 'Via Identity', node: '100' },
            } as any,
            resId
        )
        expect(client.createUser).toHaveBeenCalledWith(
            expect.objectContaining({
                email: 'via-identity@example.test',
                name: 'Via Identity',
                nodeId: '100',
            })
        )
        expect(client.createUser.mock.calls.at(-1)?.[0]).not.toHaveProperty('addRoleValues')
    })

    it('account-delete is idempotent and blocks service account', async () => {
        const client = createMockKeeperClient({
            getUser: jest.fn().mockResolvedValueOnce(null),
        })
        const { res, sent } = createMockResponse()
        await createAccountDeleteHandler(asKeeperClient(client))(
            createMockContext(),
            { identity: 'gone@example.test' } as any,
            res
        )
        expect(sent).toEqual([{}])
        expect(client.deleteUser).not.toHaveBeenCalled()

        client.getUser.mockResolvedValueOnce(alice)
        client.getWhoami.mockResolvedValueOnce({ user: 'alice@example.test' })
        await expect(
            createAccountDeleteHandler(asKeeperClient(client))(
                createMockContext(),
                { identity: 'alice@example.test' } as any,
                createMockResponse().res
            )
        ).rejects.toThrow(/Commander service account/)

        client.getUser.mockResolvedValueOnce(alice)
        client.getWhoami.mockResolvedValueOnce({ user: 'service@example.test' })
        const { res: resOk, sent: sentOk } = createMockResponse()
        await createAccountDeleteHandler(asKeeperClient(client))(
            createMockContext(),
            { identity: 'alice@example.test' } as any,
            resOk
        )
        expect(client.deleteUser).toHaveBeenCalledWith('alice@example.test')
        expect(sentOk).toEqual([{}])
    })

    it('account enable/disable lock and unlock', async () => {
        const client = createMockKeeperClient({
            getUser: jest.fn().mockResolvedValue(alice),
            listVaultTree: jest.fn().mockResolvedValue(mockVaultTree),
        })
        const { res: resDis } = createMockResponse()
        await createAccountDisableHandler(asKeeperClient(client))(
            createMockContext(),
            { identity: 'alice@example.test' } as any,
            resDis
        )
        expect(client.lockUser).toHaveBeenCalledWith('alice@example.test')

        const { res: resEn } = createMockResponse()
        await createAccountEnableHandler(asKeeperClient(client))(
            createMockContext(),
            { identity: 'alice@example.test' } as any,
            resEn
        )
        expect(client.unlockUser).toHaveBeenCalledWith('alice@example.test')
    })
})

describe('entitlement handlers', () => {
    it('entitlement-list covers all types and rejects unknown', async () => {
        const client = createMockKeeperClient({
            listVaultTree: jest.fn().mockResolvedValue(mockVaultTree),
            listNodes: jest.fn().mockResolvedValue(nodes),
            listTeams: jest.fn().mockResolvedValue(teams),
            listRoles: jest.fn().mockResolvedValue(roles),
        })
        const handler = createEntitlementListHandler(asKeeperClient(client))

        for (const type of ['node', 'team', 'role', 'record', 'folder'] as const) {
            const { res, sent } = createMockResponse()
            await handler(createMockContext(), { type } as any, res)
            expect(sent.length).toBeGreaterThan(0)
        }

        const { res: resOrphanTeam, sent: orphanTeams } = createMockResponse()
        client.listTeams.mockResolvedValueOnce([
            { team_uid: 'team-without-folders', name: 'Orphan' },
        ])
        await handler(createMockContext(), { type: 'team' } as any, resOrphanTeam)
        expect(orphanTeams[0].attributes.folders).toEqual([])

        await expect(
            handler(createMockContext(), { type: 'unknown' } as any, createMockResponse().res)
        ).rejects.toThrow(/Unsupported entitlement type/)
    })

    it('entitlement-read covers types and error paths', async () => {
        const folders = [
            {
                uid: 'sf-classic-001',
                name: 'Classic Shared',
                path: 'Classic Shared',
                folderType: 'classic' as const,
            },
            {
                uid: 'folder-plain-001',
                name: 'Nested Plain',
                path: 'Classic Shared/Nested Plain',
                folderType: 'non-sharable' as const,
            },
        ]
        const client = createMockKeeperClient({
            listNodes: jest.fn().mockResolvedValue(nodes),
            listTeams: jest.fn().mockResolvedValue(teams),
            listRoles: jest.fn().mockResolvedValue(roles),
            listVaultTree: jest.fn().mockResolvedValue(mockVaultTree),
            listAllFolders: jest.fn().mockResolvedValue(folders),
        })
        const handler = createEntitlementReadHandler(asKeeperClient(client))

        await expect(
            handler(createMockContext(), { type: 'node' } as any, createMockResponse().res)
        ).rejects.toThrow(/without an identity/)
        await expect(
            handler(createMockContext(), {} as any, createMockResponse().res)
        ).rejects.toThrow(/type: unknown/)

        const { res: rKey, sent: sKey } = createMockResponse()
        await handler(
            createMockContext(),
            { type: 'node', key: { simple: { id: '100' } } } as any,
            rKey
        )
        expect(sKey[0].type).toBe('node')

        const { res: rNode, sent: sNode } = createMockResponse()
        await handler(createMockContext(), { type: 'node', identity: '100' } as any, rNode)
        expect(sNode[0].type).toBe('node')

        await expect(
            handler(createMockContext(), { type: 'node', identity: '999' } as any, createMockResponse().res)
        ).rejects.toThrow(/not found/)

        const { res: rTeam, sent: sTeam } = createMockResponse()
        await handler(createMockContext(), { type: 'team', identity: 'team-uid-001' } as any, rTeam)
        expect(sTeam[0].type).toBe('team')
        await expect(
            handler(createMockContext(), { type: 'team', identity: 'missing' } as any, createMockResponse().res)
        ).rejects.toThrow(/not found/)

        const { res: rRole, sent: sRole } = createMockResponse()
        await handler(createMockContext(), { type: 'role', identity: '1' } as any, rRole)
        expect(sRole[0].type).toBe('role')
        await expect(
            handler(createMockContext(), { type: 'role', identity: '99' } as any, createMockResponse().res)
        ).rejects.toThrow(/not found/)

        const { res: rFolder, sent: sFolder } = createMockResponse()
        await handler(
            createMockContext(),
            { type: 'folder', identity: 'sf-classic-001:MU' } as any,
            rFolder
        )
        expect(sFolder[0].attributes.permission).toBe('MU')

        const { res: rPlain, sent: sPlain } = createMockResponse()
        await handler(createMockContext(), { type: 'folder', identity: 'folder-plain-001' } as any, rPlain)
        expect(sPlain[0].attributes.folderType).toBe('non-sharable')

        await expect(
            handler(
                createMockContext(),
                { type: 'folder', identity: 'folder-plain-001:MU' } as any,
                createMockResponse().res
            )
        ).rejects.toThrow(/raw uid/)
        await expect(
            handler(
                createMockContext(),
                { type: 'folder', identity: 'sf-classic-001:VW' } as any,
                createMockResponse().res
            )
        ).rejects.toThrow(/Invalid permission/)
        await expect(
            handler(
                createMockContext(),
                { type: 'folder', identity: 'sf-classic-001' } as any,
                createMockResponse().res
            )
        ).rejects.toThrow(/Invalid permission ""/)
        await expect(
            handler(
                createMockContext(),
                { type: 'folder', identity: 'missing:MU' } as any,
                createMockResponse().res
            )
        ).rejects.toThrow(ConnectorError)
        await expect(
            handler(createMockContext(), { type: 'record', identity: 'x' } as any, createMockResponse().res)
        ).rejects.toThrow(/Unsupported entitlement type/)
    })
})
