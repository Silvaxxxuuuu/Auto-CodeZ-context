# Account API real na Azure

Este diretório prepara o primeiro teste real do Account Core V1.

Arquitetura do teste:
- Azure Container Apps para o Account API.
- HTTPS público usando o FQDN nativo do Container Apps.
- Azure Container Registry para a imagem.
- User-assigned Managed Identity com AcrPull.
- Azure Database for PostgreSQL Flexible Server.
- Container Apps Job manual para migrations.
- Azure Communication Services Email para Magic Link.
- OAuth real para GitHub, Google e Microsoft.
- Passkey/WebAuthn no mesmo origin HTTPS.

Nenhum secret deve ser commitado.

## 1. Pré-requisitos

No Windows:
- Azure CLI atual.
- Git.
- PowerShell 7 recomendado.
- assinatura Azure ativa.
- login feito com az login.

O script usa brazilsouth por padrão e usa a assinatura atualmente ativa no Azure CLI. O parâmetro -SubscriptionId continua disponível quando você quiser selecionar outra assinatura.

## 2. Bootstrap da infraestrutura

Na raiz do repositório execute:

    pwsh ./infra/azure/account-api/bootstrap.ps1

O script cria resource group, ACR, imagem, Managed Identity, Container Apps Environment, PostgreSQL, Container App e um Job separado de migrations.

O PostgreSQL usa sslmode=require.

Firewall do laboratório: --public-access 0.0.0.0 permite conexões de recursos Azure. Antes de produção pública, trocar por networking privado/VNet.

## 3. Criar OAuth apps

Depois do bootstrap, use as callback URLs impressas:

    https://<ACCOUNT_FQDN>/api/auth/callback/github
    https://<ACCOUNT_FQDN>/api/auth/callback/google
    https://<ACCOUNT_FQDN>/api/auth/callback/microsoft

## 4. Magic Link

Crie Azure Communication Services, Email Communication Service e um Azure Managed Domain para o laboratório. O domínio gerenciado dispensa domínio próprio e é suficiente para testes de baixo volume.

## 5. Ativar providers

Exemplo:

    pwsh ./infra/azure/account-api/configure-providers.ps1 \
      -GitHubClientId "<ID>" \
      -GoogleClientId "<ID>" \
      -MicrosoftClientId "<ID>" \
      -AzureEmailSender "<SENDER>"

O script pede cada secret com prompt protegido. Os secrets não aparecem na linha de comando nem precisam entrar no histórico do PowerShell.

Para automação local, também é possível definir temporariamente:
- AUTO_CODEZ_GITHUB_CLIENT_SECRET
- AUTO_CODEZ_GOOGLE_CLIENT_SECRET
- AUTO_CODEZ_MICROSOFT_CLIENT_SECRET
- AUTO_CODEZ_AZURE_EMAIL_CONNECTION_STRING

Não envie nenhum desses valores pelo chat e não os grave no repositório.

Você também pode configurar um provider por vez. O backend só anuncia métodos realmente configurados. Passkey é sempre anunciado.

## 6. Smoke test

    pwsh ./infra/azure/account-api/smoke.ps1 -BaseUrl "https://<ACCOUNT_FQDN>"

## 7. Apontar o desktop para o backend real

Na janela PowerShell usada para abrir o Auto CodeZ:

    $env:AUTO_CODEZ_ACCOUNT_API_BASE_URL="https://<ACCOUNT_FQDN>"
    Remove-Item Env:AUTO_CODEZ_VISUAL_TEST -ErrorAction SilentlyContinue
    npm start

Nunca use AUTO_CODEZ_VISUAL_TEST=1 no teste real.

## 8. Ordem de aceitação

1. GitHub real.
2. callback autocodez://auth.
3. Device Registry.
4. restart/hydrate.
5. offline cached session.
6. refresh.
7. logout.
8. Google.
9. Microsoft.
10. Magic Link.
11. adicionar Passkey.
12. logout.
13. login por Passkey.
14. revoke current/other device.
15. multi-device se houver segundo dispositivo disponível.

Account Core V1 só fecha depois desses testes essenciais serem aprovados.

## 9. Cleanup

    pwsh ./infra/azure/account-api/destroy.ps1 -ConfirmDelete

## Segurança

- ACR admin credentials desabilitadas.
- Pull usa Managed Identity.
- secrets entram como Container Apps secrets.
- scripts não gravam secrets em arquivo.
- migrations rodam em job separado.
- Account API não recebe autoridade sobre tools locais.
- deep link continua usando apenas código/token one-time.
- access token do desktop continua apenas em memória.
- private Ed25519 key continua local ao dispositivo.
