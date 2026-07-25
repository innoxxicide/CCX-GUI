package com.github.ccxgui.handler;

import com.github.ccxgui.handler.core.BaseMessageHandler;
import com.github.ccxgui.handler.core.HandlerContext;
import com.github.ccxgui.provider.claude.ClaudeSDKBridge;
import com.github.ccxgui.provider.claude.ClaudeUsageLimitsService;
import com.intellij.openapi.application.ApplicationActivationListener;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.wm.IdeFrame;
import com.intellij.util.concurrency.AppExecutorUtil;
import com.intellij.util.messages.MessageBusConnection;
import org.jetbrains.annotations.NotNull;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

/**
 * Keeps the signed-in Claude account's usage limits (5-hour session + weekly
 * windows) in front of the header battery indicators.
 *
 * <p>Serves the webview pull path — initial load, session open, manual refresh,
 * opening the usage-statistics modal — and additionally drives two idle triggers
 * so the gauges do not sit frozen between agent turns:
 * <ul>
 *   <li>a once-a-minute poll, and</li>
 *   <li>IDE-window activation, so returning from another app shows current
 *       numbers immediately rather than whatever was last fetched.</li>
 * </ul>
 *
 * <p>Window focus is detected here rather than in the webview because the JCEF
 * page only sees a DOM {@code focus} event when the browser component itself
 * takes focus — alt-tabbing back into the IDE with the caret in the editor
 * raises no such event. The platform's activation topic is the reliable signal.
 *
 * <p>The push-on-agent path lives in {@code ClaudeMessageHandler#handleUsage}.
 * All paths funnel through {@code ClaudeUsageLimitsService}, whose TTL and
 * in-flight lock are account-global, so N open tabs across N projects still
 * produce at most one network call per TTL window — every tab is served the
 * same snapshot.
 */
