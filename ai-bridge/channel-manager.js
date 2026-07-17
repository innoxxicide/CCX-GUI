#!/usr/bin/env node

/**
 * AI Bridge Channel Manager
 * Unified bridge entry point for Claude and Codex SDKs
 *
 * Command format:
 *   node channel-manager.js <provider> <command> [args...]
 *
 * Provider:
 *   claude - Claude Agent SDK (@anthropic-ai/claude-agent-sdk)
 *   codex  - Codex SDK (@openai/codex-sdk)
 *
 * Commands:
 *   send                - Send a message (parameters passed via stdin as JSON)
 *   sendWithAttachments - Send a message with attachments (claude only)
 *   getSession          - Retrieve session message history (claude only)
 *
 * Design notes:
 * - Single entry point that dispatches to different services based on the provider parameter
 * - sessionId/threadId is managed by the caller (Java side)
 * - Messages and other parameters are passed via stdin in JSON format
 */

// Shared utilities
import { readStdinData } from './utils/stdin-utils.js';
import { handleClaudeCommand } from './channels/claude-channel.js';
import { handleCodexCommand } from './channels/codex-channel.js';
import { getSdkStatus, isClaudeSdkAvailable, isCodexSdkAvailable } from './utils/sdk-loader.js';
import { injectStartupEnvVars, configureCliIdentity } from './config/api-config.js';

// Sync proxy/TLS settings and AWS credentials from ~/.claude/settings.json
// BEFORE any network activity, but only for explicitly authorized Local
// settings.json / CLI Login modes. Without this, users behind corporate
// SSL-inspection proxies in those modes will get certificate verification
// errors, and Bedrock auth fails for desktop-launched IDEs.
injectStartupEnvVars();

// Configure CLI client identity before any SDK loading
configureCliIdentity();

// Diagnostic logging: startup info
console.log('[DIAG-ENTRY] ========== CHANNEL-MANAGER STARTUP ==========');
console.log('[DIAG-ENTRY] Node.js version:', process.version);
console.log('[DIAG-ENTRY] Platform:', process.platform);
console.log('[DIAG-ENTRY] CWD:', process.cwd());
console.log('[DIAG-ENTRY] argv:', process.argv);

// Parse command-line arguments
const provider = process.argv[2];
const command = process.argv[3];
const args = process.argv.slice(4);

// Diagnostic logging: argument info
console.log('[DIAG-ENTRY] Provider:', provider);
console.log('[DIAG-ENTRY] Command:', command);
console.log('[DIAG-ENTRY] Args:', args);

// Error handling
process.on('uncaughtException', (error) => {
  console.error('[UNCAUGHT_ERROR]', error.message);
  console.log(JSON.stringify({
    success: false,
    error: error.message
  }));
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED_REJECTION]', reason);
  console.log(JSON.stringify({
    success: false,
    error: String(reason)
  }));
  process.exit(1);
});

/**
 * Handle system-level commands (e.g., SDK status checks)
 */
async function handleSystemCommand(command, args, stdinData) {
  switch (command) {
    case 'getSdkStatus':
      // Return the installation status of all SDKs
      const status = getSdkStatus();
      console.log(JSON.stringify({
        success: true,
        data: status
      }));
      break;

    case 'checkClaudeSdk':
      // Check if Claude SDK is available
      console.log(JSON.stringify({
        success: true,
        available: isClaudeSdkAvailable()
      }));
      break;

    case 'checkCodexSdk':
      // Check if Codex SDK is available
      console.log(JSON.stringify({
        success: true,
        available: isCodexSdkAvailable()
      }));
      break;

    default:
      console.log(JSON.stringify({
        success: false,
        error: 'Unknown system command: ' + command
      }));
      process.exit(1);
  }
}

const providerHandlers = {
  claude: handleClaudeCommand,
  codex: handleCodexCommand,
  system: handleSystemCommand
};

// Execute command
(async () => {
  console.log('[DIAG-EXEC] ========== STARTING EXECUTION ==========');
  try {
    // Validate provider
    console.log('[DIAG-EXEC] Validating provider...');
    if (!provider || !providerHandlers[provider]) {
      console.error('Invalid provider. Use "claude", "codex", or "system"');
      console.log(JSON.stringify({
        success: false,
        error: 'Invalid provider: ' + provider
      }));
      process.exit(1);
    }

    // Validate command
    if (!command) {
      console.error('No command specified');
      console.log(JSON.stringify({
        success: false,
        error: 'No command specified'
      }));
      process.exit(1);
    }

    // Read stdin data
    console.log('[DIAG-EXEC] Reading stdin data...');
    const stdinData = await readStdinData(provider);
    console.log('[DIAG-EXEC] Stdin data received, keys:', stdinData ? Object.keys(stdinData) : 'null');

    // Dispatch to the appropriate provider handler
    console.log('[DIAG-EXEC] Dispatching to handler:', provider);
    const handler = providerHandlers[provider];
    await handler(command, args, stdinData);
    console.log('[DIAG-EXEC] Handler completed successfully');

    // IMPORTANT: Do not use process.exit(0) here -- it terminates the process
    // before the stdout buffer is fully flushed, which can truncate large JSON
    // output (e.g., the history returned by getSession).
    // Instead, set process.exitCode and let the process exit naturally so all I/O completes.
    process.exitCode = 0;

    // One-shot commands that load the SDK stack (history reads, usage, MCP status,
    // session rewind) can leave MCP/socket/timer handles open, so the process never
    // exits "naturally". The Java parent (ClaudeSessionQueryService.runSessionQuery)
    // reads our stdout until EOF, so a process that never exits hangs the caller
    // forever and leaks. Force a clean exit AFTER stdout has drained so output is
    // not truncated, with a safety-net timer in case the drain callback never fires.
    const FORCE_EXIT_COMMANDS = new Set([
      'rewindFiles',
      'getSession',
      'getLatestUserMessage',
      'getContextUsage',
      'getMcpServerStatus',
      'getMcpServerTools',
    ]);
    if (FORCE_EXIT_COMMANDS.has(command)) {
      let exited = false;
      const forceExit = () => {
        if (exited) return;
        exited = true;
        process.exit(process.exitCode || 0);
      };
      // Flush the stdout buffer, then exit in the write callback.
      process.stdout.write('', forceExit);
      // Safety net: if 'drain'/callback never fires, exit anyway. unref() so this
      // timer does not itself keep an otherwise-idle event loop alive.
      const safety = setTimeout(forceExit, 1000);
      if (typeof safety.unref === 'function') safety.unref();
    }

  } catch (error) {
    console.error('[COMMAND_ERROR]', error.message);
    console.log(JSON.stringify({
      success: false,
      error: error.message
    }));
    process.exit(1);
  }
})();
