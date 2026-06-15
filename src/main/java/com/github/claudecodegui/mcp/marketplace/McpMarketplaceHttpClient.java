package com.github.claudecodegui.mcp.marketplace;

import com.intellij.openapi.application.PathManager;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.Reader;
import java.io.Writer;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

/**
 * Fetches marketplace metadata and keeps a short-lived local cache.
 */
final class McpMarketplaceHttpClient {

    private static final Logger LOG = Logger.getInstance(McpMarketplaceHttpClient.class);
    private static final long CACHE_TTL_MS = 3_600_000L;

    private final Path cacheDirectory;

    McpMarketplaceHttpClient() {
        this.cacheDirectory = Paths.get(PathManager.getSystemPath(), "codriver", "mcp-marketplace-cache");
    }

    String get(String url, String cacheKey, boolean forceRefresh) throws IOException {
        Files.createDirectories(cacheDirectory);
        Path cacheFile = cacheDirectory.resolve(safeCacheFileName(cacheKey) + ".json");
        if (!forceRefresh && Files.exists(cacheFile)) {
            long age = System.currentTimeMillis() - Files.getLastModifiedTime(cacheFile).toMillis();
            if (age < CACHE_TTL_MS) {
                return readFile(cacheFile);
            }
        }

        try {
            String json = httpGet(url);
            try (Writer writer = new OutputStreamWriter(Files.newOutputStream(cacheFile), StandardCharsets.UTF_8)) {
                writer.write(json);
            }
            return json;
        } catch (IOException e) {
            if (Files.exists(cacheFile)) {
                LOG.warn("Using stale MCP marketplace cache after fetch failure: " + e.getMessage());
                return readFile(cacheFile);
            }
            throw e;
        }
    }

    private static String httpGet(String urlValue) throws IOException {
        URL url = new URL(urlValue);
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setRequestMethod("GET");
        connection.setRequestProperty("Accept", "application/json");
        connection.setRequestProperty("User-Agent", "CoDriver-MCP-Marketplace");
        // Only attach the GitHub token to GitHub hosts so credentials are never leaked
        // to third-party registries (e.g. registry.modelcontextprotocol.io).
        if (isGitHubHost(url.getHost())) {
            String githubToken = System.getenv("GITHUB_TOKEN");
            if (githubToken != null && !githubToken.trim().isEmpty()) {
                connection.setRequestProperty("Authorization", "Bearer " + githubToken.trim());
            }
        }
        connection.setConnectTimeout(10_000);
        connection.setReadTimeout(20_000);

        int status = connection.getResponseCode();
        if (status < 200 || status >= 300) {
            throw new IOException("HTTP " + status + " from " + urlValue);
        }

        try (InputStream inputStream = connection.getInputStream();
             BufferedReader reader = new BufferedReader(new InputStreamReader(inputStream, StandardCharsets.UTF_8))) {
            StringBuilder builder = new StringBuilder();
            String line = reader.readLine();
            while (line != null) {
                builder.append(line);
                line = reader.readLine();
            }
            return builder.toString();
        }
    }

    private static boolean isGitHubHost(String host) {
        if (host == null) {
            return false;
        }
        String lower = host.toLowerCase(java.util.Locale.ROOT);
        return lower.equals("github.com") || lower.endsWith(".github.com");
    }

    private static String readFile(Path file) throws IOException {
        try (Reader reader = new InputStreamReader(Files.newInputStream(file), StandardCharsets.UTF_8)) {
            StringBuilder builder = new StringBuilder();
            char[] buffer = new char[4096];
            int read = reader.read(buffer);
            while (read != -1) {
                builder.append(buffer, 0, read);
                read = reader.read(buffer);
            }
            return builder.toString();
        }
    }

    private static String safeCacheFileName(String cacheKey) {
        return cacheKey.replaceAll("[^a-zA-Z0-9._-]", "_");
    }
}
