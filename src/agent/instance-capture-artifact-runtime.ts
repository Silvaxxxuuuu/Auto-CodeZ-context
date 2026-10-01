import type { AIAttachment } from '../ai/types';
import type { AttachmentStore } from '../ai/attachment-store';
import { InstanceRuntime } from './instance-runtime';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_PREVIEW_CAPTURE_BYTES = 8 * 1024 * 1024;

export type StoredInstanceCapture = {
  instanceId: string;
  projectId: string;
  attachment: AIAttachment;
};

/**
 * Bridges a controlled preview capture into the existing, hash-verified
 * attachment store. It intentionally does not expose raw image bytes to the
 * tool text channel or claim that the active model has inspected the image.
 */
export class InstanceCaptureArtifactRuntime {
  constructor(
    private readonly instances: InstanceRuntime,
    private readonly attachments: Pick<AttachmentStore, 'importBuffer'>,
  ) {}

  async capture(projectId: string, instanceId: string): Promise<StoredInstanceCapture> {
    const instance = this.instances.get(instanceId);
    if (instance.projectId !== projectId) throw new Error('A instância pertence a outro projeto.');
    if (instance.kind !== 'preview') throw new Error('Somente previews controlados oferecem captura.');

    const bytes = await this.instances.capture(instanceId);
    if (
      bytes.length < PNG_SIGNATURE.length
      || bytes.length > MAX_PREVIEW_CAPTURE_BYTES
      || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
    ) {
      throw new Error('A captura do preview não contém uma imagem PNG válida.');
    }

    // A second check covers a project or lifecycle change during async capture.
    const current = this.instances.get(instanceId);
    if (current.projectId !== projectId || current.status !== 'open') {
      throw new Error('A instância deixou de estar disponível durante a captura.');
    }
    const attachment = await this.attachments.importBuffer(bytes, 'preview.png', 'image/png');
    return { instanceId, projectId, attachment };
  }
}
