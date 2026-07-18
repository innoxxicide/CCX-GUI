package com.github.ccxgui.provider.claude;

import com.github.ccxgui.util.PlatformUtils;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.util.concurrency.AppExecutorUtil;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.Duration;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Fetches the signed-in Claude account's rate-limit utilization (the 5-hour
 * session window and the 7-day/weekly windows) from Anthropic's OAuth usage
 * endpoint and normalizes it for the webview battery indicators.
 *
 * <p>The endpoint is only meaningful for OAuth (Pro/Max) logins; API-key users
 * have no {@code claudeAiOauth} token and receive an {@code available:false}
 * payload so the UI can hide the indicators.
 *
 * <p>Results are cached account-globally (they are not project scoped) with a
 * short TTL plus in-flight de-duplication, so triggering a refresh on every
 * agent {@code [USAGE]} tag performs at most one network call per TTL window.
 */
public final class ClaudeUsageLimitsService {

    private static final Logger LOG = Logger.getInstance(ClaudeUsageLimitsService.class);

    private static final String USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
    private static final String OAUTH_BETA_HEADER = "oauth-2025-04-20";
    private static final long TTL_MS = 60_000L;
    /**
     * Shorter retry window used after a failed fetch, so the indicators recover
     * from a transient endpoint/auth error within seconds instead of a full
     * success-TTL — without re-hitting the network on every streaming [USAGE] tag.
     */
    private static final long ERROR_TTL_MS = 10_000L;
    /**
     * Safety window after which a running fetch is assumed to have leaked its
     * lock and is forcibly reclaimed. Must exceed the connect + request timeouts
     * below so a genuinely slow fetch is never mistaken for a leak.
     */
    private static final long IN_FLIGHT_GUARD_MS = 30_000L;

    private static final Gson GSON = new Gson();
    /**
     * Millis when the in-flight fetch started, or {@code 0} when none is running.
     * A self-healing lock: a non-zero value older than {@link #IN_FLIGHT_GUARD_MS}
     * is treated as leaked and reclaimed by {@link #tryAcquireInFlight()}, so a
     * dispatch that fails before running its release path can never freeze the
     * indicators permanently.
     */
    private static final AtomicLong inFlightSince = new AtomicLong(0L);
    private static final HttpClient HTTP_CLIENT = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .build();

    /** Last successful "available" payload, kept so transient errors don't blank the UI. */
    private static volatile String cachedAvailableJson;
    /** Last payload actually produced (available or unavailable) — answers pull requests. */
    private static volatile String lastJson;
    private static volatile long lastFetchAt = 0L;
    /** Whether the most recent fetch failed, so the next refresh uses ERROR_TTL_MS. */
    private static volatile boolean lastFetchFailed = false;

    private ClaudeUsageLimitsService() {
    }

    /**
     * Refresh only when the cache is stale and no fetch is already running.
     * Intended for the push-on-agent-input path: returns the JSON to push, or
     * {@code null} when nothing new should be sent (fresh cache / in-flight).
     */
    public static CompletableFuture<String> refreshIfStale() {
        if (System.currentTimeMillis() - lastFetchAt < currentTtlMs()) {
            return CompletableFuture.completedFuture(null);
        }
        if (!tryAcquireInFlight()) {
            return CompletableFuture.completedFuture(null);
        }
        return dispatchFetch(null);
    }

    /**
     * Answer a pull request (initial load / manual refresh / opening the modal).
     * Returns the freshest data available: cached when fresh, otherwise a fresh
     * fetch. When {@code force} is true the TTL is bypassed. Returns {@code null}
     * only when a concurrent fetch is already producing the result.
     */
    public static CompletableFuture<String> getOrFetch(boolean force) {
        String cached = lastJson;
        if (!force && cached != null && System.currentTimeMillis() - lastFetchAt < currentTtlMs()) {
            return CompletableFuture.completedFuture(cached);
        }
        if (!tryAcquireInFlight()) {
            // A fetch is already running; it will push the real result via its own path.
            return CompletableFuture.completedFuture(cached);
        }
        return dispatchFetch(cached);
    }

    /**
     * Fetch the usage payload fresh for the limit-hit classifier, bypassing
     * <em>both</em> the TTL and the in-flight coalescing that
     * {@link #getOrFetch(boolean)} is subject to.
     *
     * <p>{@code getOrFetch(true)} only bypasses the TTL: when a push-triggered
     * refresh is already in flight it hands back the pre-error cached snapshot,
     * which is exactly the stale ("still 97%") reading we must not classify on.
     * The limit-hit path is rare, so issuing one direct HTTP call — not gated by
     * the shared lock — is an acceptable price for a reading guaranteed to be
     * taken after the limit error occurred. The result is written back into the
     * display cache opportunistically so the battery indicators refresh too.
     *
     * <p>Note this is not a substitute for confirming the block: the usage
     * endpoint can lag rate-limit enforcement, so a window may still read just
     * under 100% here. Callers should attribute by highest utilization rather
     * than demand an exact 100%.
     */
    public static CompletableFuture<String> fetchFreshForLimitCheck() {
        return CompletableFuture.supplyAsync(ClaudeUsageLimitsService::fetchDirect,
                AppExecutorUtil.getAppExecutorService());
    }

