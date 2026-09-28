# Agent Core V2 — Contrato arquitetural

Status: blueprint canônico de implementação. Este documento define invariantes antes da migração do runtime existente.

## 1. Objetivo

O Agent Core V2 transforma o Auto CodeZ em uma plataforma de automação local-first alimentada por IA. O agente deve conseguir executar tarefas longas, modificar o workspace incrementalmente, gerenciar processos e instâncias, recuperar-se de falhas e produzir evidência verificável sem depender de um Shadow Workspace de tarefa inteira.

O chat é uma superfície do Agent Core. MCP, plugins, integrações e futuras interfaces devem convergir para o mesmo Capability Registry, Policy Engine e Execution Engine.

## 2. Invariantes

1. Sucesso exige evidence real.
2. Toda mutação persistente deve possuir Operation Journal.
3. O workspace real é atualizado operação por operação.
4. Escritas de arquivo devem ser atômicas e verificadas.
5. Unrestricted não pede approvals rotineiros dentro do scope já concedido.
6. SecurityPolicy continua ativa em unrestricted.
7. Progresso, não contagem pequena de tool rounds, determina continuidade.
8. Trabalho correto anterior sobrevive a falha posterior.
9. Retry não repete side effects cegamente.
10. Processos persistentes possuem processId e lifecycle.
11. Instâncias abertas possuem instanceId e lifecycle.
12. Activity é evento estruturado; texto é uma projeção.
13. Operational Trace não é Activity UI.
14. Run Summary deriva de evidence.
15. Provider quirks ficam nos adapters.
16. ContextCompiler é a fonte central das instruções do agente.
17. Memory/Personalization pertencem ao Auto CodeZ e são provider-independent.
18. Chat/MCP/Plugins não podem bypassar o pipeline comum de capability → policy → execution → journal → evidence.

## 3. Fluxo do run

```text
User Request
  -> ContextCompiler
  -> RunCoordinator
  -> Planner
  -> Agent/Provider Adapter
  -> Capability Resolver
  -> PolicyEngine
  -> ExecutionEngine
  -> Recovery Journal
  -> Verification
  -> EvidenceGraph
  -> ActivityEngine
  -> next turn / ResultSynthesizer
```

O RunCoordinator é dono do lifecycle. AgentRuntime não deve continuar acumulando responsabilidades heterogêneas.

Estados canônicos:

```text
queued
planning
running
waiting_approval
waiting_external
paused
recovering
completed
failed
cancelled
```

Estados terminais não podem retornar para running. Retry cria novo run; resume é uma transição explícita de um estado retomável.

## 4. Execução incremental

A unidade transacional é a operação individual.

Exemplo de create_file:

1. validar input;
2. canonicalizar path;
3. avaliar scope/security/permission;
4. criar registro journal PREPARED;
5. capturar before snapshot;
6. escrever arquivo temporário no mesmo volume;
7. flush/close;
8. materializar destino atomically;
9. verificar exists/hash/size;
10. atualizar journal VERIFIED;
11. gerar evidence;
12. emitir activity completed;
13. retornar resultado à IA.

O arquivo deve ser visível no disco antes da tool retornar sucesso.

Shadow Workspace não é o default do V2.

## 5. Capability Registry

Toda capability deve declarar contrato rico e versionado: identificação, categoria, whenToUse, whenNotToUse, schemas, exemplos, failure modes, side effects, annotations, rollback, parallelism, resource locks, permission class e activity metadata.

Primitivas previstas:

### Workspace

- read_file
- read_symbol
- list_directory
- search_files
- search_text
- stat_path
- create_file
- create_folder
- write_file
- replace_text
- replace_range
- replace_symbol
- insert_before
- insert_after
- copy_path
- move_path
- delete_path

create_file cria diretórios pais. create_folder é usado quando a pasta é o resultado/estado desejado.

### Command / Process

- run_command para comandos finitos
- start_process
- read_process_output
- wait_process
- stop_process
- list_processes
- wait_for_port

### Instance

- open_instance
- instance_status
- focus_instance
- close_instance

Futuro:

- capture_instance
- inspect_instance
- interact_instance

## 6. Policy Engine

Permission, scope e security são dimensões separadas.

Unrestricted significa que PermissionPolicy não pede confirmação para capabilities suportadas dentro do scope. Isso não desativa SecurityPolicy.

Novo root fora do scope pode exigir concessão explícita. Depois de concedido, não pedir aprovação a cada operação.

Security hard-deny permanece aplicável a paths de sistema, escape por symlink/junction, operações destrutivas de SO, exfiltração de secrets e outras violações determinísticas.

## 7. Progress Watchdog

MAX_TOOL_ROUNDS baixo deixa de ser mecanismo normal.

O watchdog observa evidence/progresso:

- hashes novos;
- arquivo/diretório criado;
- mudança validada;
- processo mudou de estado;
- teste/build produziu resultado;
- plan step avançou;
- erro novo;
- fonte nova relevante.

Fingerprint repetido sem nova evidence aumenta loop score. O runtime força replan antes de falhar.

## 8. Recovery Journal

Cada mutação registra before/after, hashes e rollback reference.

Rollback detecta conflitos e nunca sobrescreve mudança externa silenciosamente.

O mesmo motor deverá sustentar Restore Points e recuperação após crash/restart.

## 9. ContextCompiler

Camadas:

1. Core Contract.
2. Runtime Manifest.
3. Capability Documentation.
4. Product/UI Manifest.
5. Skills relevantes.
6. User Personalization.
7. Account/Project Memory.
8. Task Context.

Agent Handbook é versionado e compilado seletivamente. Não enviar mega-prompt fixo inteiro em todo turno.

## 10. Activity Engine

Activity events são estruturados:

```json
{
  "kind": "workspace.file.create",
  "phase": "completed",
  "subject": { "path": "src/App.tsx" },
  "runId": "...",
  "toolCallId": "...",
  "durationMs": 31
}
```

ActivityNarrator agrupa eventos em narrativa de etapa. Capability metadata fornece fallback para capabilities desconhecidas/plugins.

Operational Trace retém detalhes técnicos; Activity UI mostra apenas o que é útil para o usuário.

## 11. Run Summary

RunSummaryBuilder usa EvidenceGraph para computar fatos. A IA pode transformar fatos em frase curta, mas não inventar estado.

A barra "Ver trabalho realizado" expõe detalhes; a resposta final permanece pequena.

## 12. Mensagens da IA

A barra de ações só aparece após lifecycle terminal/estável.

Ações:

- copiar;
- retry como nova variante/run;
- adicionar à memória;
- ramificar;
- continuar quando run parcial;
- ver trabalho;
- ver alterações;
- fontes;
- menu de ações secundárias.

Retry nunca reexecuta side effects antigos automaticamente.

## 13. Memory e Personalization

Memory é provider-independent e pode ter escopo global/projeto/conversa.

Personalization é uma camada separada, até 1000 caracteres inicialmente, usada para estilo/preferências e subordinada às regras do sistema.

## 14. Migração

Fases:

1. contratos + testes sem mudar comportamento;
2. Operation Journal;
3. Capability metadata;
4. create_folder;
5. migrar create_file para execução incremental real;
6. migrar demais writes;
7. Policy Engine V2;
8. long-running watchdog;
9. Process Runtime;
10. Instance Runtime;
11. Activity Engine V2;
12. ResultSynthesizer/barra de ações;
13. retirar Shadow Workspace default;
14. stress/E2E real com projeto grande.

Nunca remover o caminho antigo antes de a capacidade equivalente estar coberta por testes e rollback.
