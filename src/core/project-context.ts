export type ProjectContextInputFile = {
  path: string;
  content: string;
};

export type ProjectContextFile = {
  path: string;
  content: string;
};

export type ProjectContext = {
  rootPath: string;
  activeFile: string | null;
  files: ProjectContextFile[];
};

export type ProjectContextInput = {
  rootPath: string;
  activeFile?: string | null;
  activeFilePath?: string | null;
  files: ProjectContextInputFile[];
  maxFiles?: number;
  maxFileSize?: number;
};

const DEFAULT_MAX_FILES = 40;
const DEFAULT_MAX_FILE_SIZE = 120000;

export function buildProjectContext(
  input: ProjectContextInput,
): ProjectContext {
  const maxFiles =
    input.maxFiles &&
    input.maxFiles > 0
      ? input.maxFiles
      : DEFAULT_MAX_FILES;

  const maxFileSize =
    input.maxFileSize &&
    input.maxFileSize > 0
      ? input.maxFileSize
      : DEFAULT_MAX_FILE_SIZE;

  const activeFile =
    input.activeFile ??
    input.activeFilePath ??
    null;

  const normalizedActivePath =
    normalizePath(
      activeFile || '',
    );

  const sortedFiles =
    [...input.files].sort(
      (a, b) => {
        const aPath =
          normalizePath(a.path);

        const bPath =
          normalizePath(b.path);

        const aIsActive =
          aPath ===
          normalizedActivePath;

        const bIsActive =
          bPath ===
          normalizedActivePath;

        if (
          aIsActive !==
          bIsActive
        ) {
          return aIsActive
            ? -1
            : 1;
        }

        return aPath.localeCompare(
          bPath,
        );
      },
    );

  const selectedFiles =
    sortedFiles
      .filter(
        (file) =>
          file.content.length <=
          maxFileSize,
      )
      .slice(
        0,
        maxFiles,
      )
      .map(
        (file) => ({
          path: normalizePath(
            file.path,
          ),
          content:
            file.content,
        }),
      );

  return {
    rootPath:
      input.rootPath,
    activeFile,
    files:
      selectedFiles,
  };
}

export function createProjectContext(
  input: ProjectContextInput,
): ProjectContext {
  return buildProjectContext(
    input,
  );
}

export function serializeProjectContext(
  context: ProjectContext,
): string {
  const sections: string[] =
    [];

  sections.push(
    `Raiz: ${context.rootPath}`,
  );

  sections.push(
    `Arquivos disponíveis: ${context.files.length}`,
  );

  sections.push(
    `Arquivo ativo: ${
      context.activeFile ||
      'nenhum'
    }`,
  );

  for (
    const file of context.files
  ) {
    sections.push(
      '',
      `===== ${normalizePath(
        file.path,
      )} =====`,
      file.content,
    );
  }

  return sections.join(
    '\n',
  );
}

function normalizePath(
  value: string,
): string {
  return value
    .trim()
    .replaceAll('\\', '/')
    .replace(/^\.\/+/, '');
}