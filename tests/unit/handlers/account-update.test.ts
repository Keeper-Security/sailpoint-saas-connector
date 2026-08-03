import {
    AttributeChangeOp,
    ConnectorError,
    ConnectorErrorType,
} from '@sailpoint/connector-sdk'
import {
    assertAtMostOneNodeAssign,
    buildUpdatePlan,
    emptyDelta,
    hasDeltaWork,
    hasUserMutation,
    hasWork,
    loadCurrentMemberships,
    primaryUserMutationAttribute,
    toUserUpdateOptions,
} from '../../../src/handlers/account-update/plan'
import { applyUpdatePlan } from '../../../src/handlers/account-update/apply'
import {
    errorMessage,
    formatAggregatedError,
    toAttributeResults,
} from '../../../src/handlers/account-update/errors'
import { createAccountUpdateHandler } from '../../../src/handlers/account-update'
import { asKeeperClient, createMockKeeperClient } from '../../helpers/mock-keeper-client'
import { createMockContext } from '../../helpers/mock-context'
import { createMockResponse } from '../../helpers/mock-response'
import { mockVaultTree } from '../../fixtures/vault-tree'
import { KeeperFolder } from '../../../src/model/keeper-entities'

const alice = {
    user_id: 1,
    email: 'alice@example.test',
    name: 'Alice',
    status: 'Active',
    node: '100',
    teams: ['team-uid-001'],
    roles: ['1', '2'],
}

const classicFolder: KeeperFolder = {
    uid: 'sf-classic-001',
    name: 'Classic Shared',
    path: 'Classic Shared',
    folderType: 'classic',
}

const nsfFolder: KeeperFolder = {
    uid: 'nsf-folder-001',
    name: 'NSF Drive',
    path: 'NSF Drive',
    folderType: 'nsf',
}

const plainFolder: KeeperFolder = {
    uid: 'folder-plain-001',
    name: 'Nested Plain',
    path: 'Classic Shared/Nested Plain',
    folderType: 'non-sharable',
}

