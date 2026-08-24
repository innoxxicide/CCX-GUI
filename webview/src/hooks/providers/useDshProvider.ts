import { DSH_DEFAULT_MODEL_ID } from '../../components/ChatInputBox/types';
import { useCliProviderState } from './useCliProviderState';

/**
 * DSH (DeepSeek Harness) provider state.
 * Auth/config lives in the DSH host ($DSH_HOME via the DSH Web UI); the plugin
 * only stores the last-picked `provider/model` id locally.
 */
export function useDshProvider() {
  const state = useCliProviderState(DSH_DEFAULT_MODEL_ID);
  return {
    selectedDshModel: state.selectedModel,
    setSelectedDshModel: state.setSelectedModel,
    dshPermissionMode: state.permissionMode,
    setDshPermissionMode: state.setPermissionMode,
  };
}

export type UseDshProviderReturn = ReturnType<typeof useDshProvider>;
