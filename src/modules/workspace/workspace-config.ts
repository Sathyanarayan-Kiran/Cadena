import { InteractionMode, loadRuntimeConfig } from '../../config/runtime-config';

export interface WorkspaceConfig {
  interactionMode: InteractionMode;
  runtimeMode: string;
  /** Local work-item creation and backlog import are permitted. */
  localCreation: boolean;
  /** Seeded-demo utilities are offered under Pilot actions. */
  pilotActions: boolean;
  /** Connectors talk to the in-process sandbox rather than real providers. */
  connectorSandbox: boolean;
}

export function workspaceConfig(): WorkspaceConfig {
  const runtime = loadRuntimeConfig();
  return {
    interactionMode: runtime.interactionMode,
    runtimeMode: runtime.mode,
    localCreation: runtime.interactionMode !== 'connector-led',
    pilotActions: runtime.interactionMode === 'pilot',
    connectorSandbox: runtime.connectorSandbox,
  };
}
