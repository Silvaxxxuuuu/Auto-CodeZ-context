# Auto CodeZ Authentication

Status: native passwordless Descope integration. Azure is not part of the desktop authentication path.

## Architecture

Auto CodeZ now exposes the five passwordless methods directly in its own onboarding UI:

- GitHub
- Google
- Microsoft
- Passkey
- email Magic Link

The desktop uses Descope as the identity service, but it no longer forces every method through one generic hosted login screen.

### Social login

GitHub, Google and Microsoft use Descope's native OAuth REST flow:

1. Auto CodeZ generates a cryptographically random transaction state.
2. The app asks Descope for the provider authorization URL.
3. The system browser opens the selected provider.
4. Descope returns to the provider-specific native callback:
   `autocodez://auth/oauth?flowId=...&state=...`
5. Auto CodeZ validates the protected pending transaction before exchanging the one-time code.
6. The returned Descope Session JWT is verified with the project's signing keys before the account is accepted.

### Magic Link

Magic Link uses Descope's sign-up-or-in email API directly:

1. The user enters an email in Auto CodeZ.
2. Descope sends the one-time link.
3. The link returns to:
   `autocodez://auth/magic-link?flowId=...&state=...`
4. Auto CodeZ validates the protected transaction and verifies the one-time token with Descope.
5. The returned Session JWT is signature-checked before the account is established.

### Passkey

Passkey keeps an OIDC Authorization Code + PKCE S256 ceremony in the system browser, with a dedicated callback:

`autocodez://auth/passkey`

The app generates state, nonce and a PKCE verifier, validates the callback, exchanges the code, verifies the RS256 ID token, and requires UserInfo `sub` to match the verified ID token subject.

A hosted OIDC path using `autocodez://auth/hosted` remains implemented as a compatibility/fallback path, but it is not the default onboarding surface.

## Session model

- Access/session token is memory-only.
- Refresh token is stored through the OS-protected credential vault.
- Direct Descope sessions and OIDC sessions are tagged locally so refresh/logout use the correct protocol without exposing provider secrets.
- Provider identity is preserved across refresh.
- Pending OAuth, Magic Link, Passkey and hosted transactions are stored in protected local credential storage so a browser callback can survive an app restart.
- A mismatched/forged callback is rejected without destroying the legitimate pending transaction.
- Successful completion, explicit cancellation, expiry or a terminal exchange failure clears the matching protected transaction.
- Local device identity remains local. Remote device/sync infrastructure is independent from authentication.

The former Azure Account API remains in the repository only as legacy/future backend code. The desktop runtime does not use Azure for sign-in.

## Descope project requirements

The desktop only needs the public Descope Project ID at runtime/build time. It never embeds a Descope management key, access key, social client secret or email-provider credential.

For social development, Descope's shared social provider configuration can be used where available. Production should use Auto CodeZ-owned provider applications for branding and production limits.

The Descope project must permit the Auto CodeZ native callback scheme. The relevant native callback routes are:

- `autocodez://auth/oauth`
- `autocodez://auth/magic-link`
- `autocodez://auth/passkey`
- `autocodez://auth/hosted` (compatibility/fallback)

Because OAuth and Magic Link append a protected `flowId` and `state` query to their callback URI, scheme/domain validation must allow those query parameters while keeping the callback host/path fixed.

For passkey/OIDC, keep PKCE enabled and configure the Descope identity application/flow used by the project to allow passkey authentication and the exact native redirect `autocodez://auth/passkey`.

### Microsoft production provider

Microsoft social login must use an Auto CodeZ-owned Microsoft Entra application in production rather than Descope's shared provider.

Microsoft Entra configuration:

- Supported account types: accounts in any organizational directory and personal Microsoft accounts.
- Platform: Web.
- Redirect URI: `https://api.descope.com/v1/oauth/callback` unless a Descope custom domain is configured later.
- OAuth/OIDC scopes should remain minimal: `openid`, `email`, `profile`. Do not request Microsoft Graph permissions such as `User.Read` unless a product feature actually requires Graph access.
- The client secret belongs only in Descope. It must never be embedded in the Electron application, repository, CI artifact, or local renderer configuration.

Descope configuration:

