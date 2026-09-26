export type Transcript = {
  sessionEpoch: number;
  draftEpoch: number;
  utteranceId: number;
  seq: number;
  text: string;
  final: boolean;
};

export class DraftCoordinator {
  sessionEpoch = 0;
  draftEpoch = 0;
  private lastUtterance = 0;
  private lastSeq = -1;
  private expected: string | undefined;
  private provisional = "";
  private dirty = false;
  candidate = "";
  recognizing = false;

  private readonly editor: {
    getEditorText(): string;
    setEditorText(text: string): void;
  };

  constructor(editor: {
    getEditorText(): string;
    setEditorText(text: string): void;
  }) {
    this.editor = editor;
  }

  resetSession(): void {
    this.sessionEpoch++;
    this.resetDraft();
  }

  resetDraft(): void {
    this.draftEpoch++;
    this.lastUtterance = 0;
    this.lastSeq = -1;
    this.expected = undefined;
    this.provisional = "";
    this.dirty = false;
    this.candidate = "";
    this.recognizing = false;
  }

  manualInput(): void {
    if (this.recognizing) this.dirty = true;
    if (this.provisional) {
      this.expected = undefined;
      this.provisional = "";
    }
  }

  beginUtterance(id: number): void {
    if (id <= this.lastUtterance) return;
    this.lastUtterance = id;
    this.lastSeq = -1;
    this.expected = this.editor.getEditorText();
    this.provisional = "";
    this.dirty = false;
    this.recognizing = true;
  }

  recognitionFailed(): void {
    this.recognizing = false;
  }

  apply(message: Transcript): "written" | "candidate" | "stale" {
    if (
      message.sessionEpoch !== this.sessionEpoch ||
      message.draftEpoch !== this.draftEpoch ||
      message.utteranceId < this.lastUtterance ||
      (message.utteranceId === this.lastUtterance &&
        message.seq <= this.lastSeq)
    )
      return "stale";
    if (message.utteranceId > this.lastUtterance) {
      this.lastUtterance = message.utteranceId;
      this.lastSeq = -1;
      this.expected = undefined;
      this.provisional = "";
      this.dirty = false;
    }
    this.lastSeq = message.seq;
    this.recognizing = !message.final;
    const text = message.text.trim();
    if (!text) return "stale";
    const current = this.editor.getEditorText();
    if (this.expected !== undefined && current !== this.expected) {
      this.expected = undefined;
      this.provisional = "";
      this.dirty = true;
    }
    if (this.dirty) {
      this.candidate = text;
      return "candidate";
    }
    const base = this.provisional
      ? current.slice(0, -this.provisional.length)
      : current;
    const separator = base && !/\s$/.test(base) ? " " : "";
    const next = base + separator + text;
    this.editor.setEditorText(next);
    this.expected = next;
    this.provisional = separator + text;
    if (message.final) {
      this.expected = undefined;
      this.provisional = "";
    }
    return "written";
  }
}
