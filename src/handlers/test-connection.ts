import {
    Context,
    logger,
    Response,
    StdTestConnectionInput,
    StdTestConnectionOutput,
} from '@sailpoint/connector-sdk'
import { KeeperClient } from '../client/keeper-client'

export function createTestConnectionHandler(client: KeeperClient) {
    return async (
        _context: Context,
        _input: StdTestConnectionInput,
        res: Response<StdTestConnectionOutput>
    ): Promise<void> => {
        logger.info('Running test connection')
        res.send(await client.testConnection())
    }
}
