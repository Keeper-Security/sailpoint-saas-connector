import { Result, ResultMessageLevel, ResultStatus } from '@sailpoint/connector-sdk'

/**
 * One failed unit of work during an update. Independent folder/record ops are
 * collected rather than aborting the whole plan, then reported together.
 */
export interface OperationFailure {
    /** Account schema attribute (e.g. folders, records, name). */
    attribute: string
    /** Short action label for the aggregated error message. */
    action: string
    /** Target entitlement id / description. */
    target: string
    message: string
}

export function errorMessage(err: unknown): string {
    if (err instanceof Error) return err.message
    return String(err)
}

/**
 * One Result entry per failed attribute (folders / records / …), with every
 * failed entitlement listed in the messages array — SailPoint-native partial
 * attribute reporting on StdAccountUpdateOutput.results.
 */
export function toAttributeResults(failures: OperationFailure[]): Result[] {
    const byAttribute = new Map<string, OperationFailure[]>()
    for (const f of failures) {
        const list = byAttribute.get(f.attribute) ?? []
        list.push(f)
        byAttribute.set(f.attribute, list)
    }

    const results: Result[] = []
    for (const [attribute, items] of byAttribute) {
        results.push({
            attribute,
            status: ResultStatus.Error,
            messages: items.map((item) => ({
                level: ResultMessageLevel.ERROR,
                message: `Failed to ${item.action} "${item.target}": ${item.message}`,
            })),
        })
    }
    return results
}

export function formatAggregatedError(email: string, failures: OperationFailure[]): string {
    const details = failures
        .map((f, i) => `${i + 1}) ${f.attribute}: failed to ${f.action} "${f.target}" — ${f.message}`)
        .join('; ')
    return (
        `Account update partially failed for "${email}". ` +
        `${failures.length} operation(s) failed; successful changes were applied. ` +
        `Details: ${details}`
    )
}
