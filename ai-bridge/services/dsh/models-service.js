/**
 * DSH models service — the catalog is runtime-only, from the host's
 * `llm.models` RPC. Never spawns a host for the picker (aligned with
 * desktop-cc-gui: catalog / doctor must not spawn).
 */

import { connectExisting, runtimeSettingsFromEnv } from './supervisor.js';
import { defaultDshModel, flattenLlmModels, loadModels } from './session.js';

export async function listModels() {
  const settings = runtimeSettingsFromEnv();
  try {
    const { client, describe } = await connectExisting(settings);
    const catalog = await loadModels(client);
    const models = flattenLlmModels(catalog);
    console.log(JSON.stringify({
      success: true,
      provider: 'dsh',
      defaultModel: defaultDshModel(catalog, describe),
      models,
    }));
  } catch (error) {
    // Host down / CLI missing: empty catalog + error for diagnostics. The
    // webview falls back to its static entry and the settings card shows why.
    console.log(JSON.stringify({
      success: true,
      provider: 'dsh',
      defaultModel: null,
      models: [],
      error: error.message,
    }));
  }
}
