import {
    classicEntitlementFromTreePerms,
    classicFlags,
    folderEntitlementIdFromTreePerms,
    isValidPermission,
    nsfEntitlementFromTreePerms,
    nsfRoleForCode,
    parseFolderEntitlementId,
    permissionLabel,
    permissionsForFolderType,
    toFolderEntitlementId,
} from '../../../src/utils/folder-permissions'
import { KeeperFolder } from '../../../src/model/keeper-entities'

describe('folder-permissions', () => {
    describe('permissionsForFolderType', () => {
        it('returns classic and nsf codes and empty for non-sharable', () => {
            expect(permissionsForFolderType('classic')).toEqual(['NP', 'MU', 'MR', 'MUR'])
            expect(permissionsForFolderType('nsf')).toEqual(['VW', 'SM', 'CM', 'CSM', 'FM'])
            expect(permissionsForFolderType('non-sharable')).toEqual([])
        })
    })

    describe('permissionLabel', () => {
        it('resolves known labels and falls back to raw code', () => {
            expect(permissionLabel('classic', 'MU')).toBe('Manage users')
            expect(permissionLabel('nsf', 'VW')).toBe('Viewer')
            expect(permissionLabel('classic', 'XX' as any)).toBe('XX')
            expect(permissionLabel('nsf', 'YY' as any)).toBe('YY')
            expect(permissionLabel('non-sharable', 'MU')).toBe('MU')
        })
    })

    describe('toFolderEntitlementId / parseFolderEntitlementId', () => {
        it('builds and parses uid:CODE identities', () => {
            expect(toFolderEntitlementId('sf-1', 'MU')).toBe('sf-1:MU')
            expect(parseFolderEntitlementId('sf-1:MU')).toEqual({ uid: 'sf-1', permission: 'MU' })
            expect(parseFolderEntitlementId('a:b:c')).toEqual({ uid: 'a:b', permission: 'c' })
        })

        it('treats raw uid and malformed colon forms as non-permission ids', () => {
            expect(parseFolderEntitlementId('raw-uid')).toEqual({ uid: 'raw-uid', permission: null })
            expect(parseFolderEntitlementId(':MU')).toEqual({ uid: ':MU', permission: null })
            expect(parseFolderEntitlementId('sf-1:')).toEqual({ uid: 'sf-1:', permission: null })
        })
    })

    describe('isValidPermission', () => {
        it('validates by folder type', () => {
            expect(isValidPermission('classic', 'MU')).toBe(true)
            expect(isValidPermission('classic', 'VW')).toBe(false)
            expect(isValidPermission('nsf', 'VW')).toBe(true)
            expect(isValidPermission('non-sharable', 'MU')).toBe(false)
        })
    })

    describe('classicFlags / nsfRoleForCode', () => {
        it('maps classic flags', () => {
            expect(classicFlags('NP')).toEqual({ manageUsers: 'off', manageRecords: 'off' })
            expect(classicFlags('MU')).toEqual({ manageUsers: 'on', manageRecords: 'off' })
            expect(classicFlags('MR')).toEqual({ manageUsers: 'off', manageRecords: 'on' })
            expect(classicFlags('MUR')).toEqual({ manageUsers: 'on', manageRecords: 'on' })
        })

        it('maps NSF roles', () => {
            expect(nsfRoleForCode('VW')).toBe('viewer')
            expect(nsfRoleForCode('SM')).toBe('share-manager')
            expect(nsfRoleForCode('CM')).toBe('content-manager')
            expect(nsfRoleForCode('CSM')).toBe('content-share-manager')
            expect(nsfRoleForCode('FM')).toBe('full-manager')
        })
    })

    describe('tree ACL → entitlement codes', () => {
        it('maps classic tree perms', () => {
            expect(classicEntitlementFromTreePerms(['MU', 'MR'])).toBe('MUR')
            expect(classicEntitlementFromTreePerms(['MU'])).toBe('MU')
            expect(classicEntitlementFromTreePerms(['MR'])).toBe('MR')
            expect(classicEntitlementFromTreePerms(['RO'])).toBe('NP')
            expect(classicEntitlementFromTreePerms([])).toBe('NP')
        })

        it('maps NSF tree perms with priority', () => {
            expect(nsfEntitlementFromTreePerms(['OW'])).toBe('FM')
            expect(nsfEntitlementFromTreePerms(['FM'])).toBe('FM')
            expect(nsfEntitlementFromTreePerms(['CSM'])).toBe('CSM')
            expect(nsfEntitlementFromTreePerms(['CM'])).toBe('CM')
            expect(nsfEntitlementFromTreePerms(['SM'])).toBe('SM')
            expect(nsfEntitlementFromTreePerms(['VW'])).toBe('VW')
            expect(nsfEntitlementFromTreePerms([])).toBeNull()
        })

        it('resolves folder entitlement ids', () => {
            const classic: KeeperFolder = {
                uid: 'sf-1',
                name: 'A',
                path: 'A',
                folderType: 'classic',
            }
            const nsf: KeeperFolder = {
                uid: 'nsf-1',
                name: 'B',
                path: 'B',
                folderType: 'nsf',
            }
            const plain: KeeperFolder = {
                uid: 'p-1',
                name: 'C',
                path: 'C',
                folderType: 'non-sharable',
            }
            expect(folderEntitlementIdFromTreePerms(classic, ['MU'])).toBe('sf-1:MU')
            expect(folderEntitlementIdFromTreePerms(nsf, ['VW'])).toBe('nsf-1:VW')
            expect(folderEntitlementIdFromTreePerms(nsf, [])).toBeNull()
            expect(folderEntitlementIdFromTreePerms(plain, ['MU'])).toBeNull()
        })
    })
})
