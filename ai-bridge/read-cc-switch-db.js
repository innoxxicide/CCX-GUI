#!/usr/bin/env node
/**
 * Read provider configuration from cc-switch SQLite database.
 * Uses sql.js (pure JavaScript implementation, cross-platform compatible)
 *
 * Usage: node read-cc-switch-db.js <database file path> [app_type]
 *   app_type: 'claude' (default) | 'codex'
 *
 * Output: JSON format provider list
 */

import initSqlJs from 'sql.js';
import fs from 'fs';

// Get command-line arguments
const dbPath = process.argv[2];
// Optional app_type argument, defaults to 'claude' for backward compatibility
const appType = process.argv[3] || 'claude';

if (!dbPath) {
    console.error(JSON.stringify({
        success: false,
        error: 'Missing database file path argument'
    }));
    process.exit(1);
}

// Check if the file exists
if (!fs.existsSync(dbPath)) {
    console.error(JSON.stringify({
        success: false,
        error: `Database file does not exist: ${dbPath}`
    }));
    process.exit(1);
}

/**
 * Parse a Claude provider row from cc-switch into the plugin's Claude format.
 *
 * Two settings_config formats are supported:
 * 1. New format (env contains environment variables): { env: { ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN } }
 * 2. Legacy format (contains config directly): { base_url, api_key, model, ... }
 */
function parseClaudeProvider(row) {
    // Parse the settings_config JSON
    const settingsConfig = row.settings_config ? JSON.parse(row.settings_config) : {};

    // Extract configuration from settings_config
    let baseUrl = null;
    let apiKey = null;

    if (settingsConfig.env) {
        // New format: extract from the env object
        const env = settingsConfig.env;
        if (env.ANTHROPIC_BASE_URL) {
            baseUrl = env.ANTHROPIC_BASE_URL;
        }
        if (env.ANTHROPIC_AUTH_TOKEN) {
            apiKey = env.ANTHROPIC_AUTH_TOKEN;
        }
        // Also check other common environment variable names
        if (!apiKey && env.ANTHROPIC_API_KEY) {
            apiKey = env.ANTHROPIC_API_KEY;
        }
    }

    // Legacy format: extract directly from settingsConfig
    if (!baseUrl && settingsConfig.base_url) {
        baseUrl = settingsConfig.base_url;
    }
    if (!apiKey && settingsConfig.api_key) {
        apiKey = settingsConfig.api_key;
    }

    // Build settingsConfig from the original cc-switch settings_config,
    // preserving all cc-switch fields (including model, alwaysThinkingEnabled, etc.)
    const mergedSettingsConfig = {
        ...settingsConfig,
        env: {
            ...(settingsConfig.env || {}),
        },
    };

    // Build the provider config object in the format expected by the plugin
    const provider = {
        id: row.id,
        name: row.name || row.id,
        source: 'cc-switch',
        settingsConfig: mergedSettingsConfig,
    };

    // Set the env fields
    if (baseUrl) {
        provider.settingsConfig.env.ANTHROPIC_BASE_URL = baseUrl;
    }
    if (apiKey) {
        provider.settingsConfig.env.ANTHROPIC_AUTH_TOKEN = apiKey;
    }

    // Also keep top-level fields for frontend preview display
    if (baseUrl) {
        provider.baseUrl = baseUrl;
    }
    if (apiKey) {
        provider.apiKey = apiKey;
    }

    // Other metadata
    if (row.website_url) {
        provider.websiteUrl = row.website_url;
    }
    if (row.remark) {
        provider.remark = row.remark;
    }
    if (row.created_at) {
        provider.createdAt = row.created_at;
    }
    if (row.updated_at) {
        provider.updatedAt = row.updated_at;
    }

    return provider;
}

/**
 * Parse a Codex provider row from cc-switch into the plugin's Codex format.
 *
 * Codex stores credentials differently from Claude:
 * - The API key lives in settings_config.auth.OPENAI_API_KEY
 * - The base_url/model/wire_api live inside a TOML `config` string (settings_config.config)
 *
 * The plugin's Codex provider keeps these as two raw strings:
 * - configToml: the TOML content
 * - authJson: a JSON string of the auth object
 */
function parseCodexProvider(row) {
    const settingsConfig = row.settings_config ? JSON.parse(row.settings_config) : {};

    const provider = {
        id: row.id,
        name: row.name || row.id,
        source: 'cc-switch',
        // Raw TOML config string (base_url/model/wire_api live here)
        configToml: typeof settingsConfig.config === 'string' ? settingsConfig.config : '',
        // auth object (OPENAI_API_KEY) serialized back to a JSON string
        authJson: JSON.stringify(settingsConfig.auth || {}),
    };

    if (row.notes) {
        provider.remark = row.notes;
    }
    if (row.website_url) {
        provider.websiteUrl = row.website_url;
    }
    if (row.created_at) {
        provider.createdAt = row.created_at;
    }
    if (row.sort_index != null) {
        provider.sortIndex = row.sort_index;
    }

    return provider;
}

try {
    // Initialize sql.js
    const SQL = await initSqlJs();

    // Read the database file
    const fileBuffer = fs.readFileSync(dbPath);
    const db = new SQL.Database(fileBuffer);

    // Query provider configurations for the requested app type
    const result = db.exec(`
        SELECT * FROM providers
        WHERE app_type = '${appType.replace(/'/g, "''")}'
    `);

    // Check if there are any results
    if (!result || result.length === 0 || !result[0].values || result[0].values.length === 0) {
        console.log(JSON.stringify({
            success: true,
            providers: [],
            count: 0
        }));
        db.close();
        process.exit(0);
    }

    // Get column names and data
    const columns = result[0].columns;
    const rows = result[0].values;

    // Pick the row parser for the requested app type
    const parseRow = appType === 'codex' ? parseCodexProvider : parseClaudeProvider;

    // Parse each row of data
    const providers = rows.map(rowArray => {
        try {
            // Convert the array to an object keyed by column name
            const row = {};
            columns.forEach((col, index) => {
                row[col] = rowArray[index];
            });

            return parseRow(row);
        } catch (e) {
            console.error(`Failed to parse provider config:`, e.message);
            return null;
        }
    }).filter(p => p !== null);

    // Close the database
    db.close();

    // Output the result
    console.log(JSON.stringify({
        success: true,
        providers: providers,
        count: providers.length
    }));

} catch (error) {
    console.error(JSON.stringify({
        success: false,
        error: `Failed to read database: ${error.message}`,
        stack: error.stack
    }));
    process.exit(1);
}
