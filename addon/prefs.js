pref("enable", true);
// OpenAI-compatible API settings
pref("baseURL", "https://api.openai.com/v1");
pref("apiKey", "");
pref("model", "gpt-4o-mini");
pref("temperature", 0.7);
// 0 means "not limited"
pref("maxTokens", 0);
// Context settings
pref("includeFullText", true);
// Max characters of full text sent as context; 0 means "not limited"
pref("fullTextLimit", 80000);
// Model context-window size used by the provider-neutral local estimate
pref("contextWindowTokens", 128000);
// Custom system prompt; empty means using the built-in default
pref("systemPrompt", "");
// Custom quick prompts, JSON array of { label, prompt }; empty means built-in defaults
pref("quickPrompts", "");
