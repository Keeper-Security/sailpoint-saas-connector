import { KeeperClient } from '../../src/client/keeper-client'
import { mockConfig } from '../fixtures/mock-config'
import { mockVaultTree } from '../fixtures/vault-tree'

/** Typed partial mock of KeeperClient for handler unit tests. */
export type MockKeeperClient = jest.Mocked<
    Pick<
        KeeperClient,
        | 'testConnection'
        | 'syncEnterprise'
        | 'syncVault'
        | 'listVaultTree'
        | 'listUsers'
        | 'getUser'
        | 'getWhoami'
        | 'createUser'
        | 'updateUser'
        | 'deleteUser'
        | 'lockUser'
        | 'unlockUser'
        | 'listNodes'
        | 'listTeams'
        | 'listRoles'
        | 'listAllFolders'
        | 'grantClassicFolderShare'
        | 'removeClassicFolderShare'
        | 'grantNsfFolderShare'
        | 'removeNsfFolderShare'
        | 'updateRecordPermissions'
    >
>

export function createMockKeeperClient(overrides: Partial<MockKeeperClient> = {}): MockKeeperClient {
    return {
        testConnection: jest.fn().mockResolvedValue({}),
        syncEnterprise: jest.fn().mockResolvedValue(undefined),
        syncVault: jest.fn().mockResolvedValue(undefined),
        listVaultTree: jest.fn().mockResolvedValue(mockVaultTree),
        listUsers: jest.fn().mockResolvedValue([]),
        getUser: jest.fn().mockResolvedValue(null),
        getWhoami: jest.fn().mockResolvedValue({ user: 'service@example.test' }),
        createUser: jest.fn().mockResolvedValue(undefined),
        updateUser: jest.fn().mockResolvedValue(undefined),
        deleteUser: jest.fn().mockResolvedValue(undefined),
        lockUser: jest.fn().mockResolvedValue(undefined),
        unlockUser: jest.fn().mockResolvedValue(undefined),
        listNodes: jest.fn().mockResolvedValue([]),
        listTeams: jest.fn().mockResolvedValue([]),
        listRoles: jest.fn().mockResolvedValue([]),
        listAllFolders: jest.fn().mockResolvedValue([]),
        grantClassicFolderShare: jest.fn().mockResolvedValue(undefined),
        removeClassicFolderShare: jest.fn().mockResolvedValue(undefined),
        grantNsfFolderShare: jest.fn().mockResolvedValue(undefined),
        removeNsfFolderShare: jest.fn().mockResolvedValue(undefined),
        updateRecordPermissions: jest.fn().mockResolvedValue(undefined),
        ...overrides,
    } as MockKeeperClient
}

export function asKeeperClient(mock: MockKeeperClient): KeeperClient {
    return mock as unknown as KeeperClient
}

export { mockConfig }
