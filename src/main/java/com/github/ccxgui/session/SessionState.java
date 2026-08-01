package com.github.ccxgui.session;


import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/**
 * Session state management.
 * Maintains all state information for a conversation session.
 */
public class SessionState {

    /**
     * Canonical whitelist of valid permission modes.
     * Shared across SessionHandler (payload validation) and ClaudeSession (mode resolution).
     */
    public static final Set<String> VALID_PERMISSION_MODES;
    static {
        Set<String> modes = new HashSet<>();
        modes.add("default");
        modes.add("plan");
        modes.add("acceptEdits");
        modes.add("autoEdit");
        modes.add("bypassPermissions");
        VALID_PERMISSION_MODES = Collections.unmodifiableSet(modes);
    }

    /**
     * Check whether the given mode string is a recognized permission mode.
     */
    public static boolean isValidPermissionMode(String mode) {
        return mode != null && VALID_PERMISSION_MODES.contains(mode.trim());
    }

    /**
     * Canonical whitelist of valid Claude/Codex reasoning effort levels.
     */
    public static final Set<String> VALID_REASONING_EFFORTS;
    static {
        Set<String> efforts = new HashSet<>();
        efforts.add("low");
        efforts.add("medium");
        efforts.add("high");
        efforts.add("xhigh");
        efforts.add("max");
        VALID_REASONING_EFFORTS = Collections.unmodifiableSet(efforts);
    }

    /**
     * Check whether the given reasoning effort string is recognized.
     */
    public static boolean isValidReasoningEffort(String effort) {
        return effort != null && VALID_REASONING_EFFORTS.contains(effort.trim());
    }

    // Session identifiers
    private volatile String sessionId;
    private volatile String channelId;
    private volatile String runtimeSessionEpoch = UUID.randomUUID().toString();

    // Session state — accessed only on EDT / single handler thread, no volatile needed.
    private boolean busy = false;
    private boolean loading = false;
    private String error = null;

    // Message history
    private final List<ClaudeSession.Message> messages = new ArrayList<>();

    // Session metadata — cwd is written in handler thread before send(), read inside send();
    // the happens-before from CompletableFuture.runAsync guarantees visibility, so volatile is not required.
    private String summary = null;
    private long lastModifiedTime = System.currentTimeMillis();
    private String cwd = null;

    /**
     * Placeholder provider/model for a session nobody has configured yet. They keep
     * every reader (send path, context-limit lookup, status bar) working before the
     * webview reports a selection, but they are NOT a user choice — see
     * {@link #isModelExplicitlySet()}.
     */
    public static final String DEFAULT_PROVIDER = "claude";
    public static final String DEFAULT_MODEL = "claude-sonnet-4-7";

    // Configuration fields below are volatile because set_mode / set_model / set_provider
    // and send_message may execute on different async handler threads with no other
    // happens-before guarantee between them.
    // Default to "default" (prompt on each tool call). "bypassPermissions" must be an
    // explicit, informed opt-in — see security remediation A: shipping bypass as the
    // out-of-the-box default removed the only confirmation gate for AI-issued commands.
    private volatile String permissionMode = "default";
    private volatile String model = DEFAULT_MODEL;
    private volatile String provider = DEFAULT_PROVIDER;
    // Whether anything ever chose the provider/model for this tab (webview sync,
    // per-tab restore, or inheritance from the tab a new tab was opened from), as
    // opposed to the placeholder defaults above. The webview needs the distinction:
    // it treats a backend-supplied provider/model as an authoritative per-tab
    // preference that outranks its own remembered selection, so advertising a
    // placeholder would reset every newly opened tab to the default model.
    private volatile boolean modelExplicitlySet = false;
    private volatile boolean providerExplicitlySet = false;
    // Reasoning effort (thinking depth). Null means "do not override SDK/settings".
    private volatile String reasoningEffort = null;
    // Codex service tier: null = use Codex defaults, "fast" = Codex /fast.
    private volatile String codexServiceTier = null;

    // Slash commands — volatile for cross-thread visibility (same reason as permissionMode/model/provider)
    private volatile List<String> slashCommands = new ArrayList<>();

    // PSI context collection toggle
    private boolean psiContextEnabled = true;

    // Getters
    public String getSessionId() {
        return sessionId;
    }

    public String getChannelId() {
        return channelId;
    }

    public boolean isBusy() {
        return busy;
    }

    public boolean isLoading() {
        return loading;
    }

    public String getError() {
        return error;
    }

    public List<ClaudeSession.Message> getMessages() {
        return new ArrayList<>(messages);
    }

    public List<ClaudeSession.Message> getMessagesReference() {
        return messages;
    }

    public String getSummary() {
        return summary;
    }

    public long getLastModifiedTime() {
        return lastModifiedTime;
    }

    public String getCwd() {
        return cwd;
    }

    public String getPermissionMode() {
        return permissionMode;
    }

    public String getModel() {
        return model;
    }