public class ClaudeLimitsHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(ClaudeLimitsHandler.class);
    private static final String GET_CLAUDE_LIMITS = "get_claude_limits";
    private static final String[] SUPPORTED_TYPES = { GET_CLAUDE_LIMITS };

    /** Webview request asking to bypass the cache entirely (manual refresh). */
    private static final String FORCE = "force";

    /** Cadence of the idle poll. Matches the service's success TTL. */
    private static final long POLL_INTERVAL_MS = 60_000L;
    /**
     * Delay before the first poll tick. The webview asks for its own snapshot as
     * it mounts, but that request is dropped outright when the JCEF bridge is not
     * installed yet ({@code sendBridgeEvent} does not queue). An early first tick
     * is the safety net for a cold start: if the webview's request did land, this
     * one is answered from cache and costs nothing.
     */
    private static final long POLL_INITIAL_DELAY_MS = 5_000L;

    private volatile ScheduledFuture<?> pollTask;
    private volatile MessageBusConnection activationConnection;
    private volatile boolean disposed = false;

    public ClaudeLimitsHandler(HandlerContext context) {
        super(context);
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES.clone();
    }

    @Override
    public boolean handle(String type, String content) {
        if (!GET_CLAUDE_LIMITS.equals(type)) {
            return false;
        }
        refresh(FORCE.equals(content) ? RefreshKind.FORCED : RefreshKind.REQUESTED);
        return true;
    }

    /**
     * Start the idle triggers. Called once the window's handlers are wired; safe
     * to call more than once (subsequent calls are ignored).
     */
    public synchronized void startAutoRefresh() {
        if (disposed || pollTask != null) {
            return;
        }

        // The catch is load-bearing: a throwable escaping a scheduleWithFixedDelay
        // task cancels the schedule for good, which would silently freeze the
        // indicators for the rest of the IDE session.
        pollTask = AppExecutorUtil.getAppScheduledExecutorService().scheduleWithFixedDelay(
                () -> {
                    try {
                        refresh(RefreshKind.POLL);
                    } catch (Throwable t) {
                        LOG.warn("[ClaudeLimitsHandler] Usage-limit poll tick failed: " + t.getMessage());
                    }
                },
                POLL_INITIAL_DELAY_MS, POLL_INTERVAL_MS, TimeUnit.MILLISECONDS);

        Project project = context.getProject();
        MessageBusConnection connection = ApplicationManager.getApplication().getMessageBus().connect();
        connection.subscribe(ApplicationActivationListener.TOPIC, new ApplicationActivationListener() {
            @Override
            public void applicationActivated(@NotNull IdeFrame ideFrame) {
                // Only react to this window's own frame; other open projects have
                // their own handler and would otherwise each refresh N times.
                if (project != null && ideFrame.getProject() != null && ideFrame.getProject() != project) {
                    return;
                }
                refresh(RefreshKind.POLL);
            }
        });
        activationConnection = connection;
    }

    /** Stop the idle triggers. Called from the owning window's dispose path. */
    public synchronized void dispose() {
        disposed = true;
        ScheduledFuture<?> task = pollTask;
        if (task != null) {
            task.cancel(false);
            pollTask = null;
        }
        MessageBusConnection connection = activationConnection;
        if (connection != null) {
            connection.disconnect();
            activationConnection = null;
        }
    }

    /** How aggressively a refresh may bypass the service's cache. */
    private enum RefreshKind {
        /** Webview asked for a snapshot: normal TTL. */
        REQUESTED,
        /** Webview asked to bypass the TTL (manual refresh / modal open). */
        FORCED,
        /** Idle trigger (timer or window activation): TTL with poll slack. */
        POLL
    }

    private void refresh(RefreshKind kind) {
        if (disposed || context.isDisposed()) {
            return;
        }
        String provider = context.getCurrentProvider();
        if (provider != null && !"claude".equalsIgnoreCase(provider)) {
            // Usage limits only apply to Claude; the webview hides the indicators
            // for other providers, so there is nothing to push here.
            return;
        }
        ClaudeSDKBridge bridge = context.getClaudeSDKBridge();

        // Outside agent activity the SDK is not refreshing the OAuth token for
        // us, so the access token can expire with nothing to renew it. When it is
        // stale, delegate the refresh to the daemon's SDK — the official CLI owns
        // refresh-token rotation and the write-back to the credentials file —
        // then fetch fresh with the renewed token. We never write credentials or
        // call the OAuth token endpoint ourselves.
        //
        // On the poll path this is skipped while the cache would answer anyway:
        // the staleness check reads the credentials store (a Keychain shell-out
        // on macOS), which is not worth repeating every minute in every tab when
        // no fetch is going to follow it.
        //
        // The check reads the credentials store, so it runs off the caller thread.
        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            if (disposed || context.isDisposed()) {
                return;
            }
            boolean mayRenew = kind != RefreshKind.POLL || ClaudeUsageLimitsService.isRefreshDue();
            if (mayRenew && bridge != null && ClaudeUsageLimitsService.isAccessTokenStale()) {
                bridge.refreshAuthAsync().whenComplete((refreshed, ex) -> fetchAndPush(RefreshKind.FORCED));
            } else {
                fetchAndPush(kind);
            }
        });
    }

    private void fetchAndPush(RefreshKind kind) {
        CompletableFuture<String> pending =
                kind == RefreshKind.POLL
                        ? ClaudeUsageLimitsService.getOrFetchForPoll()
                        : ClaudeUsageLimitsService.getOrFetch(kind == RefreshKind.FORCED);
        pending.thenAccept(json -> {
            if (json != null && !disposed && !context.isDisposed()) {
                context.callJavaScript("onClaudeLimitsUpdate", context.escapeJs(json));
            }
        }).exceptionally(ex -> {
            LOG.warn("[ClaudeLimitsHandler] Failed to resolve usage limits: " + ex.getMessage());
            return null;
        });
    }
}