- Social Login -> Microsoft -> Use my own account.
- Client ID: Microsoft Entra Application (client) ID.
- Client Secret: the current Entra secret value.
- Trigger methods: Enable All.
- Keep email promotion restricted to verified email addresses.
- Do not merge users purely from an unverified Microsoft email address.

Microsoft can return an email that Descope does not consider verified. Auto CodeZ therefore treats the immutable Descope user ID as the account key. Email is profile/contact data and must not be used as the authoritative account identifier or as an unsafe account-merging key.

### Magic Link production configuration

Magic Link uses the Descope API directly and returns to the native callback `autocodez://auth/magic-link`.

Descope configuration:

- Authentication Methods -> Magic Link -> Enable method in API and SDK: enabled.
- Project Settings -> General -> Security -> Approved Domains -> Mobile App Schemes: add `auth`. Descope validates the host/identifier of custom-scheme redirects; the Auto CodeZ callback host is `auth`.
- Keep the callback path fixed as `/magic-link`. The runtime only adds protected `flowId` and `state` query parameters; Descope appends the one-time token as `t`.
- Recommended token expiration: 3-5 minutes. Auto CodeZ also keeps its local pending transaction time-limited.
- Configure a retry/attempt limit per recipient to reduce spam and repeated-send abuse.
- Self-service Magic Link sign-up requires delivery to a not-yet-verified email address. If the project blocks unverified recipients, new-user Magic Link sign-up cannot complete. If this setting is enabled, keep the retry limits strict because it increases spam exposure.

Delivery:

- Descope's built-in email delivery is acceptable for development and early testing.
- Before production, use an Auto CodeZ-owned email connector if the product must not depend on Descope's built-in delivery quota or if branded sender/domain control is required.
- Messaging-provider credentials belong only in Descope's connector configuration; they must never be embedded in Electron or committed to the repository.

Security behavior in the desktop:

- Email is normalized before the request and only a masked hint is exposed to the renderer state.
- The full email is not persisted in the pending Magic Link transaction.
- The callback must match both the protected `flowId` and cryptographically random `state`.
- A forged state does not consume the legitimate pending transaction.
- The one-time token is never persisted after completion and is not exposed in the public auth snapshot.
- The returned Session JWT is verified before the account is established.


## Local development

Project ID is a public client/project identifier, not a secret.

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

- System browser for external provider/passkey authentication.
- Native UI chooses GitHub, Google, Microsoft, Passkey or Magic Link explicitly.
- Direct social and Magic Link responses are accepted only after the protected transaction matches.
- Direct Descope Session JWT signatures are validated using `/v2/keys/<PROJECT_ID>`.
- Session JWT issuer must belong to the configured Descope project.
- OIDC passkey/hosted ID tokens use RS256 verification against the project OIDC JWKS.
- OIDC issuer, audience, authorized-party, expiration, issued-at and nonce are validated.
- UserInfo `sub` must match the verified OIDC ID token subject.
- Unknown signing-key IDs cause one fresh JWKS fetch to tolerate normal key rotation.
- Pending auth state remains in OS-protected storage across restart.
- Forged state does not consume a legitimate pending transaction.
- Refresh tokens remain OS-protected.
- Logout clears local session state even if remote revocation is temporarily offline.
- Password authentication and SMS OTP are not part of the Auto CodeZ account model.

## Acceptance checklist

Before closing Account Core authentication, perform real provider acceptance on the exact validated branch head:

1. GitHub login completes and returns to Auto CodeZ.
2. Google login completes and returns to Auto CodeZ.
3. Microsoft login completes and returns to Auto CodeZ.
4. Magic Link is delivered, opens the callback and establishes the account.
5. Passkey can complete through the dedicated passkey callback.
6. Cancelling GitHub/Google/Microsoft returns a clean error state.
7. Cancelling Passkey returns a clean error state.
8. Closing/restarting Auto CodeZ while OAuth, Magic Link or Passkey is pending still allows the valid callback to complete before expiry.
9. A forged callback does not invalidate the real pending transaction.
10. App restart restores an authenticated session using the protected refresh token.
11. Temporary network loss preserves cached account metadata without exposing secrets.
12. Refresh succeeds after access/session expiry and preserves the original identity provider.
13. Logout clears local session credentials and revokes the active refresh session when reachable.

## Azure

Azure remains available for Auto CodeZ AI/model/tool testing and future optional cloud services. It is not an authentication dependency.