describe('account-update/plan', () => {
    it('delta helpers', () => {
        expect(hasDeltaWork(emptyDelta())).toBe(false)
        expect(hasDeltaWork({ adds: new Set(['a']), removes: new Set() })).toBe(true)
        expect(hasUserMutation({ email: 'a@example.test' })).toBe(false)
        expect(hasUserMutation({ email: 'a@example.test', nodeId: '1' })).toBe(true)
        expect(hasUserMutation({ email: 'a@example.test', name: 'A' })).toBe(true)
        expect(hasUserMutation({ email: 'a@example.test', addAliasValues: ['a@x.test'] })).toBe(true)
        expect(primaryUserMutationAttribute({ email: 'a', addAliasValues: ['b@x.test'] })).toBe('email')
        expect(primaryUserMutationAttribute({ email: 'a', name: 'A' })).toBe('name')
        expect(primaryUserMutationAttribute({ email: 'a', jobTitle: 'Eng' })).toBe('jobTitle')
        expect(primaryUserMutationAttribute({ email: 'a', nodeId: '1' })).toBe('node')
        expect(primaryUserMutationAttribute({ email: 'a', addRoleValues: ['1'] })).toBe('roles')
        expect(primaryUserMutationAttribute({ email: 'a', addTeamValues: ['t'] })).toBe('teams')
    })

    it('assertAtMostOneNodeAssign', () => {
        expect(() =>
            assertAtMostOneNodeAssign([
                { attribute: 'node', op: AttributeChangeOp.Set, value: '1' },
                { attribute: 'node', op: AttributeChangeOp.Add, value: '2' },
            ])
        ).toThrow(/at most one/)
        expect(() =>
            assertAtMostOneNodeAssign([{ attribute: 'node', op: AttributeChangeOp.Remove, value: '1' }])
        ).not.toThrow()
    })

    it('buildUpdatePlan covers set/add/remove including profile fields', () => {
        const plan = buildUpdatePlan(
            'alice@example.test',
            [
                { attribute: 'node', op: AttributeChangeOp.Set, value: '200' },
                { attribute: 'node', op: AttributeChangeOp.Remove, value: '100' },
                { attribute: 'roles', op: AttributeChangeOp.Add, value: ['3'] },
                { attribute: 'roles', op: AttributeChangeOp.Remove, value: '1' },
                { attribute: 'teams', op: AttributeChangeOp.Set, value: ['team-uid-002'] },
                { attribute: 'folders', op: AttributeChangeOp.Add, value: 'sf-classic-001:MU' },
                { attribute: 'records', op: AttributeChangeOp.Remove, value: 'rec-classic-001:RO' },
                { attribute: 'email', op: AttributeChangeOp.Set, value: 'alice@example.test' },
                { attribute: 'name', op: AttributeChangeOp.Set, value: 'Alice Updated' },
                { attribute: 'jobTitle', op: AttributeChangeOp.Set, value: 'Engineer' },
                { attribute: 'customAttr', op: AttributeChangeOp.Set, value: 'x' },
            ],
            {
                roleIds: ['1', '2'],
                teamIds: ['team-uid-001'],
                folderIds: ['sf-classic-001:MUR'],
                recordIds: ['rec-classic-001:RO'],
            }
        )

        expect(plan.opts.nodeId).toBe('200')
        expect(plan.opts.name).toBe('Alice Updated')
        expect(plan.opts.jobTitle).toBe('Engineer')
        expect(plan.opts.addAliasValues).toBeUndefined()
        expect([...plan.roles.adds]).toEqual(['3'])
        expect([...plan.roles.removes]).toEqual(['1'])
        expect([...plan.teams.adds]).toEqual(['team-uid-002'])
        expect([...plan.teams.removes]).toEqual(['team-uid-001'])
        expect([...plan.folders.adds]).toEqual(['sf-classic-001:MU'])
        expect([...plan.records.removes]).toEqual(['rec-classic-001:RO'])
        expect(hasWork(plan)).toBe(true)
        expect(toUserUpdateOptions(plan).addRoleValues).toEqual(['3'])
    })

    it('maps email Set to Keeper --add-alias rename', () => {
        const plan = buildUpdatePlan(
            'alice@example.test',
            [{ attribute: 'email', op: AttributeChangeOp.Set, value: 'alice.new@example.test' }],
            { roleIds: [], teamIds: [], folderIds: [], recordIds: [] }
        )
        expect(plan.opts.addAliasValues).toEqual(['alice.new@example.test'])
        expect(hasWork(plan)).toBe(true)
    })

    it('rejects aliases attribute changes', () => {
        expect(() =>
            buildUpdatePlan(
                'alice@example.test',
                [{ attribute: 'aliases', op: AttributeChangeOp.Add, value: 'alias@example.test' }],
                { roleIds: [], teamIds: [], folderIds: [], recordIds: [] }
            )
        ).toThrow(/cannot manage "aliases"/)
    })

    it('loadCurrentMemberships loads only what Set ops need', async () => {
        const client = createMockKeeperClient({
            getUser: jest.fn().mockResolvedValue({ ...alice, alias: ['a@example.test'] }),
            listVaultTree: jest.fn().mockResolvedValue(mockVaultTree),
        })
        const current = await loadCurrentMemberships(asKeeperClient(client), 'alice@example.test', [
            { attribute: 'roles', op: AttributeChangeOp.Set, value: ['1'] },
            { attribute: 'folders', op: AttributeChangeOp.Set, value: [] },
            { attribute: 'records', op: AttributeChangeOp.Set, value: [] },
        ])
        expect(current.roleIds).toEqual(['1', '2'])
        expect(current.folderIds).toEqual(
            expect.arrayContaining(['sf-classic-001:MUR', 'nsf-folder-001:FM'])
        )
        expect(current.recordIds.length).toBeGreaterThan(0)

        await expect(
            loadCurrentMemberships(
                asKeeperClient(
                    createMockKeeperClient({ getUser: jest.fn().mockResolvedValue(null) })
                ),
                'missing@example.test',
                [{ attribute: 'teams', op: AttributeChangeOp.Set, value: [] }]
            )
        ).rejects.toThrow(ConnectorError)

        const sparse = await loadCurrentMemberships(
            asKeeperClient(
                createMockKeeperClient({
                    getUser: jest.fn().mockResolvedValue({
                        user_id: 9,
                        email: 'nobody@example.test',
                    }),
                    listVaultTree: jest.fn().mockResolvedValue(mockVaultTree),
                })
            ),
            'nobody@example.test',
            [
                { attribute: 'roles', op: AttributeChangeOp.Set, value: [] },
                { attribute: 'folders', op: AttributeChangeOp.Set, value: [] },
            ]
        )
        expect(sparse.roleIds).toEqual([])
        expect(sparse.teamIds).toEqual([])
        expect(sparse.folderIds).toEqual([])
    })
})

