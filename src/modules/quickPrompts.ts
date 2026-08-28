import { getPref } from "../utils/prefs";

export interface QuickPrompt {
  label: string;
  /** Template; `$text` is replaced by the selected text or item context */
  prompt: string;
  /** Whether the prompt is aimed at the selected text (else whole item) */
  forSelection?: boolean;
}

/**
 * Quick prompts shown as one-click buttons in the chat panel.
 * Users can override/extend them via the "quickPrompts" preference
 * (JSON array of { label, prompt, forSelection? }).
 */
export function getQuickPrompts(): QuickPrompt[] {
  const custom = getPref("quickPrompts");
  if (custom) {
    try {
      const parsed = JSON.parse(custom);
      if (Array.isArray(parsed) && parsed.length) {
        return parsed;
      }
    } catch (e) {
      ztoolkit.log("Zotero AI: invalid quickPrompts pref", e);
    }
  }
  return [
    {
      label: "Summarize",
      prompt:
        "Summarize this paper: its research question, methods, key findings, and limitations. Be concise.",
    },
    {
      label: "Key points",
      prompt:
        "List the key points and contributions of this paper as a short bullet list.",
    },
    {
      label: "Methods analysis",
      prompt:
        "Analyze the methodology of this paper: design, data, analytical techniques, and potential methodological weaknesses.",
    },
    {
      label: "Explain selection",
      prompt:
        "Explain the following passage from an academic paper in plain language:\n\n$text",
      forSelection: true,
    },
    {
      label: "Translate",
      prompt:
        "Translate the following academic text into Chinese. Keep terminology accurate and preserve the paragraph structure:\n\n$text",
      forSelection: true,
    },
  ];
}
