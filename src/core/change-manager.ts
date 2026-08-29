import {
  ParsedFileChange,
} from './response-parser';

export type FileSnapshot = {
  path: string;
  content: string;
};

export type ProposedFileChange = {
  path: string;
  originalContent: string;
  proposedContent: string;
  changed: boolean;
};

export type ChangeProposal = {
  id: string;
  createdAt: number;
  files: ProposedFileChange[];
};

export class ChangeManager {
  private proposals =
    new Map<
      string,
      ChangeProposal
    >();

  createProposal(
    snapshots: FileSnapshot[],
    changes: ParsedFileChange[],
  ): ChangeProposal {
    const snapshotMap =
      new Map<
        string,
        FileSnapshot
      >();

    for (
      const snapshot of snapshots
    ) {
      snapshotMap.set(
        normalizePath(
          snapshot.path,
        ),
        snapshot,
      );
    }

    const files: ProposedFileChange[] =
      [];

    for (
      const change of changes
    ) {
      const path =
        normalizePath(
          change.path,
        );

      const snapshot =
        snapshotMap.get(
          path,
        );

      if (!snapshot) {
        continue;
      }

      files.push({
        path,
        originalContent:
          snapshot.content,
        proposedContent:
          change.content,
        changed:
          snapshot.content !==
          change.content,
      });
    }

    const proposal: ChangeProposal =
      {
        id:
          crypto.randomUUID(),
        createdAt:
          Date.now(),
        files,
      };

    this.proposals.set(
      proposal.id,
      proposal,
    );

    return proposal;
  }

  getProposal(
    id: string,
  ): ChangeProposal | null {
    return (
      this.proposals.get(
        id,
      ) || null
    );
  }

  discardProposal(
    id: string,
  ): boolean {
    return this.proposals.delete(
      id,
    );
  }

  acceptProposal(
    id: string,
  ): ChangeProposal {
    const proposal =
      this.getProposal(id);

    if (!proposal) {
      throw new Error(
        'Proposta não encontrada.',
      );
    }

    this.proposals.delete(
      id,
    );

    return proposal;
  }

  getPendingProposals(): ChangeProposal[] {
    return Array.from(
      this.proposals.values(),
    );
  }
}

function normalizePath(
  value: string,
): string {
  return value
    .trim()
    .replaceAll('\\', '/')
    .replace(/^\.\/+/, '');
}