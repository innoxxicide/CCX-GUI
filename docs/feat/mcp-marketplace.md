# MCP Marketplace – Integrationsanalyse & Stand

> Status: **implementiert** (PR gegen `upstream/feature/v0.4.6`)
> Branch: `feature/mcp-marketplace`
> Erstellt: 2026-06-15 · Aktualisiert: 2026-06-15
>
> Architektur-Leitlinie: **reines Java-Backend, Webview nur zur Anzeige.**

Dieses Dokument beschreibt, **wo** der MCP-Marketplace in den Settings andockt
und **was umgesetzt** ist.

---

## 1. Einstieg in der UI (Settings)

| Schritt | Datei |
| --- | --- |
| Sidebar-Eintrag `mcp` | `webview/src/components/settings/SettingsSidebar/index.tsx` (Zeile 4 + 17) |
| Routing auf die Section | `webview/src/components/settings/PlaceholderSection/index.tsx` (`type === 'mcp'` → `McpSettingsSection`) |
| Eigentliche MCP-Section | `webview/src/components/mcp/McpSettingsSection.tsx` |

Der Tab `mcp` ist als `SettingsTab` definiert und wird über die `PlaceholderSection`
an `McpSettingsSection` durchgereicht.

---

## 2. Die zentrale Integrationsstelle (der „Hook")

In `McpSettingsSection.tsx` öffnet das Dropdown des Add-Buttons den Eintrag
**„Add from MCP market"** über `handleAddFromMarket`. Vor dem Patch zeigte das nur
einen `mcp.marketComingSoon`-Toast; **der Patch biegt es auf den Marketplace-Dialog um**:

```tsx
// McpSettingsSection.tsx (nach Patch)
const handleAddFromMarket = useCallback(() => {
  setShowDropdown(false);
  setShowMarketplaceDialog(true);   // statt Coming-soon-Toast
}, []);
```

`onSelect` des Dialogs ist `handleSaveServer` – es läuft also derselbe Add-Pfad wie
beim manuellen Anlegen (`add_${prefix}mcp_server`). Kein neuer Persistenzpfad nötig.

---

## 3. Was der Patch liefert (`codriver-mcp-marketplace.patch`)

> `git apply --check` läuft **sauber** durch (nur neue Dateien + 4 kleine Einschübe).

### 3.1 Java-Backend (reine Logik, neues Package `mcp/marketplace`)

| Datei | Aufgabe |
| --- | --- |
| `handler/marketplace/McpMarketplaceHandler.java` | Bridge-Handler: `get_mcp_marketplace_sources`, `search_mcp_marketplace` → `window.updateMcpMarketplace*` |
| `mcp/marketplace/McpMarketplaceService.java` | Orchestriert Quellen: laden, **dedupe**, Suche/Filter, Sortierung (official → installable → Name), Cap 250 |
| `mcp/marketplace/McpMarketplaceSource.java` | Quellen-Modell + `defaults()` (siehe 3.3) |
| `mcp/marketplace/BuiltInMcpMarketplaceClient.java` | Die bisherigen 5 Presets als Built-in-Quelle |
| `mcp/marketplace/RegistryMarketplaceClient.java` | MCP-Registry v0.1 (paginiert via `next_cursor`) |
| `mcp/marketplace/GitHubOrgMarketplaceClient.java` | GitHub-Org-Repos (sterne-sortiert, paginiert) |
| `mcp/marketplace/McpRegistryEntryMapper.java` | Normalisiert Registry-/GitHub-JSON → Entry inkl. Install-Optionen: npm→`npx -y`, pypi→`uvx`, docker→`docker run`; Secret-/Header-**Platzhalter** |
| `mcp/marketplace/McpMarketplaceHttpClient.java` | HTTP GET + Platten-Cache (TTL 1 h, Stale-Fallback, optional `GITHUB_TOKEN`) |
| `mcp/marketplace/McpMarketplaceEntry.java` / `McpInstallOption.java` / `McpMarketplaceJson.java` | Modelle + JSON-Helper |
| `ui/ChatWindowDelegate.java` | Registriert `McpMarketplaceHandler` neben `McpServerHandler` |

### 3.2 Webview (nur Anzeige)

- `components/mcp/McpMarketplaceDialog.tsx` – Browser mit Suchfeld, **Quellen-Dropdown**,
  Liste, Detail-Panel, Install-Optionen-Auswahl und **Config-Preview** vor dem Hinzufügen.
- `McpSettingsSection.tsx` – `showMarketplaceDialog`-State, Dialog verdrahtet, `onSelect = handleSaveServer`.
- `types/mcp.ts` – `McpMarketplaceSource`, `McpInstallOption`, `McpMarketplaceEntry`, `McpMarketplaceSearchResponse`.
- `global.d.ts` – Callbacks `updateMcpMarketplaceSources` / `updateMcpMarketplaceEntries`.
- `styles/less/components/mcp.less` – Styles für den Dialog.

Der alte `McpPresetDialog` **bleibt unangetastet** – additiv, nichts wird kaputtgemacht.

### 3.3 Quellen (getrennt, im Dropdown wählbar) – `McpMarketplaceSource.defaults()`

