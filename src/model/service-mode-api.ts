export interface SubmitRequestResponse {
    success: boolean
    request_id: string
    status: string
    message: string
}

export interface RequestResultResponse {
    data: unknown
    status: string
    message: string
    error: string
}
