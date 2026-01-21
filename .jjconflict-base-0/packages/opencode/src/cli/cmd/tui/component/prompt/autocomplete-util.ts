/**
 * Determines whether the slash command text should be cleared when hiding the autocomplete.
 *
 * The text should only be cleared when the user abandons a partial slash command
 * (e.g., types "/gc" then moves cursor elsewhere without selecting).
 *
 * The text should NOT be cleared when:
 * - The text contains arguments (has whitespace) - e.g., "/gcd:plan-phase 2"
 * - The text was pasted with a complete command and arguments
 *
 * @param visible - The current autocomplete mode ("/" for slash commands, "@" for mentions, false if hidden)
 * @param text - The current input text
 * @returns true if the text should be cleared, false otherwise
 */
export function shouldClearSlashCommand(visible: "/" | "@" | false, text: string): boolean {
  // Only consider clearing for slash command mode
  if (visible !== "/") return false

  // Text must start with /
  if (!text.startsWith("/")) return false

  // If text contains whitespace, it has arguments - don't clear
  // This handles pasted commands like "/gcd:plan-phase 2"
  if (/\s/.test(text)) return false

  // Clear partial commands without arguments (e.g., "/gc" abandoned)
  return true
}

/**
 * Calculates the scroll delta needed to keep a target item visible in a scrollable container.
 *
 * @param targetY - The Y position of the target element relative to the scroll container's content
 * @param scrollY - The current scroll position (top of visible area)
 * @param viewportHeight - The height of the visible viewport
 * @param isFirst - Whether this is the first item (index 0)
 * @returns Object with scrollDelta (amount to scroll) and scrollToTop (whether to reset to top)
 */
export function calculateScrollDelta(
  targetY: number,
  scrollY: number,
  viewportHeight: number,
  isFirst: boolean,
): { delta: number; toTop: boolean } {
  const relativeY = targetY - scrollY

  // Item is below the visible area
  if (relativeY >= viewportHeight) return { delta: relativeY - viewportHeight + 1, toTop: false }

  // Item is above the visible area
  if (relativeY < 0) return { delta: relativeY, toTop: isFirst }

  // Item is already visible
  return { delta: 0, toTop: false }
}
