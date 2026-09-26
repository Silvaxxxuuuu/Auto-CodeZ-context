import { createAuthClient } from 'better-auth/client';
import { passkeyClient } from '@better-auth/passkey/client';

const authClient = createAuthClient({
  baseURL: window.location.origin,
  plugins: [passkeyClient()],
});

function setMessage(value: string, error = false): void {
  const root = document.querySelector<HTMLElement>('#passkey-message');
  if (!root) return;
  root.textContent = value;
  root.dataset.error = error ? 'true' : 'false';
}

async function initializeEnrollment(button: HTMLButtonElement): Promise<void> {
  button.addEventListener('click', () => {
    button.disabled = true;
    setMessage('Aguardando a criação da passkey...');

    void authClient.passkey.addPasskey({
      name: 'Auto CodeZ',
    }).then((result) => {
      if (result.error) {
        button.disabled = false;
        setMessage(result.error.message || 'Não foi possível adicionar a passkey.', true);
        return;
      }
      button.textContent = 'Passkey adicionada';
      setMessage('Passkey adicionada à sua conta. Você pode fechar esta aba.');
    }).catch((error: unknown) => {
      button.disabled = false;
      setMessage(
        error instanceof Error ? error.message : 'Não foi possível adicionar a passkey.',
        true,
      );
    });
  });
}

async function initializeSignIn(button: HTMLButtonElement): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const flowId = params.get('flowId')?.trim() ?? '';

  if (!flowId) {
    setMessage('Fluxo de autenticação inválido.', true);
    return;
  }

  button.addEventListener('click', () => {
    button.disabled = true;
    setMessage('Aguardando sua passkey...');

    void authClient.signIn.passkey({
      autoFill: false,
      fetchOptions: {
        onSuccess() {
          window.location.assign('/desktop/passkey/finish?flowId=' + encodeURIComponent(flowId));
        },
        onError(context) {
          button.disabled = false;
          setMessage(context.error.message || 'Não foi possível validar a passkey.', true);
        },
      },
    }).catch((error: unknown) => {
      button.disabled = false;
      setMessage(
        error instanceof Error ? error.message : 'Não foi possível validar a passkey.',
        true,
      );
    });
  });
}

async function initialize(): Promise<void> {
  const button = document.querySelector<HTMLButtonElement>('#passkey-start');
  if (!button) {
    setMessage('Página de passkey inválida.', true);
    return;
  }

  if (window.location.pathname === '/desktop/passkey/enroll') {
    await initializeEnrollment(button);
    return;
  }

  await initializeSignIn(button);
}

void initialize();
