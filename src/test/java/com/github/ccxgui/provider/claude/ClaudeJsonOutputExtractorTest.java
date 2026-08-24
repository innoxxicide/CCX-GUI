package com.github.ccxgui.provider.claude;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

/**
 * The bridge writes its JSON result to stdout while logging diagnostics that carry
 * raw Windows paths. These cover what the extractor must do when the two ever end up
 * in the same byte stream.
 */
public class ClaudeJsonOutputExtractorTest {

    private static final String DIAGNOSTIC =
            "[2026-08-24T09:09:17.731Z][PERM_DEBUG][INIT] Permission dir: C:\\Users\\dev\\AppData\\Local\\Temp";

    private final ClaudeJsonOutputExtractor extractor = new ClaudeJsonOutputExtractor();

    @Test
    public void returnsThePayloadLineWhenDiagnosticsSurroundIt() {
        String payload = "{\"success\":true,\"messages\":[{\"toolUseResult\":{\"stdout\":\"ok\"}}]}";
        String output = DIAGNOSTIC + "\n"
                + "[DIAG-EXEC] Dispatching to handler: claude\n"
                + payload + "\n"
                + "[DIAG-EXEC] Handler completed successfully\n";

        assertEquals(payload, extractor.extractLastJsonLine(output));
    }

    @Test
    public void rejectsAPayloadLineADiagnosticWasWrittenInto() {
        // Reproduces the reported failure: a diagnostic write lands inside the payload
        // line, so `C:\Users` reads as the invalid JSON escape `\U`. Returning null lets
        // the caller retry; returning the blob made Gson report "Invalid escape sequence"
        // against a JSON path deep inside the session history.
        String spliced = "{\"success\":true,\"messages\":[{\"toolUseResult\":{\"stdout\":\"aaa"
                + DIAGNOSTIC + "\nbbb\"}}]}";

        assertNull(extractor.extractLastJsonLine(spliced));
    }

    @Test
    public void rejectsTruncatedOutput() {
        String truncated = DIAGNOSTIC + "\n{\"success\":true,\"messages\":[{\"toolUseResult\":{\"stdout\":\"aaa";

        assertNull(extractor.extractLastJsonLine(truncated));
    }

    @Test
    public void acceptsAPrettyPrintedPayloadSpanningLines() {
        String output = "{\n  \"success\": true,\n  \"messages\": []\n}";

        assertEquals(output, extractor.extractLastJsonLine(output));
    }

    @Test
    public void returnsNullWhenThereIsNoJsonAtAll() {
        assertNull(extractor.extractLastJsonLine(DIAGNOSTIC + "\n[DIAG-EXEC] done\n"));
    }
}
