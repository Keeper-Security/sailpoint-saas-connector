import {
    buildAccountMaps,
    buildNodePath,
    buildNodePathMap,
    buildRecordMaps,
    buildTeamFolderMap,
    toAccount,
    toFolderEntitlement,
    toFolderEntitlements,
    toNodeEntitlement,
    toNonSharableFolderEntitlement,
    toRecordEntitlement,
    toRoleEntitlement,
    toTeamEntitlement,
} from '../../../src/utils/keeper-mappings'
import { getAllShareableFolders, getRecordList } from '../../../src/utils/helper'
import { mockVaultTree } from '../../fixtures/vault-tree'
import { KeeperFolder, KeeperNode, KeeperRole, KeeperTeam, KeeperUser } from '../../../src/model/keeper-entities'
import { logger } from '@sailpoint/connector-sdk'

describe('keeper-mappings', () => {
    const folders = getAllShareableFolders(mockVaultTree)
    const records = getRecordList(mockVaultTree)

    it('buildNodePath and collision warning', () => {
        expect(buildNodePath({ node_id: 1, name: 'Root' })).toBe('Root')
        expect(buildNodePath({ node_id: 2, name: 'Child', parent_node: 'Root' })).toBe('Root\\Child')

        const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined)
        const map = buildNodePathMap([
            { node_id: 1, name: 'Same', parent_node: 'A' },
            { node_id: 2, name: 'Same', parent_node: 'A' },
            { node_id: 3, name: 'Same', parent_node: 'A' },
        ])
        expect(map.get('A\\Same')).toBe('1')
        expect(warn).toHaveBeenCalled()
        warn.mockRestore()
    })

    it('buildAccountMaps / buildTeamFolderMap / buildRecordMaps', () => {
        const maps = buildAccountMaps(folders)
        expect(maps.userEmailToFolderIds.get('alice@example.test')).toEqual(
            expect.arrayContaining(['sf-classic-001:MUR', 'nsf-folder-001:FM'])
        )
        expect(maps.userEmailToFolderIds.get('bob@example.test')).toEqual(
            expect.arrayContaining(['sf-classic-001:NP'])
        )

        const teamMap = buildTeamFolderMap(folders)
        expect(teamMap.get('team-uid-001')).toEqual(expect.arrayContaining(['sf-classic-001:MU']))
        expect(teamMap.get('team-uid-002')).toEqual(expect.arrayContaining(['nsf-folder-001:VW']))

        const recordMaps = buildRecordMaps(records)
        expect(recordMaps.userEmailToRecordIds.get('alice@example.test')?.length).toBeGreaterThan(0)

        // empty email / blank folder uid skipped — and missing permission maps
        const blank: KeeperFolder = {
            uid: '',
            name: 'x',
            path: 'x',
            folderType: 'classic',
            userPermissions: { '  ': ['MU'], 'skip@example.test': ['MU'] },
            teamPermissions: { '  ': ['MU'] },
        }
        const classicDup: KeeperFolder = {
            uid: 'sf-dup',
            name: 'Dup',
            path: 'Dup',
            folderType: 'classic',
            userPermissions: { 'dup@example.test': ['MU'] },
            teamPermissions: { 'team-dup': ['MR'] },
        }
        expect(buildAccountMaps([blank]).userEmailToFolderIds.size).toBe(0)
        expect(buildTeamFolderMap([blank]).size).toBe(0)
        expect(buildAccountMaps([{ ...classicDup, userPermissions: undefined }]).userEmailToFolderIds.size).toBe(
            0
        )
        expect(buildTeamFolderMap([{ ...classicDup, teamPermissions: undefined }]).size).toBe(0)
        // blank email/team keys on a real uid still skip
        expect(
            buildAccountMaps([
                {
                    uid: 'sf-blank-keys',
                    name: 'B',
                    path: 'B',
                    folderType: 'classic',
                    userPermissions: { '  ': ['MU'], '': ['MR'] },
                },
            ]).userEmailToFolderIds.size
        ).toBe(0)
        expect(
            buildTeamFolderMap([
                {
                    uid: 'sf-blank-keys',
                    name: 'B',
                    path: 'B',
                    folderType: 'classic',
                    teamPermissions: { '  ': ['MU'], '': ['MR'] },
                },
            ]).size
        ).toBe(0)
        expect(buildAccountMaps([]).userEmailToFolderIds.size).toBe(0)
        expect(
            buildRecordMaps([{ ...records[0], users: ['', '  ', 'ok@example.test'] }]).userEmailToRecordIds.has(
                'ok@example.test'
            )
        ).toBe(true)
        expect(
            buildRecordMaps([
                { ...records[0], users: [undefined as any, null as any, 'ok2@example.test'] },
            ]).userEmailToRecordIds.has('ok2@example.test')
        ).toBe(true)
        expect(buildRecordMaps([{ ...records[0], users: undefined }]).userEmailToRecordIds.size).toBe(0)

        // duplicate entitlement ids and NSF with no mappable ACL
        const nsfEmpty: KeeperFolder = {
            uid: 'nsf-empty',
            name: 'E',
            path: 'E',
            folderType: 'nsf',
            userPermissions: { 'dup@example.test': [] },
            teamPermissions: { 'team-dup': [] },
        }
        const accountDup = buildAccountMaps([classicDup, classicDup, nsfEmpty])
        expect(accountDup.userEmailToFolderIds.get('dup@example.test')).toEqual(['sf-dup:MU'])
        expect(buildTeamFolderMap([classicDup, classicDup, nsfEmpty]).get('team-dup')).toEqual([
            'sf-dup:MR',
        ])

        // same path same id — no warn
        const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined)
        buildNodePathMap([
            { node_id: 1, name: 'Same', parent_node: 'A' },
            { node_id: 1, name: 'Same', parent_node: 'A' },
        ])
        expect(warn).not.toHaveBeenCalled()
        warn.mockRestore()
    })

    it('entitlement mappers', () => {
        const node: KeeperNode = {
            node_id: 10,
            name: 'Eng',
            parent_id: 1,
            parent_node: 'Root',
            isolated: true,
        }
        expect(toNodeEntitlement(node).attributes.parentId).toBe('1')

        const rootNode: KeeperNode = { node_id: 1, name: 'Root' }
        expect(toNodeEntitlement(rootNode).attributes.parentId).toBeNull()

        const team: KeeperTeam = {
            team_uid: 'team-uid-001',
            name: 'Alpha',
            node: 'Root\\Eng',
            restricts: 'none',
        }
        const pathMap = new Map([['Root\\Eng', '10']])
        expect(toTeamEntitlement(team, pathMap, ['sf-classic-001:MU']).attributes.nodeId).toBe('10')
        expect(toTeamEntitlement({ team_uid: 't', name: 'X' }, pathMap).attributes.nodeId).toBeNull()
        expect(
            toTeamEntitlement({ team_uid: 't2', name: 'Y', node: 'Missing\\Path' }, pathMap).attributes
                .nodeId
        ).toBeNull()
        expect(toTeamEntitlement({ team_uid: 't3', name: '' }, pathMap).attributes.name).toBe('')
        expect(toTeamEntitlement({ team_uid: 't3b', name: undefined as any }, pathMap).attributes.name).toBe(
            ''
        )
        expect(toTeamEntitlement({ team_uid: 't4', name: 'Z' }, pathMap).attributes.restricts).toBe('')

        const role: KeeperRole = {
            role_id: 5,
            name: 'Admin',
            node: 'Root\\Eng',
            admin: true,
            default_role: true,
            visible_below: true,
        }
        expect(toRoleEntitlement(role, pathMap).attributes.nodeId).toBe('10')
        expect(toRoleEntitlement({ role_id: 6, name: 'R' }, pathMap).attributes.nodeId).toBeNull()
        expect(
            toRoleEntitlement({ role_id: 7, name: 'R2', node: 'Missing' }, pathMap).attributes.nodeId
        ).toBeNull()
        expect(toRoleEntitlement({ role_id: 8, name: '' }, pathMap).attributes.name).toBe('')
        expect(toRoleEntitlement({ role_id: 88, name: undefined as any }, pathMap).attributes.name).toBe('')
        expect(toRoleEntitlement({ role_id: 9, name: 'R3' }, pathMap).attributes.admin).toBe(false)
        expect(toRoleEntitlement({ role_id: 10, name: 'R4' }, pathMap).attributes.defaultRole).toBe(false)
        expect(toRoleEntitlement({ role_id: 11, name: 'R5' }, pathMap).attributes.visibleBelow).toBe(
            false
        )

        const classic = folders.find((f) => f.uid === 'sf-classic-001')!
        expect(toFolderEntitlements(classic)).toHaveLength(4)
        expect(toFolderEntitlement(classic, 'MU').attributes.name).toContain('[Manage users]')

        const plain = folders.find((f) => f.uid === 'folder-plain-001')!
        expect(toFolderEntitlements(plain)).toHaveLength(1)
        expect(toNonSharableFolderEntitlement(plain).attributes.permission).toBeNull()

        const nameless: KeeperFolder = { uid: 'u1', name: '', path: '', folderType: 'classic' }
        expect(toFolderEntitlement(nameless, 'NP').attributes.name).toContain('u1')
        expect(toNonSharableFolderEntitlement({ ...nameless, folderType: 'non-sharable' }).attributes.name).toBe(
            'u1'
        )
        expect(toNodeEntitlement({ node_id: 99, name: undefined as any }).attributes.name).toBe('')
        expect(toNodeEntitlement({ node_id: 98, name: 'N', isolated: undefined }).attributes.isolated).toBe(
            false
        )

        const rec = records[0]
        expect(toRecordEntitlement(rec).attributes.displayName).toContain('[')
        expect(
            toRecordEntitlement({
                record_uid: 'r',
                record_uid_perm: 'r:RO',
                title: 'T',
                permission: 'View Only',
                path: '/T',
                record_category: undefined as any,
                type: undefined as any,
            }).attributes.record_category
        ).toBe('')
        expect(
            toRecordEntitlement({
                record_uid: 'r2',
                record_uid_perm: 'r2:RO',
                title: undefined as any,
                permission: 'View Only',
                path: '/T',
                record_category: 'classic',
                type: 'login',
            }).attributes.name
        ).toBe('')
        expect(
            toRecordEntitlement({
                record_uid: 'r3',
                record_uid_perm: 'r3:RO',
                title: 'T3',
                permission: 'View Only',
                path: '/T',
                record_category: 'classic',
                type: undefined as any,
            }).attributes.type
        ).toBe('')
    })

    it('toAccount maps disabled from status', () => {
        const maps = buildAccountMaps(folders)
        const recordMaps = buildRecordMaps(records)
        const active: KeeperUser = {
            user_id: 1,
            email: 'alice@example.test',
            status: 'Active',
            teams: [],
            roles: [],
        }
        expect(toAccount(active, maps, recordMaps).disabled).toBe(false)

        const invited: KeeperUser = {
            user_id: 2,
            email: 'bob@example.test',
            status: 'Invited',
        }
        expect(toAccount(invited, maps, recordMaps).disabled).toBe(true)

        const emptyStatus: KeeperUser = { user_id: 3, email: 'c@example.test', status: '' }
        expect(toAccount(emptyStatus, maps, recordMaps).disabled).toBe(false)

        const sparse: KeeperUser = { user_id: 4, email: 'd@example.test' }
        const sparseOut = toAccount(sparse, maps, recordMaps)
        expect(sparseOut.attributes.name).toBe('')
        expect(sparseOut.attributes.teams).toEqual([])
        expect(sparseOut.attributes.roles).toEqual([])
        expect(sparseOut.attributes.aliases).toEqual([])
        expect(sparseOut.attributes.node).toBeNull()
        expect(sparseOut.attributes.twoFactorEnabled).toBe(false)

        const noEmail: KeeperUser = { user_id: 5, email: undefined as any }
        expect(toAccount(noEmail, maps, recordMaps).attributes.folders).toEqual([])
        expect(toAccount(noEmail, maps, recordMaps).attributes.records).toEqual([])
    })
})
