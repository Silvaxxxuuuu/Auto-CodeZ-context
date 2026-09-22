# Auto CodeZ Authentication

Status: hosted identity architecture. Azure is not part of the desktop authentication path.

## Architecture

Auto CodeZ is a native/public OAuth client. Authentication is delegated to Descope Auth Hosting and uses OAuth 2.0 / OIDC Authorization Code with PKCE.

Desktop flow:

1. Auto CodeZ generates state, nonce, a PKCE verifier and an S256 challenge.
2. The system browser opens Descope Auth Hosting.
3. One hosted Descope Flow presents GitHub, Google, Microsoft, Passkey and email Magic Link.
4. Descope redirects to the static native callback:
   `autocodez://auth/hosted`
5. Auto CodeZ validates state and exchanges the authorization code with the PKCE verifier.
6. The access token stays in memory.
7. The refresh token is stored through the OS-protected credential vault.
8. The local device identity remains local. A remote device/sync backend is optional future infrastructure, not part of authentication.

The former Azure Account API remains in the repository only as legacy/future backend code. The desktop runtime does not use Azure for sign-in.

## Descope project setup

Use one Descope project. The Free Forever plan currently includes one OIDC federated app and all authentication methods, which is enough for development and early testing.

In Descope Console:

1. Open **Applications** and use the **Default OIDC** application.
2. Configure its hosted authentication Flow.
3. Use **Hosted by Descope** for Flow Hosting.
4. Select or build one Sign Up / Sign In flow containing:
   - GitHub social login
   - Google social login
   - Microsoft social login
   - Passkey / WebAuthn
   - Email Magic Link
5. Register the native redirect URI exactly as:
   `autocodez://auth/hosted`
6. In **Project Settings > Security > Approved Domains**, keep redirect validation enabled and add the custom native callback under **Mobile App Schemes** using the identifier Descope requires for the `autocodez://auth/hosted` callback.
7. If **Apply Trusted Domains on Flow Execution** is enabled, also allow the Descope-hosted authentication domain used by the project.
8. Keep PKCE enabled. The desktop app never stores a Descope client secret.

For development, Descope's built-in Google, GitHub and Microsoft OAuth applications can be used immediately. Descope currently limits its shared test social applications to 100 total logins per month across providers. Before public production, configure Auto CodeZ-owned OAuth applications for each social provider so the consent screens use Auto CodeZ branding.

Passkeys and Magic Link are configured inside the same Descope Flow. No Azure Communication Services email transport is needed for this authentication architecture.

## Local development

Project ID is a public client identifier, not a client secret.

In PowerShell:

    $env:AUTO_CODEZ_DESCOPE_PROJECT_ID="<DESCOPE_PROJECT_ID>"
    Remove-Item Env:AUTO_CODEZ_ACCOUNT_API_BASE_URL -ErrorAction SilentlyContinue
    npm start

The legacy Azure account endpoint environment variable is intentionally ignored by the current desktop authentication runtime.

## Release builds

Set `AUTO_CODEZ_DESCOPE_PROJECT_ID` while building the application. Vite embeds only the public Descope Project ID.

Never embed:
- Descope management keys
- Descope access keys
- social provider client secrets
- email provider credentials

## Security invariants

- System browser for hosted authentication.
- Authorization Code + PKCE S256.
- Static callback URI: `autocodez://auth/hosted`.
- Cryptographically random state and nonce.
- State validation before token exchange.
- RS256 ID token signature validation against the project's JWKS.
- ID token issuer, audience, authorized-party, expiration and nonce validation before the account is accepted.
- UserInfo `sub` must match the verified ID token `sub` on the initial authorization grant.
- Pending hosted PKCE state is kept in protected local credential storage so a browser callback can complete after an app restart.
- Pending auth state is deleted after success, explicit cancellation, expiry or terminal failure. A forged or mismatched callback is rejected without destroying the legitimate pending transaction.
- Access token is memory-only.
- Refresh token is OS-protected.
- OAuth cancellation/error callbacks are handled without accepting an authorization grant.
- Password authentication is not part of the Auto CodeZ account model.

## Acceptance checklist

Before closing Account Core authentication:

1. GitHub login completes and returns to Auto CodeZ.
2. Google login completes and returns to Auto CodeZ.
3. Microsoft login completes and returns to Auto CodeZ.
4. Magic Link completes through the hosted flow.
5. A passkey can be created in the hosted flow and used for a later sign-in.
6. Cancelling a provider returns a clean error state.
7. Closing/restarting Auto CodeZ while the browser login is open still allows the callback to complete before flow expiry.
8. App restart restores the authenticated session using the protected refresh token.
9. Temporary network loss preserves the cached account state.
10. Refresh works after access-token expiry.
11. Logout clears local session credentials and revokes the refresh token when reachable.

## Azure

Azure remains available for Auto CodeZ AI/model/tool testing and future optional cloud services. It is not an authentication dependency.
