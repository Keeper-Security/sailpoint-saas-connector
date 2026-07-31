import { ConnectorError } from '@sailpoint/connector-sdk'

export function requireConfigValue(value: string | undefined | null, name: string): string {
    if (value == null || value === '') {
        throw new ConnectorError(`${name} must be provided from config`)
    }
    return value
}