describe('account-update/errors', () => {
    it('formats failures and attribute results', () => {
        expect(errorMessage(new Error('boom'))).toBe('boom')
        expect(errorMessage('raw')).toBe('raw')
        const failures = [
            { attribute: 'folders', action: 'grant folder share', target: 'a:MU', message: 'nope' },
            { attribute: 'folders', action: 'remove folder share', target: 'b:NP', message: 'gone' },
            { attribute: 'records', action: 'grant record share', target: 'r:RO', message: 'fail' },
        ]
        const results = toAttributeResults(failures)
        expect(results).toHaveLength(2)
        expect(results[0].messages).toHaveLength(2)
        expect(formatAggregatedError('alice@example.test', failures)).toContain('partially failed')
    })
})

describe('account-update/apply', () => {
    it('applies user, classic/nsf folder, and record changes', async () => {
        const client = createMockKeeperClient({
            listAllFolders: jest.fn().mockResolvedValue([classicFolder, nsfFolder, plainFolder]),
        })
        const failures = await applyUpdatePlan(asKeeperClient(client), 'alice@example.test', {
            opts: { email: 'alice@example.test', nodeId: '200' },
            roles: emptyDelta(),
            teams: emptyDelta(),
            folders: {
                adds: new Set(['sf-classic-001:MU', 'nsf-folder-001:VW']),
                removes: new Set(['sf-classic-001:MUR', 'nsf-folder-001:FM']),
            },
            records: {
                adds: new Set(['rec-classic-001:RO']),
                removes: new Set(['rec-nsf-001:VW']),
            },
        })
        expect(failures).toEqual([])
        expect(client.updateUser).toHaveBeenCalled()
        // Same-uid remove skipped when also granting
        expect(client.removeClassicFolderShare).not.toHaveBeenCalled()
        expect(client.removeNsfFolderShare).not.toHaveBeenCalled()
        expect(client.grantClassicFolderShare).toHaveBeenCalledWith(
            'sf-classic-001',
            'alice@example.test',
            'on',
            'off'
        )
        expect(client.grantNsfFolderShare).toHaveBeenCalledWith(
            'nsf-folder-001',
            'alice@example.test',
            'viewer'
        )
        expect(client.updateRecordPermissions).toHaveBeenCalledTimes(2)
    })

    it('removes folder shares when not also granting same uid', async () => {
        const client = createMockKeeperClient({
            listAllFolders: jest.fn().mockResolvedValue([classicFolder, nsfFolder]),
        })
        await applyUpdatePlan(asKeeperClient(client), 'alice@example.test', {
            opts: { email: 'alice@example.test' },
            roles: emptyDelta(),
            teams: emptyDelta(),
            folders: {
                adds: new Set(),
                removes: new Set(['sf-classic-001:MUR', 'nsf-folder-001:FM']),
            },
            records: emptyDelta(),
        })
        expect(client.removeClassicFolderShare).toHaveBeenCalledWith(
            'sf-classic-001',
            'alice@example.test'
        )
        expect(client.removeNsfFolderShare).toHaveBeenCalledWith('nsf-folder-001', 'alice@example.test')
    })

    it('collects folder remove failures', async () => {
        const client = createMockKeeperClient({
            listAllFolders: jest.fn().mockResolvedValue([classicFolder]),
            removeClassicFolderShare: jest.fn().mockRejectedValue(new Error('remove denied')),
        })
        const failures = await applyUpdatePlan(asKeeperClient(client), 'alice@example.test', {
            opts: { email: 'alice@example.test' },
            roles: emptyDelta(),
            teams: emptyDelta(),
            folders: { adds: new Set(), removes: new Set(['sf-classic-001:MUR']) },
            records: emptyDelta(),
        })
        expect(failures).toEqual([
            expect.objectContaining({ action: 'remove folder share', message: 'remove denied' }),
        ])
    })

    it('collects partial failures for folders and records', async () => {
        const client = createMockKeeperClient({
            listAllFolders: jest.fn().mockResolvedValue([classicFolder, plainFolder]),
            updateUser: jest.fn().mockRejectedValue(new Error('enterprise fail')),
            updateRecordPermissions: jest.fn().mockRejectedValue(new Error('record fail')),
        })
        const failures = await applyUpdatePlan(asKeeperClient(client), 'alice@example.test', {
            opts: { email: 'alice@example.test', addRoleValues: ['9'] },
            roles: { adds: new Set(['9']), removes: new Set() },
            teams: emptyDelta(),
            folders: {
                adds: new Set(['missing:MU', 'folder-plain-001', 'sf-classic-001:XX']),
                removes: new Set(['missing:NP', 'folder-plain-001']),
            },
            records: {
                adds: new Set(['rec-classic-001:RO']),
                removes: new Set(['rec-classic-001:CE']),
            },
        })
        expect(failures.some((f) => f.attribute === 'roles' || f.attribute === 'teams')).toBe(true)
        expect(failures.filter((f) => f.attribute === 'folders').length).toBeGreaterThan(0)
        expect(failures.filter((f) => f.attribute === 'records')).toHaveLength(2)
    })

    it('renames email via --add-alias after other mutations', async () => {
        const client = createMockKeeperClient()
        const failures = await applyUpdatePlan(asKeeperClient(client), 'alice@example.test', {
            opts: {
                email: 'alice@example.test',
                name: 'Alice Updated',
                addAliasValues: ['alice.new@example.test'],
            },
            roles: emptyDelta(),
            teams: emptyDelta(),
            folders: emptyDelta(),
            records: emptyDelta(),
        })
        expect(failures).toEqual([])
        expect(client.updateUser).toHaveBeenCalledTimes(2)
        expect(client.updateUser).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                email: 'alice@example.test',
                name: 'Alice Updated',
            })
        )
        expect(client.updateUser.mock.calls[0][0].addAliasValues).toBeUndefined()
        expect(client.updateUser).toHaveBeenNthCalledWith(2, {
            email: 'alice@example.test',
            addAliasValues: ['alice.new@example.test'],
        })
    })
})

