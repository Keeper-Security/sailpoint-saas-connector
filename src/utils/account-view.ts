import { ConnectorError, ConnectorErrorType, StdAccountListOutput } from '@sailpoint/connector-sdk'
import { KeeperClient } from '../client/keeper-client'
import { KeeperVaultTreeData } from '../model/keeper-entities'
import { buildAccountMaps, buildRecordMaps, toAccount } from './keeper-mappings'
import { getAllShareableFolders, getRecordList } from './helper'

export type LoadAccountViewOptions = {
    /** Override the NotFound message (create uses a softer "propagating" message). */
    notFoundMessage?: string
    /** Reuse a vault tree already fetched in this handler invocation. */
    vaultTree?: KeeperVaultTreeData
}

/**
 * Load a single Keeper user and assemble the SailPoint account view
 * (folders + records from one vault-tree round-trip).
 */
export async function loadAccountView(
    client: KeeperClient,
    email: string,
    options: LoadAccountViewOptions = {}
): Promise<StdAccountListOutput> {
    const user = await client.getUser(email)
    if (!user) {
        throw new ConnectorError(
            options.notFoundMessage ?? `Keeper user with email "${email}" not found`,
            ConnectorErrorType.NotFound
        )
    }

    const vaultTree = options.vaultTree ?? (await client.listVaultTree())
    const folders = getAllShareableFolders(vaultTree)
    const records = getRecordList(vaultTree)

    return toAccount(user, buildAccountMaps(folders), buildRecordMaps(records))
}
