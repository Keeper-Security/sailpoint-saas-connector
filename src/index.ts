import { createConnector, readConfig } from '@sailpoint/connector-sdk'
import { KeeperClient } from './client/keeper-client'
import { createTestConnectionHandler } from './handlers/test-connection'
import { SourceConfig } from './model/config'

// Connector must be exported as module property named connector
export const connector = async () => {
    const config = (await readConfig()) as SourceConfig
    const client = new KeeperClient(config)

    return createConnector().stdTestConnection(createTestConnectionHandler(client))
}