describe('account-update handler', () => {
    it('returns current state when changes are empty or no-op', async () => {
        const client = createMockKeeperClient({
            getUser: jest.fn().mockResolvedValue(alice),
            listVaultTree: jest.fn().mockResolvedValue(mockVaultTree),
        })
        const { res, sent } = createMockResponse()
        await createAccountUpdateHandler(asKeeperClient(client))(
            createMockContext(),
            { identity: 'alice@example.test' } as any,
            res
        )
        expect(sent).toHaveLength(1)
        expect(sent[0].identity).toBe('alice@example.test')

        const { res: res2, sent: sent2 } = createMockResponse()
        await createAccountUpdateHandler(asKeeperClient(client))(
            createMockContext(),
            {
                identity: 'alice@example.test',
                changes: [{ attribute: 'status', op: AttributeChangeOp.Set, value: 'Locked' }],
            } as any,
            res2
        )
        expect(sent2).toHaveLength(1)
        expect(client.updateUser).not.toHaveBeenCalled()

        const { res: res3, sent: sent3 } = createMockResponse()
        await createAccountUpdateHandler(asKeeperClient(client))(
            createMockContext(),
            {
                identity: 'alice@example.test',
                changes: [
                    { attribute: 'name', op: AttributeChangeOp.Set, value: 'Alice Updated' },
                    { attribute: 'jobTitle', op: AttributeChangeOp.Set, value: 'Lead' },
                ],
            } as any,
            res3
        )
        expect(sent3).toHaveLength(1)
        expect(client.updateUser).toHaveBeenCalledWith(
            expect.objectContaining({
                email: 'alice@example.test',
                name: 'Alice Updated',
                jobTitle: 'Lead',
            })
        )
    })

    it('renames email and returns account under the new primary', async () => {
        const renamed = {
            ...alice,
            email: 'alice.new@example.test',
            alias: ['alice@example.test'],
        }
        const client = createMockKeeperClient({
            getUser: jest.fn().mockResolvedValue(renamed),
            listVaultTree: jest.fn().mockResolvedValue(mockVaultTree),
        })
        const { res, sent } = createMockResponse()
        await createAccountUpdateHandler(asKeeperClient(client))(
            createMockContext(),
            {
                identity: 'alice@example.test',
                changes: [
                    { attribute: 'email', op: AttributeChangeOp.Set, value: 'alice.new@example.test' },
                ],
            } as any,
            res
        )
        expect(client.updateUser).toHaveBeenCalledWith({
            email: 'alice@example.test',
            addAliasValues: ['alice.new@example.test'],
        })
        expect(client.getUser).toHaveBeenCalledWith('alice.new@example.test')
        expect(sent[0].identity).toBe('alice.new@example.test')
        expect(sent[0].attributes.email).toBe('alice.new@example.test')
    })

    it('rejects aliases changes from the handler', async () => {
        const client = createMockKeeperClient({
            getUser: jest.fn().mockResolvedValue(alice),
            listVaultTree: jest.fn().mockResolvedValue(mockVaultTree),
        })
        const { res } = createMockResponse()
        await expect(
            createAccountUpdateHandler(asKeeperClient(client))(
                createMockContext(),
                {
                    identity: 'alice@example.test',
                    changes: [
                        { attribute: 'aliases', op: AttributeChangeOp.Add, value: 'alias@example.test' },
                    ],
                } as any,
                res
            )
        ).rejects.toThrow(/cannot manage "aliases"/)
        expect(client.updateUser).not.toHaveBeenCalled()
    })

    it('applies plan and returns account; throws on partial failure', async () => {
        const client = createMockKeeperClient({
            getUser: jest.fn().mockResolvedValue(alice),
            listVaultTree: jest.fn().mockResolvedValue(mockVaultTree),
            listAllFolders: jest.fn().mockResolvedValue([classicFolder]),
        })
        const { res, sent } = createMockResponse()
        await createAccountUpdateHandler(asKeeperClient(client))(
            createMockContext(),
            {
                identity: 'alice@example.test',
                changes: [{ attribute: 'folders', op: AttributeChangeOp.Add, value: 'sf-classic-001:NP' }],
            } as any,
            res
        )
        expect(sent[0].identity).toBe('alice@example.test')
        expect(client.grantClassicFolderShare).toHaveBeenCalled()

        client.grantClassicFolderShare.mockRejectedValueOnce(new Error('share denied'))
        const { res: resFail, sent: sentFail } = createMockResponse()
        await expect(
            createAccountUpdateHandler(asKeeperClient(client))(
                createMockContext(),
                {
                    identity: 'alice@example.test',
                    changes: [
                        { attribute: 'folders', op: AttributeChangeOp.Add, value: 'sf-classic-001:MU' },
                    ],
                } as any,
                resFail
            )
        ).rejects.toThrow(/partially failed/)
        expect(sentFail[0].results).toBeDefined()
    })
})