| id | Name | Typ | URL |
| --- | --- | --- | --- |
| `built-in` | Built-in Presets | `BUILT_IN` | (lokal) |
| `official-registry` | Official MCP Registry | `REGISTRY` | `registry.modelcontextprotocol.io` |
| `github-mcp-registry` | GitHub MCP Registry | `REGISTRY` | `api.mcp.github.com` |
| `official-github-org` | MCP Official GitHub Org | `GITHUB_ORG` | `github.com/modelcontextprotocol` |

Dazu die Pseudo-Quelle **„All sources"** (`all`) im Dropdown, die quellenübergreifend sucht.

---

## 4. Abgleich mit den Anforderungen

| Anforderung | Status | Hinweis |
| --- | --- | --- |
| Reines Java-Backend, Webview nur Anzeige | ✅ erfüllt | Logik komplett in `mcp/marketplace/*` |
| Quellen getrennt | ✅ erfüllt | `SourceType {BUILT_IN, REGISTRY, GITHUB_ORG}` |
| Dropdown zur Quellenwahl | ✅ erfüllt | `marketplace-source-select` im Dialog |
| Vorhandenes nicht kaputtmachen | ✅ erfüllt | rein additiv, `McpPresetDialog` bleibt |
| **Favorit bleibt selektiert** (über Sessions/Öffnen) | ✅ erfüllt | `localStorage`, siehe 5.1 |

---

## 5. Umgesetzte Details

### 5.1 Persistenz der Quellenwahl

`selectedSourceId` wird im `McpMarketplaceDialog` aus `localStorage` initialisiert
(`readPreferredSourceId`) und bei jeder Änderung zurückgeschrieben
(`rememberPreferredSourceId`, Key `codriver.mcp.marketplace.lastSourceId`). Existiert
die gespeicherte Quelle nicht mehr, fällt der Dialog auf `built-in` zurück. Die
Java-Schicht bleibt frei von View-Zustand (folgt dem `LAST_SERVER_ID`-Muster).

### 5.2 i18n

Alle Dialog-Strings laufen über `t('mcp.market.*')` bzw. `t('mcp.import.*')`; die
Keys liegen in allen 10 Locales (`webview/src/i18n/locales/*.json`).

### 5.3 Registry-Schema (v0.1)

Sowohl `official-registry` als auch `github-mcp-registry` liefern die verschachtelte
Hülle `{ server, _meta }` mit `metadata.nextCursor`. `McpRegistryEntryMapper` entpackt
die `server`-Hülle und rendert die Install-Optionen aus `packages[]` inklusive
`runtimeHint`, `runtimeArguments`, `packageArguments` (positional/named),
`environmentVariables` und `transport.type`; `{placeholder}`-Werte bleiben erhalten.
Abgedeckt durch `McpRegistryEntryMapperTest`.

> Spätere Politur: „installiert"-Badge (Abgleich mit `servers` aus `useServerData`),
> Secret-Eingabe über vorbefüllten `McpServerDialog` statt direktem Hinzufügen bei
> Einträgen mit Platzhaltern, Codex-spezifisches Mapping (`CodexMcpServerSpec`:
> `http_headers`, `bearer_token_env_var`). Offen bleibt der interaktive GUI-Smoke-Test
> in der Sandbox-IDE (Claude **und** Codex).

---

## 7. „Offiziell" im MCP-Kontext (Hintergrund zur Quellenwahl)

MCP ist ein **offener Standard**, den sowohl Anthropic (Claude) als auch OpenAI
(Codex/ChatGPT) als *Clients* nutzen – dieses Plugin ist ohnehin multi-provider
(`apps: { claude, codex, gemini }`). Es gibt daher keine konkurrierenden
„Anthropic-" vs. „OpenAI-Registries". „Offiziell" meint hier die **neutrale** Quelle
des MCP-Projekts:

| Quelle | Art | Rolle im Patch |
| --- | --- | --- |
| `github.com/modelcontextprotocol/servers` (README-Liste) | kuratiert, **keine API** | Basis der `built-in`-Presets |
| `registry.modelcontextprotocol.io` | kanonische **Registry mit REST-API** | `official-registry`-Quelle |

Der Patch realisiert damit faktisch einen **Hybrid**: Built-in-Bundle als
Offline-Seed **plus** Live-Registry – ohne Drittanbieter-API-Key (anders als
Smithery/mcp.so, die bewusst nicht aufgenommen wurden).

---

## 8. Datei-Referenzen (Kurzfassung)

- Patch: `codriver-mcp-marketplace.patch` (Repo-Root)
- Hook-Punkt: `webview/src/components/mcp/McpSettingsSection.tsx` (`handleAddFromMarket`)
- Neuer Dialog: `webview/src/components/mcp/McpMarketplaceDialog.tsx` (Quellen-Dropdown, Persistenz-Lücke)
- Java-Backend: `src/main/java/com/github/claudecodegui/mcp/marketplace/*`
- Java-Handler: `src/main/java/com/github/claudecodegui/handler/marketplace/McpMarketplaceHandler.java`
- Handler-Registrierung: `src/main/java/com/github/claudecodegui/ui/ChatWindowDelegate.java`
- Add-Pfad (unverändert): `src/main/java/com/github/claudecodegui/handler/McpServerHandler.java`
- Typen: `webview/src/types/mcp.ts` (Marketplace-Typen am Dateiende)
- i18n (offen): `webview/src/i18n/locales/*.json` (`mcp.market.*`)
