import { KeeperVaultTreeData } from '../../src/model/keeper-entities'

/** Fully synthetic vault tree — no real UIDs or emails from production. */
export const mockVaultTree: KeeperVaultTreeData = {
    share_permissions_key: {
        classic: {
            RO: 'View Only',
            CE: 'Can Edit',
            CS: 'Can Share',
            MU: 'Manage Users',
            MR: 'Manage Records',
        },
        nsf: {
            VW: 'Viewer',
            SM: 'Share Manager',
            CM: 'Content Manager',
            CSM: 'Content Share Manager',
            FM: 'Full Manager',
            OW: 'Owner',
        },
    },
    tree: {
        kind: 'user_folder',
        name: 'My Vault',
        path: '/',
        children: [
            {
                kind: 'shared_folder',
                name: 'Classic Shared',
                path: '/Classic Shared',
                uid: 'sf-classic-001',
                share_permissions: {
                    users: [
                        { email: 'alice@example.test', permissions: ['MU', 'MR'] },
                        { email: 'bob@example.test', permissions: ['RO'] },
                    ],
                    teams: [{ name: 'Team Alpha', uid: 'team-uid-001', permissions: ['MU'] }],
                },
                children: [
                    {
                        kind: 'folder',
                        name: 'Nested Plain',
                        path: '/Classic Shared/Nested Plain',
                        uid: 'folder-plain-001',
                        children: [
                            {
                                kind: 'record',
                                name: 'Classic Record',
                                path: '/Classic Shared/Nested Plain/Classic Record',
                                uid: 'rec-classic-001',
                                record_type: 'login',
                                share_permissions: {
                                    users: [
                                        {
                                            email: 'alice@example.test',
                                            permissions: ['RO', 'CE'],
                                        },
                                    ],
                                },
                            },
                        ],
                    },
                ],
            },
            {
                kind: 'nested_share_folder',
                name: 'NSF Drive',
                path: '/NSF Drive',
                uid: 'nsf-folder-001',
                share_permissions: {
                    users: [{ email: 'alice@example.test', permissions: ['OW', 'FM'] }],
                    teams: [{ name: 'Team Beta', uid: 'team-uid-002', permissions: ['VW'] }],
                },
                children: [
                    {
                        kind: 'nested_record',
                        name: 'NSF Record',
                        path: '/NSF Drive/NSF Record',
                        uid: 'rec-nsf-001',
                        record_type: 'login',
                        share_permissions: {
                            users: [{ email: 'bob@example.test', permissions: ['VW'] }],
                        },
                    },
                ],
            },
            {
                kind: 'folder',
                name: 'Orphan Plain',
                path: '/Orphan Plain',
                uid: 'folder-plain-002',
            },
            {
                kind: 'shared_folder',
                name: 'Empty ACL Shared',
                path: '/Empty ACL Shared',
                uid: 'sf-classic-002',
                share_permissions: {
                    users: [{ email: '  ', permissions: ['MU'] }],
                    teams: [{ name: 'NoUid', uid: '  ', permissions: ['MU'] }],
                },
            },
        ],
    },
}

export const emptyVaultTree: KeeperVaultTreeData = {
    share_permissions_key: { classic: {}, nsf: {} },
    tree: { kind: 'user_folder', name: 'My Vault', path: '/', children: [] },
}
