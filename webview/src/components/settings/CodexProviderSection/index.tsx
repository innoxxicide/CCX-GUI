import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { CodexProviderConfig } from '../../../types/provider';
import { SPECIAL_PROVIDER_IDS } from '../../../types/provider';
import { sendToJava } from '../../../utils/bridge';
import { useDragSort } from '../hooks/useDragSort';
import { ProviderModelIcon } from '../../shared/ProviderModelIcon';
import ImportConfirmDialog from '../ProviderList/ImportConfirmDialog';
import sharedStyles from '../ProviderList/style.module.less';
import styles from './style.module.less';

const ICON_MR_8_STYLE: React.CSSProperties = { marginRight: '8px' };

/**
 * Wraps a colored brand logo so it aligns with the provider name text and
 * never shrinks, matching the layout of the codicon used by the local/CLI cards.
 */
const PROVIDER_LOGO_STYLE: React.CSSProperties = {
  marginRight: '8px',
  flexShrink: 0,
  display: 'inline-flex',
  alignItems: 'center',
};

/**
 * Extract the base_url and model from a Codex config.toml so the brand logo
 * can be resolved. Codex stores its endpoint config as raw TOML (rather than an
 * env object), so the brand is read from the `base_url` / `model` keys.
 * Returns the first occurrence of each key.
 */
function parseCodexConfigToml(configToml?: string): { baseUrl?: string; modelId?: string } {
  if (!configToml) return {};
  const baseUrlMatch = configToml.match(/^\s*base_url\s*=\s*"([^"]+)"/m);
  const modelMatch = configToml.match(/^\s*model\s*=\s*"([^"]+)"/m);
  return {
    baseUrl: baseUrlMatch?.[1],
    modelId: modelMatch?.[1],
  };
}

interface CodexProviderSectionProps {
  codexProviders: CodexProviderConfig[];
  codexLoading: boolean;
  onAddCodexProvider: () => void;
  onEditCodexProvider: (provider: CodexProviderConfig) => void;
  onDeleteCodexProvider: (provider: CodexProviderConfig) => void;
  onSwitchCodexProvider: (id: string) => void;
  onRevokeCodexLocalConfigAuthorization: (fallbackProviderId?: string) => void;
  addToast: (message: string, type: 'info' | 'success' | 'warning' | 'error') => void;
  showHeader?: boolean;
}