    private static String fetchDirect() {
        try {
            JsonObject oauth = readOAuthCredentials();
            String token = (oauth != null && oauth.has("accessToken") && !oauth.get("accessToken").isJsonNull())
                    ? oauth.get("accessToken").getAsString()
                    : null;
            if (token == null || token.isBlank()) {
                cachedAvailableJson = null;
                String unavailable = buildUnavailable("no_oauth");
                lastJson = unavailable;
                lastFetchFailed = false;
                lastFetchAt = System.currentTimeMillis();
                return unavailable;
            }
            String result = fetchFromApi(token, oauth);
            cachedAvailableJson = result;
            lastJson = result;
            lastFetchFailed = false;
            lastFetchAt = System.currentTimeMillis();
            return result;
        } catch (Exception e) {
            LOG.warn("[ClaudeUsageLimits] Fresh limit-check fetch failed: " + e.getMessage());
            return cachedAvailableJson != null ? cachedAvailableJson : buildUnavailable("error");
        }
    }

    private static long currentTtlMs() {
        return lastFetchFailed ? ERROR_TTL_MS : TTL_MS;
    }

    /**
     * Acquire the in-flight lock. Reclaims it when a previous dispatch has held it
     * longer than {@link #IN_FLIGHT_GUARD_MS} — i.e. leaked it by never reaching
     * its release path (e.g. the executor rejected the task). Without this reclaim
     * a single leaked lock would freeze both the push and force-refresh paths
     * permanently until the IDE restarts.
     */
    private static boolean tryAcquireInFlight() {
        long now = System.currentTimeMillis();
        long since = inFlightSince.get();
        if (since == 0L) {
            return inFlightSince.compareAndSet(0L, now);
        }
        if (now - since > IN_FLIGHT_GUARD_MS) {
            return inFlightSince.compareAndSet(since, now);
        }
        return false;
    }

    private static void releaseInFlight() {
        inFlightSince.set(0L);
    }

    /**
     * Schedule {@link #fetchAndCache()} on the app pool. If the executor rejects
     * the task, the in-flight lock is released immediately so it cannot leak, and
     * the supplied fallback is returned ({@code null} on the push path, cached
     * JSON on the pull path).
     */
    private static CompletableFuture<String> dispatchFetch(String fallbackOnReject) {
        try {
            return CompletableFuture.supplyAsync(ClaudeUsageLimitsService::fetchAndCache,
                    AppExecutorUtil.getAppExecutorService());
        } catch (Throwable t) {
            releaseInFlight();
            LOG.warn("[ClaudeUsageLimits] Failed to dispatch usage fetch: " + t.getMessage());
            return CompletableFuture.completedFuture(fallbackOnReject);
        }
    }

    private static String fetchAndCache() {
        String result;
        boolean failed = false;
        try {
            JsonObject oauth = readOAuthCredentials();
            String token = (oauth != null && oauth.has("accessToken") && !oauth.get("accessToken").isJsonNull())
                    ? oauth.get("accessToken").getAsString()
                    : null;
            if (token == null || token.isBlank()) {
                cachedAvailableJson = null;
                result = buildUnavailable("no_oauth");
            } else {
                result = fetchFromApi(token, oauth);
                cachedAvailableJson = result;
            }
        } catch (Exception e) {
            LOG.warn("[ClaudeUsageLimits] Failed to fetch usage limits: " + e.getMessage());
            // Keep showing the last good value across transient network/auth errors,
            // but flag the failure so the next refresh retries after the shorter ERROR_TTL.
            failed = true;
            result = cachedAvailableJson != null ? cachedAvailableJson : buildUnavailable("error");
        } finally {
            releaseInFlight();
        }
        lastJson = result;
        lastFetchFailed = failed;
        lastFetchAt = System.currentTimeMillis();
        return result;
    }

    private static String fetchFromApi(String token, JsonObject oauth) throws Exception {
        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(USAGE_ENDPOINT))
                .header("Authorization", "Bearer " + token)
                .header("anthropic-beta", OAUTH_BETA_HEADER)
                .header("Accept", "application/json")
                .timeout(Duration.ofSeconds(15))
                .GET()
                .build();

        HttpResponse<String> response = HTTP_CLIENT.send(request, HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() != 200) {
            throw new IllegalStateException("usage endpoint returned HTTP " + response.statusCode());
        }
        JsonObject usage = JsonParser.parseString(response.body()).getAsJsonObject();

        JsonObject out = new JsonObject();
        out.addProperty("available", true);
        out.addProperty("fetchedAt", System.currentTimeMillis());
        if (oauth != null && oauth.has("subscriptionType") && !oauth.get("subscriptionType").isJsonNull()) {
            out.addProperty("subscriptionType", oauth.get("subscriptionType").getAsString());
        }
        out.add("usage", usage);
        return GSON.toJson(out);
    }

    private static String buildUnavailable(String reason) {
        JsonObject out = new JsonObject();
        out.addProperty("available", false);
        out.addProperty("reason", reason);
        out.addProperty("fetchedAt", System.currentTimeMillis());
        return GSON.toJson(out);
    }

    /**
     * Read the {@code claudeAiOauth} object from Claude's credentials file. The
     * Claude Agent SDK keeps the access token refreshed here, so reading it
     * around agent activity yields a valid token without a separate refresh flow.
     */
    private static JsonObject readOAuthCredentials() throws Exception {
        Path path = resolveCredentialsPath();
        if (path == null || !Files.exists(path)) {
            return null;
        }
        String raw = Files.readString(path, StandardCharsets.UTF_8);
        JsonObject root = JsonParser.parseString(raw).getAsJsonObject();
        if (root.has("claudeAiOauth") && root.get("claudeAiOauth").isJsonObject()) {
            return root.getAsJsonObject("claudeAiOauth");
        }
        return null;
    }

    private static Path resolveCredentialsPath() {
        String configDir = System.getenv("CLAUDE_CONFIG_DIR");
        Path base = (configDir != null && !configDir.isBlank())
                ? Paths.get(configDir)
                : Paths.get(PlatformUtils.getHomeDirectory(), ".claude");
        return base.resolve(".credentials.json");
    }
}
