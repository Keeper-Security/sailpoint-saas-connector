import {
    AssumeAwsRoleRequest,
    AssumeAwsRoleResponse,
    Context,
    OAuth2AccessTokenRequest,
    OAuth2AccessTokenResponse,
} from '@sailpoint/connector-sdk'

export function createMockContext(): Context {
    return {
        reloadConfig() {
            return Promise.resolve()
        },
        assumeAwsRole(_request: AssumeAwsRoleRequest): Promise<AssumeAwsRoleResponse> {
            return Promise.resolve(
                new AssumeAwsRoleResponse('accessKeyId', 'secretAccessKey', 'sessionToken', '123')
            )
        },
        getOAuth2AccessToken(_request: OAuth2AccessTokenRequest): Promise<OAuth2AccessTokenResponse> {
            return Promise.resolve({})
        },
    }
}
