/**
 * Deliberately empty.
 *
 * A global mousemove listener used to move the key scope to whichever pane the pointer was over.
 * See hoverScope.ts for why that is gone. The hook stays so that App keeps one obvious place to
 * look, and so nobody adds the listener back without reading the reason it went.
 */
export function useHoverScope(): void {}
