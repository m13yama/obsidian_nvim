/** Routes an Obsidian scope event to the editor that actually owns its target. */
export class EditorKeyRouter {
  private handlers = new Map<EventTarget, (event: KeyboardEvent) => void>();

  register(element: HTMLElement, handler: (event: KeyboardEvent) => void): () => void {
    this.handlers.set(element, handler);
    return () => { if (this.handlers.get(element) === handler) this.handlers.delete(element); };
  }

  handle(event: KeyboardEvent): boolean {
    if (event.defaultPrevented) return false;
    for (const target of event.composedPath()) {
      const handler = this.handlers.get(target);
      if (handler) {
        handler(event);
        return event.defaultPrevented;
      }
    }
    return false;
  }
}
