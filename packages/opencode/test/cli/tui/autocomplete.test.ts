import { describe, expect, test } from "bun:test"
import {
  shouldClearSlashCommand,
  calculateScrollDelta,
} from "../../../src/cli/cmd/tui/component/prompt/autocomplete-util"

describe("shouldClearSlashCommand", () => {
  describe("slash command mode", () => {
    test("clears partial command without arguments", () => {
      expect(shouldClearSlashCommand("/", "/gc")).toBe(true)
      expect(shouldClearSlashCommand("/", "/help")).toBe(true)
      expect(shouldClearSlashCommand("/", "/gcd:plan-phase")).toBe(true)
    })

    test("does not clear command with single argument", () => {
      expect(shouldClearSlashCommand("/", "/help topic")).toBe(false)
      expect(shouldClearSlashCommand("/", "/gcd:plan-phase 2")).toBe(false)
      expect(shouldClearSlashCommand("/", "/run test")).toBe(false)
    })

    test("does not clear command with multiple arguments", () => {
      expect(shouldClearSlashCommand("/", "/cmd arg1 arg2")).toBe(false)
      expect(shouldClearSlashCommand("/", "/cmd arg1 arg2 arg3")).toBe(false)
      expect(shouldClearSlashCommand("/", "/gcd:plan-phase 2 extra")).toBe(false)
    })

    test("does not clear command with trailing space (selected from autocomplete)", () => {
      expect(shouldClearSlashCommand("/", "/help ")).toBe(false)
      expect(shouldClearSlashCommand("/", "/gcd:plan-phase ")).toBe(false)
    })

    test("does not clear text that doesn't start with /", () => {
      expect(shouldClearSlashCommand("/", "hello")).toBe(false)
      expect(shouldClearSlashCommand("/", "")).toBe(false)
      expect(shouldClearSlashCommand("/", "gc")).toBe(false)
    })

    test("clears just the slash character", () => {
      expect(shouldClearSlashCommand("/", "/")).toBe(true)
    })
  })

  describe("mention mode (@)", () => {
    test("never clears in mention mode", () => {
      expect(shouldClearSlashCommand("@", "/help")).toBe(false)
      expect(shouldClearSlashCommand("@", "/gc")).toBe(false)
      expect(shouldClearSlashCommand("@", "@file")).toBe(false)
    })
  })

  describe("hidden mode (false)", () => {
    test("never clears when autocomplete is hidden", () => {
      expect(shouldClearSlashCommand(false, "/help")).toBe(false)
      expect(shouldClearSlashCommand(false, "/gc")).toBe(false)
      expect(shouldClearSlashCommand(false, "anything")).toBe(false)
    })
  })

  describe("pasted command scenarios", () => {
    test("preserves pasted command with arguments (the main bug fix)", () => {
      // This was the original bug: pasting "/gcd:plan-phase 2" would get deleted
      expect(shouldClearSlashCommand("/", "/gcd:plan-phase 2")).toBe(false)
    })

    test("preserves pasted command with complex arguments", () => {
      expect(shouldClearSlashCommand("/", "/search query with spaces")).toBe(false)
      expect(shouldClearSlashCommand("/", "/run npm install --save")).toBe(false)
      expect(shouldClearSlashCommand("/", "/edit file.ts line 42")).toBe(false)
    })

    test("preserves command even with multiple spaces", () => {
      expect(shouldClearSlashCommand("/", "/cmd  double-space")).toBe(false)
      expect(shouldClearSlashCommand("/", "/cmd   triple")).toBe(false)
    })
  })

  describe("edge cases", () => {
    test("handles empty string", () => {
      expect(shouldClearSlashCommand("/", "")).toBe(false)
    })

    test("handles whitespace only", () => {
      expect(shouldClearSlashCommand("/", " ")).toBe(false)
      expect(shouldClearSlashCommand("/", "  ")).toBe(false)
    })

    test("handles slash with only whitespace", () => {
      // "/ " means user typed / then space - has space so don't clear
      expect(shouldClearSlashCommand("/", "/ ")).toBe(false)
    })

    test("handles commands with special characters", () => {
      expect(shouldClearSlashCommand("/", "/gcd:plan-phase")).toBe(true) // no args
      expect(shouldClearSlashCommand("/", "/gcd:plan-phase 2")).toBe(false) // with args
      expect(shouldClearSlashCommand("/", "/some_command")).toBe(true) // no args
      expect(shouldClearSlashCommand("/", "/some_command arg")).toBe(false) // with args
    })

    test("handles newlines in arguments", () => {
      expect(shouldClearSlashCommand("/", "/cmd arg1\narg2")).toBe(false)
    })

    test("handles tabs as whitespace", () => {
      expect(shouldClearSlashCommand("/", "/cmd\targ")).toBe(false)
    })
  })
})

