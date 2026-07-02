package com.github.claudecodegui.util;

import org.junit.Test;

import java.nio.file.Paths;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

public class PathUtilsNormalizeAbsoluteTest {

    @Test
    public void collapsesTrailingDotDot() {
        String base = Paths.get(System.getProperty("java.io.tmpdir")).toAbsolutePath().toString();
        String input = base + java.io.File.separator + "a" + java.io.File.separator + "b"
                + java.io.File.separator + "..";
        String expected = Paths.get(base, "a").toString();

        assertEquals(expected, PathUtils.normalizeAbsolute(input));
    }

    @Test
    public void nullReturnsNull() {
        assertNull(PathUtils.normalizeAbsolute(null));
    }

    @Test
    public void blankReturnsBlankUnchanged() {
        assertEquals("", PathUtils.normalizeAbsolute(""));
    }
}
