import { Response } from '@sailpoint/connector-sdk'

/** Collects every `send` payload for assertions. */
export function createMockResponse<T = any>(): {
    res: Response<T>
    sent: T[]
} {
    const sent: T[] = []
    const res = {
        send(output: T) {
            sent.push(output)
        },
    } as Response<T>
    return { res, sent }
}