describe("calculateScrollDelta", () => {
  // viewport: height=10, scrollY=0 means items 0-9 are visible
  const viewport = 10

  describe("item visible in viewport", () => {
    test("returns no scroll when item is at top of viewport", () => {
      expect(calculateScrollDelta(0, 0, viewport, true)).toEqual({ delta: 0, toTop: false })
    })

    test("returns no scroll when item is in middle of viewport", () => {
      expect(calculateScrollDelta(5, 0, viewport, false)).toEqual({ delta: 0, toTop: false })
    })

    test("returns no scroll when item is at bottom edge of viewport", () => {
      expect(calculateScrollDelta(9, 0, viewport, false)).toEqual({ delta: 0, toTop: false })
    })
  })

  describe("item below viewport", () => {
    test("scrolls down when item is just below viewport", () => {
      // item at y=10, viewport shows 0-9, need to scroll down 1
      expect(calculateScrollDelta(10, 0, viewport, false)).toEqual({ delta: 1, toTop: false })
    })

    test("scrolls down when item is far below viewport", () => {
      // item at y=20, viewport shows 0-9, need to scroll down 11
      expect(calculateScrollDelta(20, 0, viewport, false)).toEqual({ delta: 11, toTop: false })
    })

    test("scrolls down correctly when already scrolled", () => {
      // scrollY=5, viewport shows 5-14, item at y=20, need to scroll down 6
      expect(calculateScrollDelta(20, 5, viewport, false)).toEqual({ delta: 6, toTop: false })
    })
  })

  describe("item above viewport", () => {
    test("scrolls up when item is just above viewport", () => {
      // scrollY=10, viewport shows 10-19, item at y=9, need to scroll up 1
      expect(calculateScrollDelta(9, 10, viewport, false)).toEqual({ delta: -1, toTop: false })
    })

    test("scrolls up when item is far above viewport", () => {
      // scrollY=20, viewport shows 20-29, item at y=5, need to scroll up 15
      expect(calculateScrollDelta(5, 20, viewport, false)).toEqual({ delta: -15, toTop: false })
    })

    test("scrolls to top when navigating to first item", () => {
      // scrollY=10, item at y=0, isFirst=true, should scroll to top
      expect(calculateScrollDelta(0, 10, viewport, true)).toEqual({ delta: -10, toTop: true })
    })

    test("does not scroll to top for non-first items", () => {
      // scrollY=10, item at y=5, isFirst=false, just scroll up normally
      expect(calculateScrollDelta(5, 10, viewport, false)).toEqual({ delta: -5, toTop: false })
    })
  })

  describe("edge cases", () => {
    test("handles viewport height of 1", () => {
      expect(calculateScrollDelta(5, 0, 1, false)).toEqual({ delta: 5, toTop: false })
      expect(calculateScrollDelta(0, 5, 1, true)).toEqual({ delta: -5, toTop: true })
    })

    test("handles large scroll positions", () => {
      expect(calculateScrollDelta(1000, 500, viewport, false)).toEqual({ delta: 491, toTop: false })
      expect(calculateScrollDelta(100, 500, viewport, false)).toEqual({ delta: -400, toTop: false })
    })
  })
})