const CodexProviderSection = ({
  codexProviders,
  codexLoading,
  onAddCodexProvider,
  onEditCodexProvider,
  onDeleteCodexProvider,
  onSwitchCodexProvider,
  onRevokeCodexLocalConfigAuthorization,
  addToast,
  showHeader = true,
}: CodexProviderSectionProps) => {
  const { t } = useTranslation();

  const [showCliLoginConfirm, setShowCliLoginConfirm] = useState(false);
  const [showCliLoginDisableConfirm, setShowCliLoginDisableConfirm] = useState(false);
  const [showLocalConfigHelp, setShowLocalConfigHelp] = useState(false);

  // cc-switch import state (Codex-scoped callbacks; both provider panels are
  // mounted simultaneously, so Codex must not reuse the Claude import globals)
  const [importMenuOpen, setImportMenuOpen] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [importPreviewData, setImportPreviewData] = useState<any[]>([]);
  const importMenuRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (importMenuRef.current && !importMenuRef.current.contains(event.target as Node)) {
        setImportMenuOpen(false);
      }
    };

    // Register Codex-scoped global callbacks for Java invocation
    window.codex_import_preview_result = (dataOrStr) => {
      let data: unknown = dataOrStr;
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data);
        } catch (e) {
          console.error('Failed to parse codex_import_preview_result data:', e);
        }
      }
      const event = new CustomEvent('codex_import_preview_result', { detail: data });
      window.dispatchEvent(event);
    };

    window.codex_cc_switch_notification = (...args: unknown[]) => {
      let data: any = {};
      if (args.length >= 3 && typeof args[0] === 'string' && typeof args[2] === 'string') {
        data = { type: args[0], title: args[1], message: args[2] };
      } else if (args.length > 0) {
        data = args[0] as any;
      }
      const event = new CustomEvent('codex_cc_switch_notification', { detail: data });
      window.dispatchEvent(event);
    };

    const handleImportPreview = (event: CustomEvent) => {
      setIsImporting(false);
      const data = event.detail;
      if (data && data.providers) {
        setImportPreviewData(data.providers);
        setShowImportDialog(true);
      }
    };

    const handleImportNotification = (event: CustomEvent) => {
      setIsImporting(false);
      const data = event.detail;
      if (data && data.message) {
        addToast(data.message, data.type || 'info');
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('codex_import_preview_result', handleImportPreview as EventListener);
    window.addEventListener('codex_cc_switch_notification', handleImportNotification as EventListener);

    return () => {
      mountedRef.current = false;
      document.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('codex_import_preview_result', handleImportPreview as EventListener);
      window.removeEventListener('codex_cc_switch_notification', handleImportNotification as EventListener);
      delete window.codex_import_preview_result;
      delete window.codex_cc_switch_notification;
    };
  }, [addToast]);

  const handleSelectFileClick = () => {
    setImportMenuOpen(false);
    setIsImporting(true);
    sendToJava('open_file_chooser_for_codex_cc_switch');
  };

  const onSort = useCallback((orderedIds: string[]) => {
    sendToJava('sort_codex_providers', { orderedIds });
  }, []);

  // Filter out CLI Login provider from drag-sort list
  const regularProviders = useMemo(
    () => codexProviders.filter((p) => p.id !== SPECIAL_PROVIDER_IDS.CODEX_CLI_LOGIN),
    [codexProviders]
  );

  const {
    localItems: localProviders,
    draggedId: draggedProviderId,
    dragOverId: dragOverProviderId,
    handlePointerDown,
    handleDragStart,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handleDragEnd,
  } = useDragSort({
    items: regularProviders,
    onSort,
  });

  const cliLoginProvider = useMemo(
    () => codexProviders.find((p) => p.id === SPECIAL_PROVIDER_IDS.CODEX_CLI_LOGIN),
    [codexProviders]
  );
  const isCliLoginActive = cliLoginProvider?.isActive === true;

  return (
    <div className={styles.configSection}>
      {/* Import dialog */}
      {showImportDialog && (
        <ImportConfirmDialog
          providers={importPreviewData}
          existingProviders={codexProviders}
          onConfirm={(selectedProviders) => {
            sendToJava('save_imported_codex_providers', { providers: selectedProviders });
            setShowImportDialog(false);
          }}
          onCancel={() => setShowImportDialog(false)}
        />
      )}

      {/* Import loading */}
      {isImporting && (
        <div className={sharedStyles.loadingOverlay}>
          <div className={sharedStyles.loadingContent}>
            <span className="codicon codicon-loading codicon-modifier-spin" />
            <span>{t('settings.provider.readingCcSwitch')}</span>
          </div>
        </div>
      )}

      {showHeader && (
        <>
          <h3 className={styles.sectionTitle}>{t('settings.codexProvider.title')}</h3>
          <p className={styles.sectionDesc}>{t('settings.codexProvider.description')}</p>
        </>
      )}

      {/* CLI Login authorize confirm dialog */}
      {showCliLoginConfirm && (
        <div className={sharedStyles.warningOverlay}>
          <div className={sharedStyles.warningDialog}>
            <div className={sharedStyles.warningTitle}>
              <span className="codicon codicon-key" />
              {t('settings.codexProvider.dialog.cliLoginAuthorizeTitle')}
            </div>
            <div className={sharedStyles.warningContent}>
              {t('settings.codexProvider.dialog.cliLoginAuthorizeMessage')}
              <br />
              <br />
              {t('settings.codexProvider.dialog.cliLoginAuthorizeDetail')}
            </div>
            <div className={sharedStyles.warningActions}>
              <button
                className={sharedStyles.btnSecondary}
                onClick={() => setShowCliLoginConfirm(false)}
              >
                {t('common.cancel')}
              </button>
              <button
                className={sharedStyles.btnPrimary}
                onClick={() => {
                  setShowCliLoginConfirm(false);
                  onSwitchCodexProvider(SPECIAL_PROVIDER_IDS.CODEX_CLI_LOGIN);
                }}
              >
                {t('settings.provider.authorizeAndEnable')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* CLI Login disable confirm dialog */}
      {showCliLoginDisableConfirm && (
        <div className={sharedStyles.warningOverlay}>
          <div className={sharedStyles.warningDialog}>
            <div className={sharedStyles.warningTitle}>
              <span className="codicon codicon-circle-slash" />
              {t('settings.codexProvider.dialog.cliLoginDisableTitle')}
            </div>
            <div className={sharedStyles.warningContent}>
              {t('settings.codexProvider.dialog.cliLoginDisableMessage')}
            </div>
            <div className={sharedStyles.warningActions}>
              <button
                className={sharedStyles.btnSecondary}
                onClick={() => setShowCliLoginDisableConfirm(false)}
              >
                {t('common.cancel')}
              </button>
              <button
                className={sharedStyles.btnDanger}
                onClick={() => {
                  setShowCliLoginDisableConfirm(false);
                  const firstRegular = regularProviders[0];
                  onRevokeCodexLocalConfigAuthorization(firstRegular?.id);
                }}
              >
                {t('settings.provider.revokeAuthorization')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Local config help dialog (opened via the info icon on the local card) */}
      {showLocalConfigHelp && (
        <div className={sharedStyles.warningOverlay}>
          <div className={sharedStyles.warningDialog}>
            <div className={sharedStyles.warningTitle}>
              <span className="codicon codicon-info" />
              {t('settings.codexProvider.dialog.cliLoginProviderName')}
            </div>
            <div className={sharedStyles.warningContent} style={{ whiteSpace: 'pre-wrap' }}>
              {t('settings.codexProvider.dialog.cliLoginProviderDescription')}
            </div>
            <div className={sharedStyles.warningActions}>
              <button
                className={sharedStyles.btnPrimary}
                onClick={() => setShowLocalConfigHelp(false)}
              >
                {t('common.gotIt')}
              </button>
            </div>
          </div>
        </div>
      )}

      {codexLoading && (
        <div className={styles.tempNotice}>
          <span className="codicon codicon-loading codicon-modifier-spin" />
          <p>{t('settings.provider.loading')}</p>
        </div>
      )}

      {!codexLoading && (
        <div className={styles.providerListContainer}>
          <div className={sharedStyles.header}>
            <h4 className={sharedStyles.title}>{t('settings.provider.allProviders')}</h4>
            <div className={sharedStyles.actions}>
              <div className={sharedStyles.importMenuWrapper} ref={importMenuRef}>
                <button
                  className={sharedStyles.btnSecondary}
                  onClick={() => setImportMenuOpen(!importMenuOpen)}
                >
                  <span className="codicon codicon-cloud-download" />
                  {t('settings.provider.import')}
                </button>

                {importMenuOpen && (
                  <div className={sharedStyles.importMenu}>
                    <div
                      className={sharedStyles.importMenuItem}
                      onClick={() => {
                        setImportMenuOpen(false);
                        setIsImporting(true);
                        sendToJava('preview_codex_cc_switch_import');
                      }}
                    >
                      <span className="codicon codicon-arrow-swap" />
                      {t('settings.provider.importFromCcSwitchUpdate')}
                    </div>
                    <div
                      className={sharedStyles.importMenuItem}
                      onClick={handleSelectFileClick}
                    >
                      <span className="codicon codicon-file" />
                      {t('settings.provider.importFromCcSwitchFile')}
                    </div>
                  </div>
                )}
              </div>

              <button
                className={sharedStyles.btnPrimary}
                onClick={onAddCodexProvider}
              >
                <span className="codicon codicon-add" />
                {t('common.add')}
              </button>
            </div>
          </div>

          <div className={sharedStyles.list}>
            {/* CLI Login virtual provider card (pinned at top) */}
            {cliLoginProvider && (
              <div
                className={`${sharedStyles.card} ${isCliLoginActive ? sharedStyles.active : ''} ${sharedStyles.localProviderCard}`}
              >
                <div className={sharedStyles.cardInfo}>
                  <div className={sharedStyles.name}>
                    <span className="codicon codicon-key" style={ICON_MR_8_STYLE} />
                    <span className={sharedStyles.nameText}>{t('settings.codexProvider.dialog.cliLoginProviderName')}</span>
                    <button
                      type="button"
                      className={sharedStyles.nameInfoIcon}
                      onClick={(e) => { e.stopPropagation(); setShowLocalConfigHelp(true); }}
                      title={t('settings.provider.whatIsThis')}
                      aria-label={t('settings.provider.whatIsThis')}
                    >
                      <span className="codicon codicon-info" />
                    </button>
                  </div>
                </div>

                <div className={sharedStyles.cardActions}>
                  {isCliLoginActive ? (
                    <button
                      className={sharedStyles.revokeButton}
                      onClick={() => setShowCliLoginDisableConfirm(true)}
                    >
                      <span className="codicon codicon-circle-slash" />
                      {t('settings.provider.revokeAuthorization')}
                    </button>
                  ) : (
                    <button
                      className={sharedStyles.useButton}
                      onClick={() => setShowCliLoginConfirm(true)}
                    >
                      <span className="codicon codicon-play" />
                      {t('settings.provider.authorizeAndEnable')}
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Regular providers (drag-sortable) */}
            {localProviders.length > 0 ? (
              localProviders.map((provider) => (
                <div
                  key={provider.id}
                  className={[
                    sharedStyles.card,
                    provider.isActive && sharedStyles.active,
                    draggedProviderId === provider.id && styles.dragging,
                    dragOverProviderId === provider.id && styles.dragOver,
                  ].filter(Boolean).join(' ')}
                  data-drag-sort-id={provider.id}
                  draggable={true}
                  onDragStart={(e) => handleDragStart(e, provider.id)}
                  onDragOver={(e) => handleDragOver(e, provider.id)}
                  onDragLeave={handleDragLeave}
                  onDrop={(e) => handleDrop(e, provider.id)}
                  onDragEnd={handleDragEnd}
                >
                  <div
                    className={sharedStyles.dragHandle}
                    title={t('settings.provider.dragToSort')}
                    onPointerDown={(e) => handlePointerDown(e, provider.id, e.currentTarget.closest<HTMLElement>('[data-drag-sort-id]'))}
                  >
                    <span className="codicon codicon-gripper" />
                  </div>
                  <div className={sharedStyles.cardInfo}>
                    <div className={sharedStyles.name}>
                      {(() => {
                        const { baseUrl, modelId } = parseCodexConfigToml(provider.configToml);
                        return (
                          <span style={PROVIDER_LOGO_STYLE}>
                            <ProviderModelIcon
                              baseUrl={baseUrl}
                              modelId={modelId}
                              size={18}
                              colored
                            />
                          </span>
                        );
                      })()}
                      <span className={sharedStyles.nameText}>{provider.name}</span>
                    </div>
                    {provider.remark && (
                      <div className={sharedStyles.website}>{provider.remark}</div>
                    )}
                  </div>

                  <div className={sharedStyles.cardActions}>
                    {provider.isActive ? (
                      <div className={sharedStyles.activeBadge}>
                        <span className="codicon codicon-check" />
                        {t('settings.provider.inUse')}
                      </div>
                    ) : (
                      <button
                        className={sharedStyles.useButton}
                        onClick={() => onSwitchCodexProvider(provider.id)}
                      >
                        <span className="codicon codicon-play" />
                        {t('settings.provider.enable')}
                      </button>
                    )}

                    <div className={sharedStyles.divider} />

                    <div className={sharedStyles.actionButtons}>
                      <button
                        className={sharedStyles.iconBtn}
                        onClick={() => onEditCodexProvider(provider)}
                        title={t('common.edit')}
                      >
                        <span className="codicon codicon-edit" />
                      </button>
                      <button
                        className={sharedStyles.iconBtn}
                        onClick={() => onDeleteCodexProvider(provider)}
                        title={t('common.delete')}
                      >
                        <span className="codicon codicon-trash" />
                      </button>
                    </div>
                  </div>
                </div>
              ))
            ) : !cliLoginProvider ? (
              <div className={sharedStyles.emptyState}>
                <span className="codicon codicon-info" />
                <p>{t('settings.codexProvider.emptyProvider')}</p>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
};

export default CodexProviderSection;
