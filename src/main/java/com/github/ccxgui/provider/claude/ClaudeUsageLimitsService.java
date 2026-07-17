package com.github.ccxgui.provider.claude;

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
import java.util.concurrent.atomic.AtomicBoolean;

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

    private static final Gson GSON = new Gson();
    private static final AtomicBoolean IN_FLIGHT = new AtomicBoolean(false);
    private static final HttpClient HTTP_CLIENT = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .build();

    /** Last successful "available" payload, kept so transient errors don't blank the UI. */
    private static volatile String cachedAvailableJson;
    /** Last payload actually produced (available or unavailable) — answers pull requests. */
    private static volatile String lastJson;
    private static volatile long lastFetchAt = 0L;

    private ClaudeUsageLimitsService() {
    }

    /**
     * Refresh only when the cache is stale and no fetch is already running.
     * Intended for the push-on-agent-input path: returns the JSON to push, or
     * {@code null} when nothing new should be sent (fresh cache / in-flight).
     */
    public static CompletableFuture<String> refreshIfStale() {
        if (System.currentTimeMillis() - lastFetchAt < TTL_MS) {
            return CompletableFuture.completedFuture(null);
        }
        if (!IN_FLIGHT.compareAndSet(false, true)) {
            return CompletableFuture.completedFuture(null);
        }
        return CompletableFuture.supplyAsync(ClaudeUsageLimitsService::fetchAndCache,
                AppExecutorUtil.getAppExecutorService());
    }

    /**
     * Answer a pull request (initial load / manual refresh / opening the modal).
     * Returns the freshest data available: cached when fresh, otherwise a fresh
     * fetch. When {@code force} is true the TTL is bypassed. Returns {@code null}
     * only when a concurrent fetch is already producing the result.
     */
    public static CompletableFuture<String> getOrFetch(boolean force) {
        String cached = lastJson;
        if (!force && cached != null && System.currentTimeMillis() - lastFetchAt < TTL_MS) {
            return CompletableFuture.completedFuture(cached);
        }
        if (!IN_FLIGHT.compareAndSet(false, true)) {
            // A fetch is already running; it will push the real result via its own path.
            return CompletableFuture.completedFuture(cached);
        }
        return CompletableFuture.supplyAsync(ClaudeUsageLimitsService::fetchAndCache,
                AppExecutorUtil.getAppExecutorService());
    }

    private static String fetchAndCache() {
        String result;
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
            // Keep showing the last good value across transient network/auth errors.
            result = cachedAvailableJson != null ? cachedAvailableJson : buildUnavailable("error");
        } finally {
            IN_FLIGHT.set(false);
        }
        lastJson = result;
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
                : Paths.get(System.getProperty("user.home"), ".claude");
        return base.resolve(".credentials.json");
    }
}
