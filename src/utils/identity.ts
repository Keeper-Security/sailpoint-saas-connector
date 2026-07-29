import { ConnectorError, Key, KeyID } from '@sailpoint/connector-sdk'

type KeyedInput = {
    key?: Key
    identity?: string
}

/**
 * Returns the key's simple id if present, else null.
 * `KeyID` throws on missing/malformed keys — catch and treat as absent.
 */
export function safeKeyId(input: KeyedInput | null | undefined): string | null {
    if (!input?.key) return null
    try {
        return KeyID({ key: input.key })
    } catch {
        return null
    }
}

/**
 * Prefer ISC `key.simple.id`, fall back to `identity` (Postman / spcx).
 * Throws when neither is present.
 */
export function resolveAccountEmail(input: KeyedInput | null | undefined, commandLabel: string): string {
    const email = safeKeyId(input) ?? input?.identity
    if (!email) {
        throw new ConnectorError(`${commandLabel} called without an identity`)
    }
    return email
}
