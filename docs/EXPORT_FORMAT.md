# Export formats — Chat Toolkit 1.7.0

All formats contain every message on the conversation's selected branch with the reasoning, tool calls, tool results, created files, sources, and attachment metadata the provider supplied. Only repetition is removed:

- A tool output of 200+ characters identical to an earlier one becomes `[Same output as an earlier tool result.]`.
- A source whose URL already appears in the exported messages is not listed again in the Sources appendix or `context.references`.
- Site icon URLs are never treated as sources.

Scope **User** or **Assistant** keeps only that role and omits the conversation-wide appendix. File names: `<platform>_<title>_<YYYY-MM-DD>[_user_turns|_assistant_turns].<md|json|html>`.

## Markdown (`.md`)

```text
# <title>
_Exported from <platform> on <ISO time>._
## User | ## Assistant | ## Assistant · Reasoning | ## Assistant · Tool Call | ## Tool · Result
<think>…</think>                        reasoning, when supplied
### <tool or artifact title>              followed by a fenced block
## Export Context                         resources, attachments, tools, search queries, sources
```

Fences are longer than any backtick run inside the block. Blank lines inside code are preserved; runs of blank lines in prose collapse to one. Emoji and symbols are kept. Role exports use `## User 1`, `## User 2`, ….

## JSON (`.json`, `export_version: 5`)

One top-level field per line and one message per line, with no indentation.

| Field | Meaning |
| --- | --- |
| `export_kind` | `full_conversation_history`, `user_turns`, or `assistant_turns` (`scope` is present for the last two) |
| `platform`, `exported_at`, `source` | `source` is `api`, `dom` (loaded page), `indexeddb`, `grok_api`, or `cowork_api` |
| `id`, `title`, `model`, `created_at`, `updated_at` | Conversation metadata when supplied |
| `context` | `resources` (non-zero only), `tools` (`total`, `calls`, `results`, `names`, `by_name`), `attachments`, `search_queries`, `references` |
| `source_message_count`, `message_count`, `by_channel` | Counts; `mapping_message_count` appears only when it differs |
| `omitted` | Non-zero counts only: `by_role`, `inactive_branch`, `empty`, `other_roles` |
| `repeated_tool_outputs` | Present when repeats were replaced |
| `messages[]` | `source_index`, `role`, `channel` (absent = ordinary message; otherwise `reasoning`, `tool_call`, `tool_result`, or for OpenRouter `reasoning_and_final`), `name`, `model`, `recipient`, `content_type`, `hidden_in_ui`, `content`, `thinking` (OpenRouter: `reasoning`), `blocks[]` of `{kind, id, tool, title, language, content}` for tool calls, tool results, artifacts, and attachments |

Empty values and zero counts are omitted. Grok messages also keep their non-duplicated API fields (for example `sources`, `search_queries`, `attachments`, `metadata`, `partial`); raw fields whose content is already in `thinking`, `blocks`, or `sources` are dropped. Version 5 changed from version 4: no pretty-printing, no `limits` block, zero counts and default channel omitted, Claude messages gained `thinking` and `blocks`, reasoning is not repeated as `thinking` on ChatGPT reasoning rows.

## HTML (`.html`)

A single offline page: `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src data:`, `referrer: no-referrer`, all provider text escaped, only `http(s)` links (with `rel="noopener noreferrer"`), and a collapsible appendix.

## Copy

Markdown copies write Markdown as text and rendered HTML for rich paste. JSON and HTML copies write the file's text.

## Diagnostic capture (`.capture.json`)

Pretty-printed diagnostic bundle (`manifest_version: 3`, `export_kind: bounded_chat_capture`): the JSON export above, page summary, bounded network summary, deep-research summary, and, for Account capture, a `session_bundle`.