    public String getProvider() {
        return provider;
    }

    /**
     * Whether {@link #getModel()} reflects a real selection rather than {@link #DEFAULT_MODEL}.
     */
    public boolean isModelExplicitlySet() {
        return modelExplicitlySet;
    }

    /**
     * Whether {@link #getProvider()} reflects a real selection rather than {@link #DEFAULT_PROVIDER}.
     */
    public boolean isProviderExplicitlySet() {
        return providerExplicitlySet;
    }

    public String getReasoningEffort() {
        return reasoningEffort;
    }

    public String getCodexServiceTier() {
        return codexServiceTier;
    }

    public String getRuntimeSessionEpoch() {
        return runtimeSessionEpoch;
    }

    public List<String> getSlashCommands() {
        return new ArrayList<>(slashCommands);
    }



    public boolean isPsiContextEnabled() {
        return psiContextEnabled;
    }

    // Setters
    public void setSessionId(String sessionId) {
        this.sessionId = sessionId;
    }

    public void setChannelId(String channelId) {
        this.channelId = channelId;
    }

    public void setBusy(boolean busy) {
        this.busy = busy;
    }

    public void setLoading(boolean loading) {
        this.loading = loading;
    }

    public void setError(String error) {
        this.error = error;
    }

    public void setSummary(String summary) {
        this.summary = summary;
    }

    public void setLastModifiedTime(long lastModifiedTime) {
        this.lastModifiedTime = lastModifiedTime;
    }

    public void setCwd(String cwd) {
        this.cwd = cwd;
    }

    public void setPermissionMode(String permissionMode) {
        if (permissionMode != null && !VALID_PERMISSION_MODES.contains(permissionMode.trim())) {
            // Reject unrecognized modes silently to prevent injection of arbitrary strings
            return;
        }
        this.permissionMode = permissionMode;
    }

    public void setModel(String model) {
        this.model = model;
        if (model != null && !model.trim().isEmpty()) {
            this.modelExplicitlySet = true;
        }
    }

    public void setProvider(String provider) {
        this.provider = provider;
        if (provider != null && !provider.trim().isEmpty()) {
            this.providerExplicitlySet = true;
        }
    }

    /**
     * Copy the user-selectable preferences (provider, model, permission mode,
     * reasoning effort) from another state.
     *
     * <p>The "explicitly set" bits travel with the values on purpose: a tab that
     * inherits a placeholder default must keep reporting it as a placeholder, or
     * it would advertise a default model to the webview as if the user had picked
     * it and overwrite the selection the webview remembered.
     *
     * <p>Permission mode is copied into this state only. Callers holding a
     * {@link ClaudeSession} must still route the mode through
     * {@link ClaudeSession#setPermissionMode(String)} so the PermissionManager
     * stays in sync.
     */
    public void copyPreferencesFrom(SessionState source) {
        if (source == null) {
            return;
        }
        setProvider(source.getProvider());
        setModel(source.getModel());
        setPermissionMode(source.getPermissionMode());
        setReasoningEffort(source.getReasoningEffort());
        // After the setters, which would otherwise mark a copied placeholder explicit.
        this.providerExplicitlySet = source.providerExplicitlySet;
        this.modelExplicitlySet = source.modelExplicitlySet;
    }

    public void setReasoningEffort(String reasoningEffort) {
        if (reasoningEffort == null || reasoningEffort.trim().isEmpty()) {
            this.reasoningEffort = null;
            return;
        }
        String trimmed = reasoningEffort.trim();
        if (!isValidReasoningEffort(trimmed)) {
            return;
        }
        this.reasoningEffort = trimmed;
    }

    public void setCodexServiceTier(String codexServiceTier) {
        this.codexServiceTier = codexServiceTier;
    }

    public void setRuntimeSessionEpoch(String runtimeSessionEpoch) {
        if (runtimeSessionEpoch == null || runtimeSessionEpoch.trim().isEmpty()) {
            this.runtimeSessionEpoch = UUID.randomUUID().toString();
            return;
        }
        this.runtimeSessionEpoch = runtimeSessionEpoch;
    }

    public String rotateRuntimeSessionEpoch() {
        String newEpoch = UUID.randomUUID().toString();
        this.runtimeSessionEpoch = newEpoch;
        return newEpoch;
    }

    public void setSlashCommands(List<String> slashCommands) {
        this.slashCommands = new ArrayList<>(slashCommands);
    }



    public void setPsiContextEnabled(boolean psiContextEnabled) {
        this.psiContextEnabled = psiContextEnabled;
    }

    /**
     * Add a message to the history.
     */
    public void addMessage(ClaudeSession.Message message) {
        messages.add(message);
    }

    /**
     * Clear all messages.
     */
    public void clearMessages() {
        messages.clear();
    }

    /**
     * Update the last modified time to the current time.
     */
    public void updateLastModifiedTime() {
        this.lastModifiedTime = System.currentTimeMillis();
    }
}
