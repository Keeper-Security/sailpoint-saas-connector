import { ConnectorError } from '@sailpoint/connector-sdk'
import {
    coerceNonEmptyStrings,
    firstEntitlementValue,
    getAllShareableFolders,
    getRecordList,
    getRecordListByEmail,
    normalizeString,
    requireSingleNodeId,
} from '../../../src/utils/helper'
import { emptyVaultTree, mockVaultTree } from '../../fixtures/vault-tree'

describe('helper', () => {
    describe('string helpers', () => {
        it('normalizeString', () => {
            expect(normalizeString('  a  ')).toBe('a')
            expect(normalizeString('')).toBeUndefined()
            expect(normalizeString('   ')).toBeUndefined()
            expect(normalizeString(1)).toBeUndefined()
            expect(normalizeString(null)).toBeUndefined()
        })

        it('coerceNonEmptyStrings', () => {
            expect(coerceNonEmptyStrings(null)).toEqual([])
            expect(coerceNonEmptyStrings(undefined)).toEqual([])
            expect(coerceNonEmptyStrings(' a ')).toEqual(['a'])
            expect(coerceNonEmptyStrings([' a ', '', 2, 'b'])).toEqual(['a', 'b'])
        })

        it('firstEntitlementValue', () => {
            expect(firstEntitlementValue('x')).toBe('x')
            expect(firstEntitlementValue(['', 'y'])).toBe('y')
            expect(firstEntitlementValue([])).toBeUndefined()
            expect(firstEntitlementValue(null)).toBeUndefined()
        })

        it('requireSingleNodeId', () => {
            expect(requireSingleNodeId('n1')).toBe('n1')
            expect(requireSingleNodeId(['n1'])).toBe('n1')
            expect(() => requireSingleNodeId([])).toThrow(ConnectorError)
            expect(() => requireSingleNodeId(['a', 'b'])).toThrow(/single-valued/)
            expect(() => requireSingleNodeId(null, 'custom empty')).toThrow('custom empty')
            expect(() => requireSingleNodeId(null)).toThrow('attribute "node" cannot be empty')
        })
    })

    describe('getAllShareableFolders', () => {
        it('collects classic, nsf, and non-sharable folders from the mock tree', () => {
            const folders = getAllShareableFolders(mockVaultTree)
            const byUid = Object.fromEntries(folders.map((f) => [f.uid, f.folderType]))
            expect(byUid['sf-classic-001']).toBe('classic')
            expect(byUid['nsf-folder-001']).toBe('nsf')
            expect(byUid['folder-plain-001']).toBe('non-sharable')
            expect(byUid['folder-plain-002']).toBe('non-sharable')
            expect(byUid['sf-classic-002']).toBe('classic')
        })

        it('maps user/team permissions and skips empty emails/team uids', () => {
            const folders = getAllShareableFolders(mockVaultTree)
            const classic = folders.find((f) => f.uid === 'sf-classic-001')!
            expect(classic.userPermissions?.['alice@example.test']).toEqual(['MU', 'MR'])
            expect(classic.teamPermissions?.['team-uid-001']).toEqual(['MU'])
            expect(classic.parentId).toBeUndefined()

            const nestedPlain = folders.find((f) => f.uid === 'folder-plain-001')!
            expect(nestedPlain.parentId).toBe('sf-classic-001')

            const emptyAcl = folders.find((f) => f.uid === 'sf-classic-002')!
            expect(Object.keys(emptyAcl.userPermissions ?? {})).toEqual([])
            expect(Object.keys(emptyAcl.teamPermissions ?? {})).toEqual([])
        })

        it('returns empty list for empty tree', () => {
            expect(getAllShareableFolders(emptyVaultTree)).toEqual([])
        })

        it('dedupes repeated uids and strips leading slashes on path', () => {
            const folders = getAllShareableFolders(mockVaultTree)
            const classic = folders.find((f) => f.uid === 'sf-classic-001')!
            expect(classic.path.startsWith('/')).toBe(false)
            const uids = folders.map((f) => f.uid)
            expect(new Set(uids).size).toBe(uids.length)
        })

        it('skips unknown kinds, missing uids, and non-array share ACL shapes', () => {
            const folders = getAllShareableFolders({
                share_permissions_key: { classic: {}, nsf: {} },
                tree: {
                    kind: 'user_folder',
                    name: 'My Vault',
                    path: '/',
                    children: [
                        {
                            kind: 'shared_folder',
                            name: 'Dup',
                            path: '/Dup',
                            uid: 'dup-1',
                            children: [
                                {
                                    kind: 'shared_folder',
                                    name: 'Dup again',
                                    path: '/Dup again',
                                    uid: 'dup-1',
                                },
                            ],
                        },
                        {
                            kind: 'shared_folder',
                            name: 'NoUid',
                            path: '/NoUid',
                        },
                        {
                            kind: 'record',
                            name: 'orphan record',
                            path: '/r',
                            uid: 'rec-x',
                            share_permissions: { users: [] },
                        },
                        {
                            kind: 'folder',
                            name: 'Weird ACL',
                            path: '/Weird',
                            uid: 'folder-weird',
                            share_permissions: { users: 'nope' as any, teams: 'nope' as any },
                        },
                        {
                            kind: 'folder',
                            name: 'No path',
                            path: '',
                            uid: 'folder-nopath',
                        },
                        {
                            kind: 'shared_folder',
                            name: 'Child of no uid',
                            path: '/x',
                            uid: '  ',
                            children: [
                                {
                                    kind: 'folder',
                                    name: 'Under blank uid',
                                    path: '/x/y',
                                    uid: 'folder-under-blank',
                                },
                            ],
                        },
                        {
                            kind: 'shared_folder',
                            name: 'Only name',
                            path: '',
                            uid: 'sf-only-name',
                            share_permissions: {
                                users: [{ email: 'u@example.test', permissions: undefined as any }],
                                teams: [{ name: 'T', uid: 't1', permissions: undefined as any }],
                            },
                        },
                    ],
                },
            } as any)
            expect(folders.filter((f) => f.uid === 'dup-1')).toHaveLength(1)
            expect(folders.find((f) => f.uid === 'folder-weird')?.userPermissions).toEqual({})
            expect(folders.find((f) => f.uid === 'folder-nopath')?.path).toBe('No path')
            expect(folders.find((f) => f.uid === 'folder-under-blank')?.parentId).toBeUndefined()
            expect(folders.find((f) => f.uid === 'sf-only-name')?.path).toBe('Only name')
        })
    })

    describe('getRecordList / getRecordListByEmail', () => {
        it('expands classic and nsf records into entitlement rows', () => {
            const records = getRecordList(mockVaultTree)
            const classicRows = records.filter((r) => r.record_uid === 'rec-classic-001')
            expect(classicRows.some((r) => r.record_uid_perm.endsWith(':RO'))).toBe(true)
            expect(classicRows.some((r) => r.record_uid_perm.endsWith(':MU'))).toBe(false)
            expect(classicRows.find((r) => r.permission === 'View Only')?.users).toContain(
                'alice@example.test'
            )

            const nsfRows = records.filter((r) => r.record_uid === 'rec-nsf-001')
            expect(nsfRows.some((r) => r.record_uid_perm.endsWith(':VW'))).toBe(true)
            expect(nsfRows.find((r) => r.record_uid_perm.endsWith(':VW'))?.users).toContain(
                'bob@example.test'
            )
        })

        it('lists permission ids for a given email', () => {
            expect(getRecordListByEmail('alice@example.test', mockVaultTree)).toEqual(
                expect.arrayContaining(['rec-classic-001:RO', 'rec-classic-001:CE'])
            )
            expect(getRecordListByEmail('nobody@example.test', mockVaultTree)).toEqual([])
            expect(getRecordListByEmail('alice@example.test', emptyVaultTree)).toEqual([])
        })

        it('covers tree fallbacks and records without uid/type/users', () => {
            const tree = {
                share_permissions_key: {
                    classic: { RO: 'View Only' },
                    nsf: {},
                },
                tree: undefined,
            }
            expect(getRecordList(tree as any)).toEqual([])
            expect(getRecordListByEmail('a@example.test', tree as any)).toEqual([])
            expect(getAllShareableFolders(tree as any)).toEqual([])

            const noTreeChildren = {
                share_permissions_key: { classic: { RO: 'View Only' }, nsf: {} },
                tree: { kind: 'user_folder', name: 'My Vault', path: '/' },
            }
            expect(getAllShareableFolders(noTreeChildren as any)).toEqual([])

            const sparseRecords = {
                share_permissions_key: { classic: { RO: 'View Only' }, nsf: {} },
                tree: {
                    kind: 'user_folder',
                    name: 'My Vault',
                    path: '/',
                    children: [
                        {
                            kind: 'record',
                            name: 'Orphan',
                            path: '/Orphan',
                            // no uid, no record_type, users omitted
                            share_permissions: {},
                        },
                        {
                            kind: 'record',
                            name: 'WithUsers',
                            path: '/WithUsers',
                            uid: 'rec-users',
                            share_permissions: {
                                users: [{ email: 'x@example.test', permissions: ['RO'] }],
                            },
                        },
                        {
                            kind: 'folder',
                            name: 'Named',
                            path: '/',
                            uid: 'folder-slash-path',
                        },
                        {
                            kind: 'folder',
                            name: '',
                            path: '/',
                            uid: 'folder-uid-only',
                        },
                        {
                            kind: 'folder',
                            name: '',
                            path: '',
                            uid: 'folder-rawpath-uid',
                        },
                        {
                            kind: 'folder',
                            // name omitted → nullish ?? ''
                            path: '/OnlyPath',
                            uid: 'folder-null-name',
                        },
                    ],
                },
            }
            const rows = getRecordList(sparseRecords as any)
            expect(rows[0].record_uid).toBe('')
            expect(rows[0].type).toBe('')
            expect(rows[0].users).toEqual([])
            expect(getRecordListByEmail('x@example.test', sparseRecords as any)).toEqual([
                'rec-users:RO',
            ])
            expect(getRecordListByEmail('x@example.test', {
                ...sparseRecords,
                tree: {
                    ...sparseRecords.tree,
                    children: [
                        {
                            kind: 'record',
                            name: 'R',
                            path: '/R',
                            uid: 'rec-x',
                            share_permissions: {
                                users: [{ email: 'x@example.test', permissions: undefined as any }],
                            },
                        },
                    ],
                },
            } as any)).toEqual([])
            const folders = getAllShareableFolders(sparseRecords as any)
            expect(folders.find((f) => f.uid === 'folder-slash-path')?.path).toBe('Named')
            expect(folders.find((f) => f.uid === 'folder-uid-only')?.path).toBe('folder-uid-only')
            expect(folders.find((f) => f.uid === 'folder-null-name')?.name).toBe('')
        })
    })
})
