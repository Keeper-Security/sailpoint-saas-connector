import { createConnector, readConfig } from '@sailpoint/connector-sdk'
import { KeeperClient } from './client/keeper-client'
import { createAccountCreateHandler } from './handlers/account-create'
import { createAccountDisableHandler } from './handlers/account-disable'
import { createAccountEnableHandler } from './handlers/account-enable'
import { createAccountListHandler } from './handlers/account-list'
import { createAccountReadHandler } from './handlers/account-read'
import { createEntitlementListHandler } from './handlers/entitlement-list'
import { createEntitlementReadHandler } from './handlers/entitlement-read'
import { createTestConnectionHandler } from './handlers/test-connection'
import { SourceConfig } from './model/config'

// Connector must be exported as module property named connector
export const connector = async () => {
    const config = (await readConfig()) as SourceConfig
    const client = new KeeperClient(config)

    return createConnector()
        .stdTestConnection(createTestConnectionHandler(client))
        .stdEntitlementList(createEntitlementListHandler(client))
        .stdEntitlementRead(createEntitlementReadHandler(client))
        .stdAccountList(createAccountListHandler(client))
        .stdAccountRead(createAccountReadHandler(client))
        .stdAccountCreate(createAccountCreateHandler(client))
        .stdAccountDisable(createAccountDisableHandler(client))
        .stdAccountEnable(createAccountEnableHandler(client))
}
