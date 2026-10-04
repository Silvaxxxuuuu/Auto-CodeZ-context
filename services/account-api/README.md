# Auto CodeZ Account API

Serviço de identidade e Device Registry do Auto CodeZ.

## Responsabilidades

- Magic Link sem senha.
- OAuth com GitHub, Google e Microsoft.
- Passkeys pelo navegador HTTPS.
- Sessões desktop próprias com access token curto e refresh token rotativo.
- Detecção de reutilização de refresh token.
- Device Registry com prova de posse Ed25519.
- Revogação de sessões e dispositivos.
- E-mail de Magic Link por Azure Communication Services Email.

O serviço **não** executa terminal, filesystem, Roblox, Blender ou qualquer tool local. A execução continua exclusivamente no desktop.

## Desenvolvimento

1. Copie `.env.example` para `.env` fora de qualquer commit.
2. Configure PostgreSQL e os providers que serão usados.
3. Rode `npm ci`.
4. Rode `npm run migrate`.
5. Rode `npm run build`.
6. Rode `npm start`.

O desktop recebe a URL HTTPS por `AUTO_CODEZ_ACCOUNT_API_BASE_URL`.

## Banco de dados

`npm run migrate` aplica:

1. o schema oficial do Better Auth, incluindo plugins;
2. todas as migrations SQL numeradas em `migrations/`, em ordem lexicográfica, incluindo o schema desktop e hardenings posteriores.

Migrations não são executadas automaticamente durante o startup do servidor.

## Fluxo de login desktop

```text
Auto CodeZ Desktop
→ POST /v1/auth/.../begin
→ navegador HTTPS
→ Better Auth
→ provider / Magic Link / Passkey
→ código de uso único
→ autocodez://auth/...
→ POST /v1/auth/.../complete + PKCE
→ sessão desktop
→ challenge Ed25519
→ Device Registry
```

Segredos permanentes nunca trafegam em query string. O deep link recebe apenas código/token de uso único com TTL curto, protegido pela troca PKCE.

## Passkeys

O login por Passkey usa o navegador HTTPS do RP configurado. Depois de uma autenticação web válida, `/desktop/passkey/enroll` permite adicionar a primeira Passkey à conta usando a sessão Better Auth do navegador. O desktop nunca recebe a credencial WebAuthn bruta.

## Azure

O container é compatível com Azure Container Apps e App Service for Containers. Recursos previstos:

- Container App / App Service
- Azure Database for PostgreSQL
- Azure Communication Services Email
- Key Vault para secrets
- domínio HTTPS do Account API

Não use os créditos de teste para provisionar recursos de produção permanentes sem budget/alerts configurados.
